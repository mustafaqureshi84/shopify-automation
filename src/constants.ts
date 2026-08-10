/**
 * Shared constants. This module must never have side effects — importing
 * it should execute nothing.
 *
 * Script modules end with `main().catch(...)`, which runs on import in ESM.
 * Importing one to borrow a constant silently launches the whole script.
 * That bug had teardown-products.ts starting a 2,000-product generation on
 * every run, interleaved with its own output.
 */

/** Tag applied to every generated product so teardown can scope its deletes. */
export const GENERATED_TAG = 'automation-lab-generated';