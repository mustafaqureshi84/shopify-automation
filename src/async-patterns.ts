import { shopifyGraphQL, limiter } from './shopify.js';
import { ProductIdListSchema, ProductInventorySchema } from './types.js';
import { ShopifyApiError } from './errors.js';
import { handleFatal } from './exit.js';

const PRODUCT_IDS_QUERY = `
  query ProductIds {
    products(first: 20) {
      edges { node { id title } }
    }
  }
`;

const INVENTORY_QUERY = `
  query ProductInventory($id: ID!) {
    product(id: $id) {
      title
      variants(first: 10) {
        edges {
          node {
            sku
            inventoryItem {
              inventoryLevels(first: 10) {
                edges {
                  node {
                    location { name }
                    quantities(names: ["available"]) { name quantity }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface InventorySummary {
  id: string;
  title: string;
  totalAvailable: number;
}

async function fetchProductIds(): Promise<string[]> {
  const { body } = await shopifyGraphQL(PRODUCT_IDS_QUERY);
  const parsed = ProductIdListSchema.safeParse(body);

  if (!parsed.success || !parsed.data.data) {
    throw new ShopifyApiError('Could not read product list', body);
  }

  return parsed.data.data.products.edges.map((edge) => edge.node.id);
}

async function fetchInventory(id: string): Promise<InventorySummary> {
  const { body } = await shopifyGraphQL(INVENTORY_QUERY, { id });
  const parsed = ProductInventorySchema.safeParse(body);

  if (!parsed.success) {
    throw new ShopifyApiError(
      `Unexpected inventory shape for ${id}`,
      parsed.error.issues
    );
  }

  const product = parsed.data.data?.product;

  if (!product) {
    return { id, title: '(not found)', totalAvailable: 0 };
  }

  let totalAvailable = 0;

  for (const variantEdge of product.variants.edges) {
    const item = variantEdge.node.inventoryItem;
    if (!item) continue;

    for (const levelEdge of item.inventoryLevels.edges) {
      for (const q of levelEdge.node.quantities) {
        if (q.name === 'available') totalAvailable += q.quantity;
      }
    }
  }

  return { id, title: product.title, totalAvailable };
}

async function runSequential(ids: string[]): Promise<InventorySummary[]> {
  const results: InventorySummary[] = [];

  for (const id of ids) {
    results.push(await fetchInventory(id));
  }

  return results;
}

async function runParallel(ids: string[]): Promise<InventorySummary[]> {
  return Promise.all(ids.map((id) => fetchInventory(id)));
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function report(results: InventorySummary[]): void {
  const total = results.reduce((sum, r) => sum + r.totalAvailable, 0);
  const s = limiter.snapshot();

  console.log(`  ${results.length} products, ${total} units available`);
  console.log(
    `  bucket ${s.available}/${s.maximum}, ` +
      `est cost ${s.estimatedCost}, restore ${s.restoreRate}/s`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const ids = await fetchProductIds();
  console.log(`Fetched ${ids.length} product IDs\n`);

  console.log('1. Sequential');
  console.time('  sequential');
  report(await runSequential(ids));
  console.timeEnd('  sequential');

  await sleep(3000);

  console.log('\n2. Parallel (Promise.all, unbounded)');
  console.time('  parallel');
  report(await runParallel(ids));
  console.timeEnd('  parallel');

  await sleep(3000);

  console.log('\n3. Bounded (hardcoded limit 3)');
  console.time('  bounded-3');
  report(await mapWithConcurrency(ids, 3, fetchInventory));
  console.timeEnd('  bounded-3');

  await sleep(3000);

  const suggested = limiter.suggestedConcurrency();
  console.log(`\n4. Bounded (limiter-derived limit ${suggested})`);
  console.time('  bounded-adaptive');
  report(await mapWithConcurrency(ids, suggested, fetchInventory));
  console.timeEnd('  bounded-adaptive');

  console.log('\nFinal limiter state:', limiter.snapshot());
}

main().catch(handleFatal);