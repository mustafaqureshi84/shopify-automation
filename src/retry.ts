import { ConfigError, ShopifyApiError, ShopifyAuthError } from './errors.js';

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: unknown
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

export class RetryableHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null
  ) {
    super(message);
    this.name = 'RetryableHttpError';
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableHttpError) return true;
  if (err instanceof ShopifyAuthError) return err.isRetryable;

  // A bad response shape will be bad again next time.
  if (err instanceof ShopifyApiError) return false;

  // Misconfiguration never fixes itself.
  if (err instanceof ConfigError) return false;

  // Undici wraps network failures; the cause carries the real signal.
  if (err instanceof TypeError && err.message.includes('fetch failed')) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, 30_000);
  const jitter = Math.random() * capped * 0.3;
  return Math.round(capped * 0.85 + jitter);
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 1000,
    label = 'operation',
    shouldRetry = isRetryable,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;

      if (!shouldRetry(err)) throw err;

      if (attempt === maxAttempts) break;

      const serverHint =
        err instanceof RetryableHttpError ? err.retryAfterMs : null;
      const delay = serverHint ?? backoffDelay(attempt, baseDelayMs);

      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[retry] ${label} attempt ${attempt}/${maxAttempts} failed ` +
          `(${reason}) — waiting ${delay}ms`
      );

      await sleep(delay);
    }
  }

  throw new RetryExhaustedError(
    `${label} failed after ${maxAttempts} attempts`,
    maxAttempts,
    lastError
  );
}