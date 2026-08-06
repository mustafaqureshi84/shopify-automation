import { SHOP, CLIENT_ID, CLIENT_SECRET, API_VERSION } from './config.js';
import { TokenResponseSchema, ProductsResponseSchema } from './types.js';

async function getAccessToken(): Promise<string> {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }

  const parsed = TokenResponseSchema.safeParse(await res.json());

  if (!parsed.success) {
    throw new Error(
      `Unexpected token response shape:\n${JSON.stringify(parsed.error.issues, null, 2)}`
    );
  }

  return parsed.data.access_token;
}

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
  const token = await getAccessToken();
  console.log('Access token acquired');

  const res = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query: QUERY }),
    }
  );

  const parsed = ProductsResponseSchema.safeParse(await res.json());

  if (!parsed.success) {
    console.error(
      'Response did not match expected shape:',
      JSON.stringify(parsed.error.issues, null, 2)
    );
    return;
  }

  const json = parsed.data;

  if (json.errors || !json.data) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    return;
  }

  for (const { node } of json.data.products.edges) {
    console.log(`${node.title} — ${node.variants.edges.length} variants`);
  }
}

main().catch(console.error);