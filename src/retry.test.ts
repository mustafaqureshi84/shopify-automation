import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  withRetry,
  isRetryable,
  RetryableHttpError,
  RetryExhaustedError,
} from './retry.js';
import { ConfigError, ShopifyApiError, ShopifyAuthError } from './errors.js';

describe('isRetryable', () => {
  test('retries explicit retryable HTTP errors', () => {
    assert.equal(isRetryable(new RetryableHttpError('429', 429, null)), true);
  });

  test('retries network failures', () => {
    // Undici wraps connection failures in a TypeError.
    assert.equal(isRetryable(new TypeError('fetch failed')), true);
  });

  test('retries 5xx auth errors but not 4xx ones', () => {
    assert.equal(isRetryable(new ShopifyAuthError('down', 503)), true);
    assert.equal(isRetryable(new ShopifyAuthError('bad creds', 401)), false);
  });

  /**
   * A response that doesn't match the schema will not match it next time
   * either. Retrying a shape error wastes four attempts on a certainty.
   */
  test('does not retry shape errors', () => {
    assert.equal(isRetryable(new ShopifyApiError('bad shape')), false);
  });

  test('does not retry configuration errors', () => {
    assert.equal(isRetryable(new ConfigError('missing var')), false);
  });

  test('does not retry unrecognised errors', () => {
    assert.equal(isRetryable(new Error('who knows')), false);
    assert.equal(isRetryable('a string'), false);
    assert.equal(isRetryable(null), false);
  });
});

/**
 * These use real timers with a 10ms base delay rather than mocked ones.
 *
 * Node 22.18's MockTimers has no `tickAsync`, and the synchronous `tick`
 * cannot advance past awaited promises inside the retry loop. Small real
 * delays keep the suite under a second and test the actual timing code
 * rather than a substitute for it.
 */
describe('withRetry', () => {
  test('returns immediately on success', async () => {
    let calls = 0;

    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    });

    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  test('recovers after a transient failure', async () => {
    let calls = 0;

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        return 'recovered';
      },
      { baseDelayMs: 10 }
    );

    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  test('throws immediately on a non-retryable error', async () => {
    let calls = 0;

    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw new ConfigError('missing var');
      }),
      (err: unknown) => err instanceof ConfigError
    );

    // Not wrapped in RetryExhaustedError, and attempted exactly once.
    assert.equal(calls, 1);
  });

  test('exhausts attempts and wraps the last error', async () => {
    let calls = 0;

    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new TypeError('fetch failed');
        },
        { maxAttempts: 3, baseDelayMs: 10, label: 'test op' }
      ),
      (err: unknown) => {
        assert.ok(err instanceof RetryExhaustedError);
        assert.equal(err.attempts, 3);
        assert.ok(err.lastError instanceof TypeError);
        assert.match(err.message, /test op/);
        return true;
      }
    );

    assert.equal(calls, 3);
  });

  /**
   * Each delay should be roughly double the last. Jitter spans 85%–115% of
   * target, so the assertion is on the ratio rather than exact values —
   * asserting a specific number would fail randomly.
   */
  test('backoff grows exponentially', async () => {
    const attemptTimes: number[] = [];

    await withRetry(
      async () => {
        attemptTimes.push(Date.now());
        throw new TypeError('fetch failed');
      },
      { maxAttempts: 4, baseDelayMs: 40 }
    ).catch(() => undefined);

    assert.equal(attemptTimes.length, 4);

    const gaps = [
      attemptTimes[1]! - attemptTimes[0]!,
      attemptTimes[2]! - attemptTimes[1]!,
      attemptTimes[3]! - attemptTimes[2]!,
    ];

    assert.ok(
      gaps[1]! > gaps[0]!,
      `gap 2 (${gaps[1]}ms) should exceed gap 1 (${gaps[0]}ms)`
    );
    assert.ok(
      gaps[2]! > gaps[1]!,
      `gap 3 (${gaps[2]}ms) should exceed gap 2 (${gaps[1]}ms)`
    );
  });

  /**
   * The server knows when its bucket refills; the local exponential curve is
   * a guess. When both are available, the server's instruction wins.
   */
  test('Retry-After overrides local backoff', async () => {
    const attemptTimes: number[] = [];

    await withRetry(
      async () => {
        attemptTimes.push(Date.now());
        // baseDelayMs of 2000 would normally apply; the server says 20ms.
        throw new RetryableHttpError('throttled', 429, 20);
      },
      { maxAttempts: 2, baseDelayMs: 2000 }
    ).catch(() => undefined);

    assert.equal(attemptTimes.length, 2);

    const gap = attemptTimes[1]! - attemptTimes[0]!;
    assert.ok(
      gap < 500,
      `gap was ${gap}ms; expected the 20ms server hint, not the 2000ms curve`
    );
  });

  test('a custom shouldRetry overrides the default classification', async () => {
    let calls = 0;

    await withRetry(
      async () => {
        calls += 1;
        // Normally not retryable.
        throw new ConfigError('missing var');
      },
      { maxAttempts: 2, baseDelayMs: 10, shouldRetry: () => true }
    ).catch(() => undefined);

    assert.equal(calls, 2);
  });
});