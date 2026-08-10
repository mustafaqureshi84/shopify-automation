# Shopify Automation Lab

A learning project for building reliable Shopify integrations against the GraphQL Admin API. The focus is not "make a request work" — it's what a request needs around it to run unattended: runtime validation, typed errors, retry with backoff, adaptive rate limiting, idempotent writes, and meaningful exit codes.

## Stack

- **TypeScript** (strict, ESM, `nodenext`)
- **tsx** for running TypeScript directly
- **Zod v4** for runtime validation
- **Shopify GraphQL Admin API** `2026-07` (REST is legacy and not used)
- **OAuth client credentials** for authentication

## Setup

### Prerequisites

- Node.js 22 LTS
- A Shopify Partner account
- A development store created from the Dev Dashboard

### Create the app

1. In the Dev Dashboard, create an app via **Start from Dev Dashboard**
2. Set these scopes: `read_customers`, `read_inventory`, `write_inventory`, `read_locations`, `read_orders`, `read_products`, `write_products`
3. Leave **Embed app in Shopify admin** unchecked — this app has no UI
4. Leave **Use legacy install flow** unchecked (managed installation)
5. Release the version, then install the app on your store

Permanent `shpat_` tokens are no longer issued from the Shopify admin. Tokens are requested at runtime via the client credentials grant and are valid for 24 hours.

**Scope changes require reinstalling the app.** Releasing a new version updates the app's declared scopes, but an existing installation retains the grant it was authorized under, and tokens are issued against the installation. Run `check-scopes.ts` to see what a token actually holds.

### Install

```bash
npm install
```

### Environment variables

Create a `.env` file at the project root:

```
SHOP_DOMAIN=
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
```

`SHOP_DOMAIN` is the full `.myshopify.com` domain with no protocol. `.env` is gitignored and must stay that way.

## Scripts

```bash
npx tsx src/check-scopes.ts        # what scopes does this token actually have
npx tsx src/first-query.ts         # minimal single query — 10 products
npx tsx src/export-products.ts     # full catalog via cursor pagination
npx tsx src/bulk-export.ts         # full catalog via Bulk Operations + JSONL
npx tsx src/async-patterns.ts      # concurrency benchmark, 4 strategies
npx tsx src/inventory-report.ts    # per-location stock, quantity-name audit
npx tsx src/metafields.ts          # definition lifecycle, mutations, idempotency proof
npx tsx src/generate-products.ts   # create synthetic catalog data
npx tsx src/populate-inventory.ts  # activate inventory and set on_hand quantities
npx tsx src/teardown-products.ts   # delete generated data (requires CONFIRM=yes)
```

Environment overrides:

```bash
PAGE_SIZE=250                      # export-products.ts page size
COUNT=2000 START_AT=21 SEED=42     # generate-products.ts
SEED=7                             # populate-inventory.ts distribution
CONFIRM=yes                        # teardown-products.ts safety gate
```

**PowerShell note:** `$env:VAR` persists for the terminal session only. A stale `PAGE_SIZE=2` turned a 6-second export into a 9-minute one more than once. Clear variables explicitly or open a fresh terminal.

## Structure

| File | Responsibility |
|---|---|
| `src/constants.ts` | Shared values. No imports, no side effects, safe to import anywhere |
| `src/config.ts` | Reads and validates env vars; memoized, throws `ConfigError` |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter; `RetryExhaustedError` |
| `src/exit.ts` | `describeError` renders any thrown value; `handleFatal` adds the exit code |
| `src/rate-limiter.ts` | Leaky-bucket model; gates requests, tracks cost, derives concurrency |
| `src/shopify.ts` | Transport layer — the only file that calls `fetch` |
| `src/mutations.ts` | Write path: `userErrors` handling, idempotency classification, `requireData` |
| `src/paginate.ts` | Generic cursor-pagination async generators |
| `src/bulk.ts` | Bulk Operations lifecycle: submit, poll, stream JSONL, group by parent |
| `src/types.ts` | Zod schemas; TypeScript types derived via `z.infer` |
| `src/check-scopes.ts` | Script: diagnostic for granted vs declared scopes |
| `src/first-query.ts` | Script: minimal query example |
| `src/export-products.ts` | Script: paginated catalog export |
| `src/bulk-export.ts` | Script: bulk catalog export, cross-checked against pagination |
| `src/async-patterns.ts` | Script: concurrency benchmark |
| `src/inventory-report.ts` | Script: location and inventory-level traversal |
| `src/metafields.ts` | Script: metafield definitions and idempotent writes |
| `src/generate-products.ts` | Script: synthetic catalog generation via atomic `productSet` |
| `src/populate-inventory.ts` | Script: inventory activation and quantity setting |
| `src/teardown-products.ts` | Script: tag-scoped deletion of generated data |

