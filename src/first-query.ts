import 'dotenv/config';

const SHOP = process.env.SHOP_DOMAIN!;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!;
const API_VERSION = '2026-07';

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

interface ProductNode {
  id: string;
  title: string;
  variants: {
    edges: Array<{
      node: { sku: string | null; inventoryQuantity: number | null };
    }>;
  };
}

interface ProductsResponse {
  data?: {
    products: {
      edges: Array<{ node: ProductNode }>;
    };
  };
  errors?: unknown;
}

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

  const data = (await res.json()) as TokenResponse;
  return data.access_token;
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

  const json = (await res.json()) as ProductsResponse;

  if (json.errors || !json.data) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    return;
  }

  for (const { node } of json.data.products.edges) {
    console.log(`${node.title} — ${node.variants.edges.length} variants`);
  }
}

main().catch(console.error);