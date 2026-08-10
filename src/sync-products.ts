import {
  submit,
  pollUntilDone,
  getCurrentOperation,
  cancelOperation,
  streamLines,
  groupByParent,
} from './bulk.js';
import { getConfig } from './config.js';
import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';
import { limiter } from './shopify.js';
import { Prisma } from './generated/prisma/client.js';

const BULK_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        handle
        status
        totalInventory
        variants {
          edges {
            node {
              id
              sku
              price
              inventoryItem { id }
            }
          }
        }
      }
    }
  }
}
`;

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Shopify returns price as a string; Decimal wants one too. */
function asDecimalString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return null;
}

function nestedId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

interface ProductRow {
  gid: string;
  shopDomain: string;
  handle: string;
  title: string;
  status: string;
  totalInventory: number | null;
  lastSeenAt: Date;
}

interface VariantRow {
  gid: string;
  productGid: string;
  shopDomain: string;
  sku: string | null;
  price: string | null;
  inventoryItemId: string | null;
  lastSeenAt: Date;
}

/**
 * One INSERT ... ON CONFLICT statement per batch instead of one upsert per
 * row. 500 individual upserts is 500 sequential round trips — roughly six
 * seconds against a remote database, which exceeds Prisma's transaction
 * timeout. Batched, it is a single query.
 */
async function upsertProducts(rows: ProductRow[]): Promise<void> {
  if (rows.length === 0) return;

  const values = rows.map(
    (r) =>
      Prisma.sql`(${r.gid}, ${r.shopDomain}, ${r.handle}, ${r.title}, ${r.status}, ${r.totalInventory}, ${r.lastSeenAt}, NOW(), NOW())`
  );

  await prisma.$executeRaw`
    INSERT INTO "Product"
      ("gid", "shopDomain", "handle", "title", "status", "totalInventory",
       "lastSeenAt", "createdAt", "updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("gid") DO UPDATE SET
      "handle"         = EXCLUDED."handle",
      "title"          = EXCLUDED."title",
      "status"         = EXCLUDED."status",
      "totalInventory" = EXCLUDED."totalInventory",
      "lastSeenAt"     = EXCLUDED."lastSeenAt",
      "deletedAt"      = NULL,
      "updatedAt"      = NOW()
  `;
}

async function upsertVariants(rows: VariantRow[]): Promise<void> {
  if (rows.length === 0) return;

  const values = rows.map(
    (r) =>
      Prisma.sql`(${r.gid}, ${r.productGid}, ${r.shopDomain}, ${r.sku}, ${r.price}::decimal, ${r.inventoryItemId}, ${r.lastSeenAt}, NOW(), NOW())`
  );

  await prisma.$executeRaw`
    INSERT INTO "Variant"
      ("gid", "productGid", "shopDomain", "sku", "price", "inventoryItemId",
       "lastSeenAt", "createdAt", "updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("gid") DO UPDATE SET
      "productGid"      = EXCLUDED."productGid",
      "sku"             = EXCLUDED."sku",
      "price"           = EXCLUDED."price",
      "inventoryItemId" = EXCLUDED."inventoryItemId",
      "lastSeenAt"      = EXCLUDED."lastSeenAt",
      "deletedAt"       = NULL,
      "updatedAt"       = NOW()
  `;
}

async function main(): Promise<void> {
  const { shop } = getConfig();
  const runStartedAt = new Date();

  const run = await prisma.syncRun.create({
    data: { shopDomain: shop, startedAt: runStartedAt },
  });

  console.log(`Sync run ${run.id}\n`);

  try {
    const existing = await getCurrentOperation();

    if (
      existing &&
      (existing.status === 'RUNNING' || existing.status === 'CREATED')
    ) {
      console.log(`Cancelling in-flight operation ${existing.id}...`);
      await cancelOperation(existing.id);
    }

    console.log('Submitting bulk query...');
    await submit(BULK_QUERY);

    const completed = await pollUntilDone({
      onTick: (op, elapsed) => {
        console.log(
          `  ${(elapsed / 1000).toFixed(1)}s — ${op.status}, ${op.objectCount} objects`
        );
      },
    });

    if (!completed.url) {
      throw new Error('Bulk operation completed with no result URL');
    }

    console.log('\nStreaming and writing...\n');
    console.time('sync');

    // Snapshot what we already hold, so change detection compares against
    // the previous state rather than re-reading per row.
    const before = await prisma.product.findMany({
      where: { shopDomain: shop },
      select: {
        gid: true,
        title: true,
        handle: true,
        status: true,
        totalInventory: true,
        deletedAt: true,
      },
    });

    const previous = new Map(before.map((p) => [p.gid, p]));

    let seen = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let variantsSeen = 0;

    let productBatch: ProductRow[] = [];
    let variantBatch: VariantRow[] = [];
    const BATCH_SIZE = 500;

    async function flush(): Promise<void> {
      // Products first — the foreign key from Variant requires the parent.
      await upsertProducts(productBatch);
      await upsertVariants(variantBatch);
      productBatch = [];
      variantBatch = [];
    }

    for await (const group of groupByParent(streamLines(completed.url))) {
      const gid = group.parent.id;
      const title = asString(group.parent.title) ?? '';
      const handle = asString(group.parent.handle) ?? '';
      const status = asString(group.parent.status) ?? 'UNKNOWN';
      const totalInventory = asNumber(group.parent.totalInventory);

      seen += 1;

      const prior = previous.get(gid);

      if (!prior) {
        created += 1;
      } else if (
        prior.title !== title ||
        prior.handle !== handle ||
        prior.status !== status ||
        prior.totalInventory !== totalInventory ||
        prior.deletedAt !== null
      ) {
        updated += 1;
      } else {
        unchanged += 1;
      }

      productBatch.push({
        gid,
        shopDomain: shop,
        handle,
        title,
        status,
        totalInventory,
        lastSeenAt: runStartedAt,
      });

      for (const child of group.children) {
        variantsSeen += 1;
        variantBatch.push({
          gid: child.id,
          productGid: gid,
          shopDomain: shop,
          sku: asString(child.sku),
          price: asDecimalString(child.price),
          inventoryItemId: nestedId(child.inventoryItem),
          lastSeenAt: runStartedAt,
        });
      }

      if (productBatch.length >= BATCH_SIZE) {
        await flush();
        console.log(`  ${seen} products written...`);
      }
    }

    await flush();

    // Deletion detection: anything not stamped by this run wasn't in the
    // snapshot. Shopify sends no event for a deleted product — absence is
    // the only signal there is.
    const deletedProducts = await prisma.product.updateMany({
      where: {
        shopDomain: shop,
        lastSeenAt: { lt: runStartedAt },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });

    const deletedVariants = await prisma.variant.updateMany({
      where: {
        shopDomain: shop,
        lastSeenAt: { lt: runStartedAt },
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });

    console.timeEnd('sync');

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'completed',
        productsSeen: seen,
        productsCreated: created,
        productsUpdated: updated,
        productsUnchanged: unchanged,
        productsDeleted: deletedProducts.count,
        variantsSeen,
      },
    });

    console.log(`\nProducts seen:      ${seen}`);
    console.log(`  created:          ${created}`);
    console.log(`  updated:          ${updated}`);
    console.log(`  unchanged:        ${unchanged}`);
    console.log(`  newly deleted:    ${deletedProducts.count}`);
    console.log(`Variants seen:      ${variantsSeen}`);
    console.log(`Variants deleted:   ${deletedVariants.count}`);
    console.log('\nLimiter:', limiter.snapshot());
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  } finally {
    await disconnect();
  }
}

main().catch(handleFatal);