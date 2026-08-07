import { ConfigError, ShopifyApiError, ShopifyAuthError } from './errors.js';
import { RetryExhaustedError } from './retry.js';

export function handleFatal(err: unknown): never {
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
}