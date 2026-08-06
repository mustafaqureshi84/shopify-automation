import { getConfig } from './config.js';
import { TokenResponseSchema, ProductsResponseSchema } from './types.js';
import { ConfigError, ShopifyAuthError, ShopifyApiError } from './errors.js';

async function summarizeErrorBody(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? '';
  const requestId = res.headers.get('x-request-id');
  const raw = await res.text();

  let detail: string;

  if (contentType.includes('application/json')) {
    detail = raw.slice(0, 500);
  } else {
    detail = raw
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  return requestId ? `${detail}\n(request id: ${requestId})` : detail;
}

async function getAccessToken(): Promise<string> {
  const { shop, clientId, clientSecret } = getConfig();

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new ShopifyAuthError(
      `Token request failed with status ${res.status}`,
      res.status,
      await summarizeErrorBody(res)
    );
  }

  const parsed = TokenResponseSchema.safeParse(await res.json());

  if (!parsed.success) {
    throw new ShopifyApiError(
      'Token response did not match expected shape',
      parsed.error.issues
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
  const { shop, apiVersion } = getConfig();
  const token = await getAccessToken();
  console.log('Access token acquired');

  const res = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query: QUERY }),
    }
  );

  if (!res.ok) {
    throw new ShopifyApiError(
      `Admin API request failed with status ${res.status}`,
      await summarizeErrorBody(res)
    );
  }

  const parsed = ProductsResponseSchema.safeParse(await res.json());

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
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(78);
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