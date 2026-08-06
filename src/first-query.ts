import { shopifyGraphQL } from './shopify.js';
import { ProductsResponseSchema } from './types.js';
import { ConfigError, ShopifyAuthError, ShopifyApiError } from './errors.js';
import { RetryExhaustedError } from './retry.js';

const QUERY = `
  query FirstProducts {
    products(first: 10) {
      edges {
        node {
          id
          title
          variants(first: 5) {
            edges { node { sku inventoryQuantity } }
          }
        }
      }
    }
  }
`;

async function main(): Promise<void> {
  const { body, cost } = await shopifyGraphQL(QUERY);
  const parsed = ProductsResponseSchema.safeParse(body);

  if (!parsed.success) {
    throw new ShopifyApiError(
      'Response did not match expected shape',
      parsed.error.issues
    );
  }

  const json = parsed.data;

  if (json.errors) {
    throw new ShopifyApiError('GraphQL returned errors', json.errors);
  }

  if (!json.data) {
    throw new ShopifyApiError('Response contained no data', json);
  }

  for (const { node } of json.data.products.edges) {
    console.log(`${node.title} — ${node.variants.edges.length} variants`);
  }

  if (cost) {
    console.log(
      `\nThrottle: ${cost.currentlyAvailable}/${cost.maximumAvailable} ` +
        `(restores ${cost.restoreRate}/sec)`
    );
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(78);
  }

  if (err instanceof RetryExhaustedError) {
    console.error(`[retry] ${err.message}`);
    if (err.lastError instanceof Error) {
      console.error(`  last error: ${err.lastError.message}`);
    }
    process.exit(75);
  }

  if (err instanceof ShopifyAuthError) {
    console.error(`[auth] ${err.message}`);
    if (err.body) console.error(err.body);
    process.exit(err.isRetryable ? 75 : 77);
  }

  if (err instanceof ShopifyApiError) {
    console.error(`[api] ${err.message}`);
    if (err.detail !== undefined) {
      console.error(JSON.stringify(err.detail, null, 2));
    }
    process.exit(70);
  }

  if (err instanceof Error) {
    console.error(`[unexpected] ${err.name}: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }

  console.error('[unknown] Non-Error value thrown:', err);
  process.exit(1);
});