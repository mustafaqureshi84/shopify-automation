import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { idempotencyKey } from './constants.js';

describe('idempotencyKey', () => {
  test('is deterministic — the same inputs always produce the same key', () => {
    const a = idempotencyKey('erp-order', 'gid://shopify/Order/123');
    const b = idempotencyKey('erp-order', 'gid://shopify/Order/123');

    assert.equal(a, b);
  });

  test('differs when any part differs', () => {
    const order1 = idempotencyKey('erp-order', 'gid://shopify/Order/123');
    const order2 = idempotencyKey('erp-order', 'gid://shopify/Order/124');

    assert.notEqual(order1, order2);
  });

  test('differs when the operation prefix differs', () => {
    const activate = idempotencyKey('activate', 'item-1', 'loc-1');
    const setQty = idempotencyKey('set-quantities', 'item-1', 'loc-1');

    assert.notEqual(activate, setQty);
  });

  /**
   * Guards against a subtle collision: joining parts without a separator
   * would make ('ab', 'c') and ('a', 'bc') produce the same key.
   */
  test('part boundaries are significant', () => {
    const a = idempotencyKey('ab', 'c');
    const b = idempotencyKey('a', 'bc');

    assert.notEqual(a, b);
  });

  test('produces a 32-character hex string', () => {
    const key = idempotencyKey('erp-order', 'gid://shopify/Order/123');

    assert.equal(key.length, 32);
    assert.match(key, /^[0-9a-f]{32}$/);
  });

  test('handles the empty case without throwing', () => {
    assert.doesNotThrow(() => idempotencyKey());
  });
});