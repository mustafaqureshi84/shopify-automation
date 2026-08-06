import { getConfig } from './config.js';
import { ShopifyAuthError, ShopifyApiError } from './errors.js';
import { TokenResponseSchema, ThrottleEnvelopeSchema } from './types.js';
import type { ThrottleStatus } from './types.js';

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function summarizeErrorBody(res: Response): Promise<string> {
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

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

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

  const lifetimeSeconds = parsed.data.expires_in ?? 86_400;
  const safetyMarginSeconds = 300;

  cachedToken = {
    value: parsed.data.access_token,
    expiresAt: Date.now() + (lifetimeSeconds - safetyMarginSeconds) * 1000,
  };

  return cachedToken.value;
}

export interface GraphQLResult {
  body: unknown;
  cost: ThrottleStatus | null;
}

export async function shopifyGraphQL(
  query: string,
  variables?: Record<string, unknown>
): Promise<GraphQLResult> {
  const { shop, apiVersion } = getConfig();
  const token = await getAccessToken();

  const res = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    }
  );

  if (!res.ok) {
    throw new ShopifyApiError(
      `Admin API request failed with status ${res.status}`,
      await summarizeErrorBody(res)
    );
  }

  const body: unknown = await res.json();
  const envelope = ThrottleEnvelopeSchema.safeParse(body);

  return {
    body,
    cost: envelope.success ? envelope.data.extensions.cost.throttleStatus : null,
  };
}