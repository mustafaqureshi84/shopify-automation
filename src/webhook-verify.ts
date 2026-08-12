import { createHmac, timingSafeEqual } from 'node:crypto';
import 'dotenv/config';
import { ConfigError } from './errors.js';

/**
 * Verifies a webhook came from Shopify and wasn't tampered with.
 *
 * MUST run against the RAW request body, before any JSON parsing.
 * Parsing and re-serializing changes the bytes — whitespace, key order,
 * number formatting — and the signature will not match. The failure looks
 * like "Shopify is sending bad signatures," which sends people hunting in
 * entirely the wrong place.
 */
export function verifyWebhook(rawBody: string, headerHmac: string): boolean {
  const secret = process.env['SHOPIFY_CLIENT_SECRET'];

  if (!secret) {
    throw new ConfigError(
      'Missing SHOPIFY_CLIENT_SECRET — cannot verify webhook signatures.'
    );
  }

  const computed = createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(headerHmac, 'utf8');

  // Length mismatch means it can't match, and timingSafeEqual throws on
  // unequal lengths — so check first.
  if (a.length !== b.length) return false;

  /**
   * timingSafeEqual, not ===. A normal string comparison exits at the first
   * differing byte, so the time it takes leaks how many leading bytes were
   * correct. An attacker can use that to reconstruct a valid signature one
   * byte at a time. Constant-time comparison removes the signal.
   */
  return timingSafeEqual(a, b);
}