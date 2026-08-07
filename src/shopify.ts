import { getConfig } from './config.js';
import { ShopifyAuthError, ShopifyApiError } from './errors.js';
import { withRetry, RetryableHttpError } from './retry.js';
import { RateLimiter } from './rate-limiter.js';
import {
  TokenResponseSchema,
  ThrottleEnvelopeSchema,
  GraphQLErrorEnvelopeSchema,
} from './types.js';
import type { Cost, ThrottleStatus } from './types.js';

let cachedToken: { value: string; expiresAt: number } | null = null;

export const limiter = new RateLimiter({ label: 'admin' });

export function invalidateToken(): void {
  cachedToken = null;
}

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

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000);

  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;

  return Math.max(0, when - Date.now());
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const { shop, clientId, clientSecret } = getConfig();

  const parsed = await withRetry(
    async () => {
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
        if (isTransientStatus(res.status)) {
          throw new RetryableHttpError(
            `Token request failed with status ${res.status}`,
            res.status,
            parseRetryAfter(res)
          );
        }

        throw new ShopifyAuthError(
          `Token request failed with status ${res.status}`,
          res.status,
          await summarizeErrorBody(res)
        );
      }

      const result = TokenResponseSchema.safeParse(await res.json());

      if (!result.success) {
        throw new ShopifyApiError(
          'Token response did not match expected shape',
          result.error.issues
        );
      }

      return result.data;
    },
    { label: 'token request' }
  );

  const lifetimeSeconds = parsed.expires_in ?? 86_400;
  const safetyMarginSeconds = 300;

  cachedToken = {
    value: parsed.access_token,
    expiresAt: Date.now() + (lifetimeSeconds - safetyMarginSeconds) * 1000,
  };

  return cachedToken.value;
}

function readCost(body: unknown): Cost | null {
  const envelope = ThrottleEnvelopeSchema.safeParse(body);
  return envelope.success ? envelope.data.extensions.cost : null;
}

function findThrottleError(body: unknown): string | null {
  const parsed = GraphQLErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success || !parsed.data.errors) return null;

  for (const err of parsed.data.errors) {
    if (err.extensions?.code === 'THROTTLED') return err.message;
    if (err.message.toUpperCase().includes('THROTTLED')) return err.message;
  }

  return null;
}

export interface GraphQLResult {
  body: unknown;
  cost: ThrottleStatus | null;
}

export interface GraphQLOptions {
  /** Set false for non-idempotent writes that must not be replayed. */
  retry?: boolean;
}

export async function shopifyGraphQL(
  query: string,
  variables?: Record<string, unknown>,
  options: GraphQLOptions = {}
): Promise<GraphQLResult> {
  const { shop, apiVersion } = getConfig();
  const { retry = true } = options;

  const execute = async (): Promise<GraphQLResult> => {
    const token = await getAccessToken();

    await limiter.acquire();

    let body: unknown;

    try {
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

      if (res.status === 401) {
        invalidateToken();
        throw new RetryableHttpError(
          'Access token was rejected — refreshing',
          401,
          null
        );
      }

      if (!res.ok) {
        if (isTransientStatus(res.status)) {
          throw new RetryableHttpError(
            `Admin API request failed with status ${res.status}`,
            res.status,
            parseRetryAfter(res)
          );
        }

        throw new ShopifyApiError(
          `Admin API request failed with status ${res.status}`,
          await summarizeErrorBody(res)
        );
      }

      body = await res.json();
    } finally {
      limiter.release();
    }

    const cost = readCost(body);
    const throttleMessage = findThrottleError(body);

    if (throttleMessage) {
      limiter.markThrottled(cost?.throttleStatus);

      const waitMs = limiter.waitTimeFor(cost?.requestedQueryCost ?? 100);

      throw new RetryableHttpError(
        `Throttled by Shopify: ${throttleMessage}`,
        429,
        Math.max(waitMs, 1000)
      );
    }

    if (cost) {
      limiter.record(cost.throttleStatus, cost.actualQueryCost ?? undefined);
    }

    return { body, cost: cost?.throttleStatus ?? null };
  };

  if (!retry) return execute();

  return withRetry(execute, { label: 'admin graphql', maxAttempts: 5 });
}