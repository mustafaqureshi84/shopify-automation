import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from './webhook-verify.js';
import { ConfigError } from './errors.js';

const TEST_SECRET = 'test-secret-do-not-use-in-production';

let originalSecret: string | undefined;

before(() => {
  originalSecret = process.env['SHOPIFY_CLIENT_SECRET'];
  process.env['SHOPIFY_CLIENT_SECRET'] = TEST_SECRET;
});

after(() => {
  if (originalSecret === undefined) {
    delete process.env['SHOPIFY_CLIENT_SECRET'];
  } else {
    process.env['SHOPIFY_CLIENT_SECRET'] = originalSecret;
  }
});

function sign(body: string, secret = TEST_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('verifyWebhook', () => {
  test('accepts a correctly signed body', () => {
    const body = '{"id":123,"total_price":"750.00"}';

    assert.equal(verifyWebhook(body, sign(body)), true);
  });

  test('rejects a signature computed with the wrong secret', () => {
    const body = '{"id":123}';

    assert.equal(verifyWebhook(body, sign(body, 'wrong-secret')), false);
  });

  /**
   * The case HMAC exists for. The signature was genuine when created; the
   * body changed afterwards. Authentication alone would pass this.
   */
  test('rejects a body altered after signing', () => {
    const original = '{"id":123,"total_price":"750.00"}';
    const signature = sign(original);
    const tampered = original.replace('750.00', '0.01');

    assert.equal(verifyWebhook(tampered, signature), false);
  });

  test('rejects a malformed signature', () => {
    assert.equal(verifyWebhook('{"id":123}', 'not-base64-at-all'), false);
  });

  test('rejects an empty signature', () => {
    assert.equal(verifyWebhook('{"id":123}', ''), false);
  });

  /**
   * A length mismatch must return false, not throw. timingSafeEqual throws
   * on unequal buffer lengths, so the guard before it is load-bearing.
   */
  test('rejects a signature of the wrong length without throwing', () => {
    const body = '{"id":123}';
    const short = sign(body).slice(0, 10);

    assert.doesNotThrow(() => verifyWebhook(body, short));
    assert.equal(verifyWebhook(body, short), false);
  });

  test('is byte-exact — whitespace changes invalidate the signature', () => {
    const body = '{"id":123}';
    const signature = sign(body);

    assert.equal(verifyWebhook('{"id": 123}', signature), false);
  });

  test('handles an empty body', () => {
    assert.equal(verifyWebhook('', sign('')), true);
  });

  test('throws ConfigError when the secret is missing', () => {
    delete process.env['SHOPIFY_CLIENT_SECRET'];

    assert.throws(
      () => verifyWebhook('{}', 'sig'),
      (err: unknown) => err instanceof ConfigError
    );

    process.env['SHOPIFY_CLIENT_SECRET'] = TEST_SECRET;
  });
});