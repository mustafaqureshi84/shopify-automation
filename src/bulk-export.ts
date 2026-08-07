import {
  submit,
  pollUntilDone,
  getCurrentOperation,
  cancelOperation,
  streamLines,
  groupByParent,
} from './bulk.js';
import { handleFatal } from './exit.js';
import { limiter } from './shopify.js';

/**
 * Note the absence of `first:` on the nested variants connection.
 * Bulk queries return every node — nested truncation doesn't exist here.
 */
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

async function main(): Promise<void> {
  // Only one bulk operation runs per app per store. Clear any stale one.
  const existing = await getCurrentOperation();

  if (existing && (existing.status === 'RUNNING' || existing.status === 'CREATED')) {
    console.log(`Cancelling in-flight operation ${existing.id}...`);
    await cancelOperation(existing.id);
  }

  console.log('Submitting bulk query...');
  const submitted = await submit(BULK_QUERY);
  console.log(`Operation ${submitted.id} — status ${submitted.status}\n`);

  console.time('bulk');

  const completed = await pollUntilDone({
    onTick: (op, elapsed) => {
      console.log(
        `  ${(elapsed / 1000).toFixed(1)}s — ${op.status}, ` +
          `${op.objectCount} objects`
      );
    },
  });

  console.timeEnd('bulk');

  console.log(`\nObjects: ${completed.objectCount}`);
  console.log(`File size: ${completed.fileSize ?? 'unknown'} bytes`);

  if (!completed.url) {
    console.log('No result URL — the query matched nothing.');
    return;
  }

  console.log('\nStreaming results...\n');
  console.time('parse');

  const byStatus = new Map<string, number>();
  let products = 0;
  let variants = 0;
  let maxVariants = 0;
  let totalInventory = 0;
  let untracked = 0;

  for await (const group of groupByParent(streamLines(completed.url))) {
    products += 1;
    variants += group.children.length;
    maxVariants = Math.max(maxVariants, group.children.length);

    const status = asString(group.parent.status) ?? 'UNKNOWN';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    const inventory = asNumber(group.parent.totalInventory);
    if (inventory === null) untracked += 1;
    else totalInventory += inventory;
  }

  console.timeEnd('parse');

  console.log(`\nTotal products: ${products}`);
  for (const [status, count] of [...byStatus].sort()) {
    console.log(`  ${status}: ${count}`);
  }
  console.log(`Total variants: ${variants}`);
  console.log(`Most variants on one product: ${maxVariants}`);
  console.log(`Total tracked inventory: ${totalInventory}`);
  console.log(`Products with no inventory tracking: ${untracked}`);

  console.log('\nLimiter:', limiter.snapshot());
  console.log(
    '\nCompare these totals against: npx tsx src/export-products.ts'
  );
}

main().catch(handleFatal);