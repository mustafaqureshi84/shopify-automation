import { paginate } from './paginate.js';
import { ProductsPageSchema } from './types.js';
import type { ProductListItem } from './types.js';
import type { Connection } from './paginate.js';
import { ShopifyApiError } from './errors.js';
import { handleFatal } from './exit.js';

const PRODUCTS_QUERY = `
  query AllProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        totalInventory
        variantsCount { count }
      }
    }
  }
`;

function extractProducts(body: unknown): Connection<ProductListItem> {
  const parsed = ProductsPageSchema.safeParse(body);

  if (!parsed.success) {
    throw new ShopifyApiError(
      'Product page did not match expected shape',
      parsed.error.issues
    );
  }

  if (parsed.data.errors) {
    throw new ShopifyApiError('GraphQL returned errors', parsed.data.errors);
  }

  if (!parsed.data.data) {
    throw new ShopifyApiError('Response contained no data', parsed.data);
  }

  return parsed.data.data.products;
}

async function main(): Promise<void> {
  const pageSize = Number(process.env.PAGE_SIZE ?? 2);

  const byStatus = new Map<string, number>();
  let total = 0;
  let totalInventory = 0;
  let untracked = 0;

  console.time('export');

  for await (const page of paginate(PRODUCTS_QUERY, extractProducts, {
    pageSize,
  })) {
    for (const product of page.items) {
      total += 1;
      byStatus.set(product.status, (byStatus.get(product.status) ?? 0) + 1);

      if (product.totalInventory === null) {
        untracked += 1;
      } else {
        totalInventory += product.totalInventory;
      }
    }

    const bucket = page.cost
      ? `${page.cost.currentlyAvailable}/${page.cost.maximumAvailable}`
      : 'unknown';

    console.log(
      `page ${page.pageNumber}: ${page.items.length} products — throttle ${bucket}`
    );
  }

  console.timeEnd('export');

  console.log(`\nTotal products: ${total}`);
  for (const [status, count] of [...byStatus].sort()) {
    console.log(`  ${status}: ${count}`);
  }
  console.log(`Total tracked inventory: ${totalInventory}`);
  console.log(`Products with no inventory tracking: ${untracked}`);
}

main().catch(handleFatal);