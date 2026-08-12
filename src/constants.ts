import { createHash } from 'node:crypto';

/**
 * Shared constants and pure helpers. This module must never have side
 * effects — importing it should execute nothing.
 *
 * Script modules end with `main().catch(...)`, which runs on import in ESM.
 * Importing one to borrow a constant silently launches the whole script.
 */

/** Tag applied to every generated product so teardown can scope its deletes. */
export const GENERATED_TAG = 'automation-lab-generated';

/**
 * Derives a stable idempotency key from the parts identifying an operation.
 *
 * Must be derived, never random. A random key on each attempt means the
 * remote system sees every retry as a new request, which defeats the entire
 * mechanism — the key exists so a replay can be recognised as a replay.
 *
 * Verified against an ERP that accepted an order and then never responded:
 * the retry carried the same key and returned the original reference instead
 * of creating a second order.
 */
export function idempotencyKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}