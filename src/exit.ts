import { ConfigError, ShopifyApiError, ShopifyAuthError } from './errors.js';
import { RetryExhaustedError } from './retry.js';
import { UserErrorsFailure } from './mutations.js';

/**
 * Renders any thrown value as readable text, preserving the detail each
 * error class carries. Written once so call sites don't each invent their
 * own summary and silently drop the useful part.
 */
export function describeError(err: unknown): string {
  if (err instanceof UserErrorsFailure) {
    return `[userErrors] ${err.message}\n${JSON.stringify(err.userErrors, null, 2)}`;
  }

  if (err instanceof ConfigError) {
    return `[config] ${err.message}`;
  }

  if (err instanceof RetryExhaustedError) {
    const last =
      err.lastError instanceof Error
        ? `\n  last error: ${err.lastError.message}`
        : '';
    return `[retry] ${err.message}${last}`;
  }

  if (err instanceof ShopifyAuthError) {
    const body = err.body ? `\n${err.body}` : '';
    return `[auth] ${err.message}${body}`;
  }

  if (err instanceof ShopifyApiError) {
    const detail =
      err.detail !== undefined
        ? `\n${JSON.stringify(err.detail, null, 2)}`
        : '';
    return `[api] ${err.message}${detail}`;
  }

  if (err instanceof Error) {
    return `[unexpected] ${err.name}: ${err.message}\n${err.stack ?? ''}`;
  }

  return `[unknown] Non-Error value thrown: ${String(err)}`;
}

function exitCodeFor(err: unknown): number {
  if (err instanceof UserErrorsFailure) return 65;
  if (err instanceof ConfigError) return 78;
  if (err instanceof RetryExhaustedError) return 75;
  if (err instanceof ShopifyAuthError) return err.isRetryable ? 75 : 77;
  if (err instanceof ShopifyApiError) return 70;
  return 1;
}

export function handleFatal(err: unknown): never {
  console.error(describeError(err));
  process.exit(exitCodeFor(err));
}