import { shopifyGraphQL } from './shopify.js';
import { ProductsResponseSchema } from './types.js';
import { ShopifyApiError } from './errors.js';
import { handleFatal } from './exit.js';

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

main().catch(handleFatal);