Dependencies flow one direction. `constants.ts`, `types.ts`, and `errors.ts` have no dependencies; scripts sit at the top.

## Design notes

### Engineering

**Script modules must never be imported.** A file ending in `main().catch(...)` executes on import in ESM. `teardown-products.ts` imported `GENERATED_TAG` from `generate-products.ts` and thereby launched a full 2,000-product generation on every single run — silently, interleaved with its own output. The symptom looked exactly like operator error (two scripts running at once) and was misdiagnosed as such for hours. Shared values now live in `constants.ts`, which has no imports and no side effects.

**When the same "user error" recurs repeatedly, it usually isn't user error.** The above cost several hours because a plausible explanation fit the evidence and stopped further investigation.

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions — types are a consequence of validation rather than a promise to the compiler.

**Three separate error channels.** HTTP status, the GraphQL `errors` array, and mutation `userErrors`. All three must be checked. A mutation rejected by a business rule returns HTTP 200 with no `errors` array — code checking only the first two reports success on a failed write.

**Errors are checked before shape.** `requireData` inspects the `errors` array before validating structure, because a rejected request frequently returns `null` data *as a consequence* of the error. Validating first surfaces Zod's inference about the null instead of the API's explanation for it.

**Error description lives in one place.** `describeError` renders any thrown value with the detail its class carries; `handleFatal` wraps it with an exit code. Call sites that write their own summaries drop the useful part — this happened twice before the logic was extracted.

**Retry decisions are status-based, not text-based.** 429 and 5xx retry; 4xx does not. Shopify's error pages contain reassuring prose like "this store will be right back" even for stores that never existed, so response body text is not used to decide retryability.

**`Retry-After` overrides local backoff.** When the server states when to retry, that instruction wins over the exponential curve.

**Backoff includes jitter.** Delays land between roughly 85% and 115% of target so concurrent failures don't retry in lockstep.

**Token caching expires early.** A 300-second safety margin is subtracted from the token lifetime to avoid a token expiring between the validity check and the request reaching Shopify. A 401 mid-run invalidates the cache and retries.

**`THROTTLED` arrives as HTTP 200.** Shopify returns rate-limit rejections in the GraphQL `errors` array with a normal status code, so `res.ok` checks miss them entirely.

**Rate limiting is adaptive, not configured.** The limiter reads `throttleStatus` from every response, extrapolates refill from elapsed time, and reserves points before admitting a request. Concurrency is derived as `restoreRate ÷ estimatedCost`. A 20% reserve is held back so this client doesn't starve other processes sharing the same store's bucket.

**Retry is opt-in per operation, not global.** `shopifyGraphQL` accepts `retry: false`. `mutate` sets it from an explicit `idempotency` argument. Idempotency is a property of the operation, not something a wrapper can add.

**Reads paginate; writes batch.** Cursor pagination streams results without holding a catalog in memory. `metafieldsSet` accepts 25 metafields per call.

**Bulk writes record per-item outcomes rather than throwing.** `createOne` and `applyPlan` return result objects and never throw, so one failure at item 1,400 does not abandon the rest. At scale, partial success is the normal case.

**JSONL parsing must handle chunk boundaries.** Network chunks do not align with newlines. `streamLines` buffers the partial line until the remainder arrives. Splitting each chunk on `\n` independently produces corrupt JSON on any file large enough to span chunks.

**Bulk results are grouped by streaming, not buffering.** Shopify guarantees child lines immediately follow their parent, so a group is complete once the next parent appears.

**Poll intervals back off.** Every status check is a real API request. The interval grows 1.5× to a 10-second ceiling.

**Test data generation uses a seeded PRNG.** A given `SEED` and `START_AT` always produce the same catalog, so a run can be reproduced exactly when two implementations disagree.

### Shopify data model

Findings verified against a live development store, not taken from documentation.

**Inventory does not live on a variant.** The chain is `ProductVariant → InventoryItem → InventoryLevel → Location`. A variant has one level per location. `variant.inventoryQuantity` is a convenience sum and returns `null` when tracking is disabled.

**Setting `tracked: true` does not create inventory levels.** `productSet` marks a variant as tracked but stocks it nowhere. An item must be activated at a location via `inventoryActivate` before any quantity can be set there.

**Untracked variants are not zero-stock variants.** A variant with `inventoryItem.tracked === false` has no levels at all. Treating it as `0` in a sync would overwrite a downstream system with a number meaning "none" when the truth is "unknown."

**Quantity names are not interchangeable.** Verified by placing an unfulfilled test order: one unit moved from `available` while `on_hand` stayed constant and `committed` rose to 1. The same physical unit is simultaneously on the shelf, unsellable, and owed to a customer.

**`on_hand` is settable; `available` is derived.** `available = on_hand − committed`, so it cannot be written directly.

**`totalInventory` reflects `available`, not `on_hand`.**

**Location capability constrains usable inventory.** Stock at a location flagged `shipsInventory: false` is real and unfulfillable online. Any "can we ship this" calculation must filter on `shipsInventory` and `fulfillsOnlineOrders` before summing.

**Deactivated locations still hold stock.** `locations` omits inactive locations unless `includeInactive: true` is passed.

**Top-level `productVariants` avoids nesting cost.** Querying variants nested inside products multiplies query cost and truncates at the inner connection limit.

**Shopify does not enforce SKU uniqueness.** Two products with identical variant SKUs coexist without complaint. Handles are auto-deduplicated (`carbon-boot-00001`, `carbon-boot-00001-1`); SKUs are not.

**`userError` payload types differ per mutation.** `productCreate` and `productDelete` return plain `UserError` with only `field` and `message`. `productSet`, `productVariantsBulkCreate`, and `metafieldsSet` return richer types carrying `code`. `inventoryActivate` has **no** `userErrors` field at all. Requesting a field that doesn't exist fails at query *validation*, before the mutation runs.

**Inventory mutations require an explicit `@idempotent` directive.** Both `inventoryActivate` and `inventorySetQuantities` reject requests without `@idempotent(key: $key)`. The key is caller-supplied and deduplicated server-side. Shopify enforces at the protocol level the same distinction this project classifies by hand in `mutations.ts`.

**`ignoreCompareQuantity` was removed in 2026-04.** Compare-and-swap moved from a mutation-level boolean to a per-quantity `changeFromQuantity` on `InventoryQuantityInput`. `null` explicitly opts out, and the field must always be present. Same capability, but the unsafe path now requires deliberate repeated effort rather than one convenient flag — a good illustration of API design steering callers toward safety.

**Two sequential mutations have no transaction.** `productCreate` followed by `productVariantsBulkCreate` leaves an orphaned product when the second call fails. `productSet` with `synchronous: true` does the whole thing atomically. Partial state cannot be retried away.

**Bulk queries use a different dialect.** `edges { node { } }` is required; the `nodes` shorthand is unsupported. Nested connections take no `first:` argument and return every node.

**`objectCount` counts JSONL lines, not records.** 2,037 products with 6,096 variants reports 8,133 objects.

**Metafield definitions require namespace ownership, not just a write scope.** The `$app:` prefix reserves one — `$app:automation_lab` expands to `app--407236050945--automation_lab`.

**App-namespaced metafields are invisible in the admin.** Correct for machine-written state like sync timestamps, wrong for anything a merchant needs to manage.

**`metafieldsSet` is an upsert.** Verified by writing an identical payload twice across 17 products: all 17 metafield IDs unchanged, no duplicates.

**Granted scopes and declared scopes drift.** A version release changes what an app declares; the installation keeps the grant it was authorized under. Reads worked normally while every mutation was denied. `currentAppInstallation.accessScopes` is ground truth. This cost an hour twice — once for `write_products`, once for `write_inventory`.

## Measured behaviour

Recorded against a Plus development store: 20,000-point bucket, 1000/sec restore. Catalog of 2,017 products / 6,014 variants.

| Workload | Result |
|---|---|
| 2,000 products via `productSet`, concurrency 4 | 8m 27s, 0 failures |
| 6,014 variants activated + quantities set, concurrency 6 | 22m 23s, 0 failures, 233,595 units |
| 4,053 products deleted, adaptive concurrency | 2m 38s, 0 failures |
| Full read, `PAGE_SIZE=2` | 1,019 pages, 8m 51s |
| Full read, `PAGE_SIZE=250` | 9 pages, 6.2s |
| Full read, Bulk Operations | 6.2s + 2.2s parse, bucket stayed at 20,000 |
| Query cost | 7–20 points depending on depth |

**Bulk and paginated exports agree exactly** — 2,037 products, 1,866 ACTIVE / 1 ARCHIVED / 170 DRAFT, 679 tracked inventory. Two independent implementations producing identical results is stronger evidence than either running without error.

**The rate limiter has never triggered.** At concurrency 4–6 with 12–17 point mutations at ~250ms each, spend stayed far below the 1000/sec restore rate. The bucket never dropped below 19,800 during any run. `suggestedConcurrency()` returned its hardcoded ceiling of 20 throughout, never a bucket-derived figure. On a Basic-plan store (100 points, 50/sec) the same workload would throttle within the first two products.

**Retry has been exercised under genuine network failure.** Multiple runs hit `TypeError: fetch failed` from real connection drops; backoff recovered all but a handful, which were correctly classified and reported without corrupting state.

## Exit codes

Following the `sysexits` convention so a scheduler can distinguish failure classes without parsing logs.

| Code | Meaning |
|---|---|
| 0 | Success |
| 65 | Data error — a mutation was rejected via `userErrors` |
| 70 | API error — GraphQL errors, unexpected response shape, non-retryable HTTP failure |
| 75 | Temporary failure — retries exhausted, or a retryable auth error |
| 77 | Permission denied — credentials rejected; retrying will not help |
| 78 | Configuration error — missing or invalid environment variables |
| 1 | Unexpected error |

## Known limitations

1. **Concurrency ceiling is arbitrary.** `suggestedConcurrency()` derives a rate from `restoreRate ÷ estimatedCost` but caps at 20. The uncapped figure on this store is around 60. The cap, not the bucket, has been the binding constraint in every run.

2. **Cost estimates are catalog-size dependent.** Observed cost ranged from 7 to 20 points depending on query depth. Actual cost scales with returned nodes.

3. **The rate limiter is untested under real pressure.** No workload has come close to draining the bucket. The waiting path has never executed against a genuine limit, only against a stubbed 429.

4. **Idempotency keys are random per call, not derived.** `randomUUID()` means a retried request sends a *different* key, so server-side deduplication never actually engages. Harmless for these naturally-safe operations, but wrong for anything where the key must survive a retry — that requires deriving the key deterministically from the operation itself.

5. **Single store per process.** `getConfig()` memoizes into module scope and `shopify.ts` exports one shared limiter instance.

6. **No adaptive backoff on repeated throttling.** A sustained throttle is retried with the same computed wait each time, with no escalation.

7. **Non-idempotent failures require manual reconciliation.** A create that fails after the write reached Shopify is not retried, by design — but nothing records the ambiguity for a human to resolve.

8. **No scope preflight.** Scripts discover missing permissions when a mutation is denied mid-run — twice costing a full run's worth of time. `check-scopes.ts` exists but must be run manually. A production system would assert required scopes at startup and refuse to begin.

9. **No dry-run or sample mode.** `populate-inventory.ts` processes every matching variant with no way to test against five first, so a wrong mutation shape costs 20 minutes to discover. A `LIMIT` option would have caught two separate errors in seconds.

10. **Nested connection depth is fixed outside bulk queries.** `inventoryLevels(first: 20)`, `variants(first: 10)`, and `metafields(first: 10)` are hardcoded.

11. **Teardown has a check-then-act race.** `collectIds()` and the delete loop are separate steps. Anything created between them survives while the script reports complete success.

12. **Bulk error paths are untested.** `FAILED`, `EXPIRED`, `partialDataUrl`, and timeout handling have never executed.

13. **No persistence.** Results are printed to stdout and discarded.

14. **No tests.** Failure paths were verified manually: breaking credentials, unresolvable hosts, stubbed 429s, an unfulfilled order to force committed stock, and running every script twice.

## Resolved

- ~~No token invalidation on 401~~ — a rejected token now clears the cache and retries.
- ~~Concurrency limit is hardcoded~~ — now derived from observed cost and restore rate.
- ~~Throttle reporting understates pressure~~ — replaced by a limiter that extrapolates.
- ~~`totalInventory` audit passed vacuously~~ — retested with committed stock present.
- ~~`retry.ts` is unsafe for mutations~~ — retry is opt-in per operation.
- ~~Read-only~~ — write path implemented with `userErrors` handling and proven idempotency.
- ~~Catalog too small to test at scale~~ — 2,000 products, 6,014 variants.
- ~~No bulk export~~ — implemented with JSONL streaming, verified against pagination.
- ~~Generated products have no inventory~~ — 233,595 units across two locations with a deliberate distribution: 3,575 shipping-only, 1,198 both, 623 non-shipping-only, 618 zero.
- ~~Scripts appear to interfere when run concurrently~~ — root cause was a module side-effect import, not concurrent execution.

## Roadmap

- Postgres persistence via Prisma
- Fulfillment orders and location routing
- Webhook receiver with HMAC verification and idempotent handlers