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
2. Set these scopes: `read_customers`, `read_inventory`, `read_locations`, `read_orders`, `read_products`, `write_products`
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
npx tsx src/teardown-products.ts   # delete generated data (requires CONFIRM=yes)
```

Environment overrides:

```bash
PAGE_SIZE=250                      # export-products.ts page size
COUNT=2000 START_AT=21 SEED=42     # generate-products.ts
CONFIRM=yes                        # teardown-products.ts safety gate
```

## Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | Reads and validates env vars; memoized, throws `ConfigError` naming every missing variable |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter; `RetryExhaustedError` |
| `src/exit.ts` | `describeError` renders any thrown value; `handleFatal` adds the exit code |
| `src/rate-limiter.ts` | Leaky-bucket model; gates requests, tracks cost, derives concurrency |
| `src/shopify.ts` | Transport layer — the only file that calls `fetch` |
| `src/mutations.ts` | Write path: `userErrors` handling, idempotency classification, `requireData` |
| `src/paginate.ts` | Generic cursor-pagination async generators |
| `src/bulk.ts` | Bulk Operations lifecycle: submit, poll with backoff, stream JSONL, group by parent |
| `src/types.ts` | Zod schemas; TypeScript types derived via `z.infer` |
| `src/check-scopes.ts` | Script: diagnostic for granted vs declared scopes |
| `src/first-query.ts` | Script: minimal query example |
| `src/export-products.ts` | Script: paginated catalog export |
| `src/bulk-export.ts` | Script: bulk catalog export, cross-checked against pagination |
| `src/async-patterns.ts` | Script: concurrency benchmark |
| `src/inventory-report.ts` | Script: location and inventory-level traversal |
| `src/metafields.ts` | Script: metafield definitions and idempotent writes |
| `src/generate-products.ts` | Script: synthetic catalog generation via atomic `productSet` |
| `src/teardown-products.ts` | Script: tag-scoped deletion of generated data |

Dependencies flow one direction. `types.ts` and `errors.ts` have no dependencies; scripts sit at the top.

## Design notes

### Engineering

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions — types are a consequence of validation rather than a promise to the compiler.

**Three separate error channels.** HTTP status, the GraphQL `errors` array, and mutation `userErrors`. All three must be checked. A mutation rejected by a business rule returns HTTP 200 with no `errors` array — code checking only the first two reports success on a failed write.

**Errors are checked before shape.** `requireData` inspects the `errors` array before validating structure, because a rejected request frequently returns `null` data *as a consequence* of the error. Validating first surfaces Zod's inference about the null instead of the API's explanation for it.

**Error description lives in one place.** `describeError` renders any thrown value with the detail its class carries; `handleFatal` wraps it with an exit code. Call sites that write their own summaries drop the useful part — this happened twice during development before the logic was extracted.

**Retry decisions are status-based, not text-based.** 429 and 5xx retry; 4xx does not. Shopify's error pages contain reassuring prose like "this store will be right back" even for stores that never existed, so response body text is not used to decide retryability.

**`Retry-After` overrides local backoff.** When the server states when to retry, that instruction wins over the exponential curve.

**Backoff includes jitter.** Delays land between roughly 85% and 115% of target so concurrent failures don't retry in lockstep.

**Token caching expires early.** A 300-second safety margin is subtracted from the token lifetime to avoid a token expiring between the validity check and the request reaching Shopify. A 401 mid-run invalidates the cache and retries.

**`THROTTLED` arrives as HTTP 200.** Shopify returns rate-limit rejections in the GraphQL `errors` array with a normal status code, so `res.ok` checks miss them entirely. They are detected by inspecting the response body and converted into a retryable error carrying a computed wait.

**Rate limiting is adaptive, not configured.** The limiter reads `throttleStatus` from every response, extrapolates refill from elapsed time, and reserves points before admitting a request. Concurrency is derived as `restoreRate ÷ estimatedCost` rather than hardcoded. A 20% reserve is held back so this client doesn't starve other processes sharing the same store's bucket.

**Retry is opt-in per operation, not global.** `shopifyGraphQL` accepts `retry: false`. `mutate` sets it from an explicit `idempotency` argument. Idempotency is a property of the operation, not something a wrapper can add — so the caller declares it rather than the transport guessing.

**Reads paginate; writes batch.** Cursor pagination streams results without holding a catalog in memory. `metafieldsSet` accepts 25 metafields per call.

**Bulk writes record per-item outcomes rather than throwing.** `createOne` returns a result object and never throws, so one failure at item 1,400 does not abandon the 599 still in flight. At scale, partial success is the normal case.

**JSONL parsing must handle chunk boundaries.** Network chunks do not align with newlines, so a chunk can end mid-object. `streamLines` buffers the partial line until the remainder arrives. Splitting each chunk on `\n` independently produces corrupt JSON on any file large enough to span chunks — the most common bug in JSONL parsers.

**Bulk results are grouped by streaming, not buffering.** Shopify guarantees child lines immediately follow their parent, so a group is complete once the next parent appears. Building a Map of all parents first works at 2,000 products and exhausts memory at 500,000.

**Poll intervals back off.** Every status check is a real API request. Polling a five-minute export every second spends 300 requests learning nothing. The interval grows 1.5× to a 10-second ceiling.

**Bulk operations are singular per app per store.** A run that crashes mid-poll leaves an operation in flight and blocks the next submission. `getCurrentOperation()` is checked before submitting — and is also the mechanism for resuming after a crash rather than restarting.

**Test data generation uses a seeded PRNG.** A given `SEED` and `START_AT` always produce the same catalog, so a run can be reproduced exactly when two implementations disagree.

### Shopify data model

Findings verified against a live development store, not taken from documentation.

**Inventory does not live on a variant.** The chain is `ProductVariant → InventoryItem → InventoryLevel → Location`. A variant has one level per location. `variant.inventoryQuantity` is a convenience sum and returns `null` when tracking is disabled.

**Untracked variants are not zero-stock variants.** A variant with `inventoryItem.tracked === false` has no levels at all. Treating it as `0` in a sync would overwrite a downstream system with a number meaning "none" when the truth is "unknown."

**Quantity names are not interchangeable.** Verified by placing an unfulfilled test order: one unit moved from `available` while `on_hand` stayed constant and `committed` rose to 1. The same physical unit is simultaneously on the shelf, unsellable, and owed to a customer. Syncing `on_hand` to a sales channel oversells; syncing `available` to a warehouse system reports a phantom discrepancy at every stock count.

**`totalInventory` reflects `available`, not `on_hand`.** Confirmed under the committed-stock condition above — the product total tracked the drop in `available` and the audit still reconciled. It is a safe sum-of-available shortcut and an unsafe measure of physical stock, despite the name.

**Location capability constrains usable inventory.** The test store holds 50 units at a location flagged `shipsInventory: false`. Summing `available` across all locations overstates fulfillable stock by that amount. Any "can we ship this" calculation must filter on `shipsInventory` and `fulfillsOnlineOrders` before summing.

**Deactivated locations still hold stock.** `locations` omits inactive locations unless `includeInactive: true` is passed, so inventory at a closed warehouse silently disappears from a naive query.

**Top-level `productVariants` avoids nesting cost.** Querying variants nested inside products multiplies query cost and truncates at the inner connection limit; the flat connection does neither.

**Shopify does not enforce SKU uniqueness.** Two products with identical variant SKUs coexist without complaint. Handles are auto-deduplicated (`carbon-boot-00001`, `carbon-boot-00001-1`); SKUs are not. Any downstream system keying on SKU must handle collisions rather than assuming uniqueness.

**`userError` payload types differ per mutation.** `productCreate` and `productDelete` return plain `UserError` with only `field` and `message`. `productSet`, `productVariantsBulkCreate`, and `metafieldsSet` return richer types carrying `code`. Requesting `code` where it doesn't exist fails at query *validation*, before the mutation runs.

**Two sequential mutations have no transaction.** `productCreate` followed by `productVariantsBulkCreate` leaves an orphaned product when the second call fails — the first is not rolled back. `productSet` with `synchronous: true` creates the product, its options, and its fully-specified variants atomically. Where an atomic single-call equivalent exists, use it; partial state cannot be retried away.

**Bulk queries use a different dialect.** `edges { node { } }` is required; the `nodes` shorthand is unsupported. Nested connections take no `first:` argument and return every node, so the truncation that constrains normal queries does not exist in bulk.

**`objectCount` counts JSONL lines, not records.** An export of 2,037 products with 6,096 variants reports 8,133 objects.

**Metafield definitions require namespace ownership, not just a write scope.** Apps cannot create definitions in arbitrary namespaces. The `$app:` prefix reserves one — `$app:automation_lab` expands to `app--407236050945--automation_lab`. The access-denied message names both the namespace and the resource type as requirements without indicating which is missing.

**App-namespaced metafields are invisible in the admin.** Merchant-defined fields in `custom` appear in the product editor and are editable; `$app:`-namespaced fields do not appear at all. Correct for machine-written state like sync timestamps, wrong for anything a merchant needs to manage. The namespace choice is a decision about data ownership, not naming.

**`metafieldsSet` is an upsert.** Verified by writing an identical payload twice across 17 products: all 17 metafield IDs were unchanged and no duplicates created. It matches on `ownerId` + `namespace` + `key`. `metafieldDefinitionCreate` is a create and offers no such guarantee — a replayed call fails with "namespace and key already in use," which is the correct loud failure.

**Granted scopes and declared scopes drift.** A version release changes what an app declares; the installation keeps the grant it was authorized under. Reads worked normally while every mutation was denied. `currentAppInstallation.accessScopes` is the ground truth.

## Measured behaviour

Recorded against a Plus development store: 20,000-point bucket, 1000/sec restore. Catalog of 2,037 products / 6,096 variants.

| Workload | Result |
|---|---|
| 2,000 products created (`productSet`, concurrency 4) | 8m 20s, 0 failures, bucket never below 19,814 |
| Full read, `PAGE_SIZE=2` | 1,019 pages, 8m 51s |
| Full read, `PAGE_SIZE=250` | 9 pages, 6.2s, bucket 19,976 |
| Full read, Bulk Operations | 6.2s to complete + 2.2s to parse, bucket 20,000 |
| Observed query cost | 7–20 points depending on depth |

**Bulk and paginated exports agree exactly** — 2,037 products, 1,866 ACTIVE / 1 ARCHIVED / 170 DRAFT, 679 tracked inventory. Two independent implementations producing identical results is stronger evidence than either running without error.

**At this scale bulk offers no speed advantage.** Both complete in about six seconds. Its benefit is the shape of the curve, not the constant: pagination is linear in round trips (20,000 products = 80 requests) while bulk is one submission regardless. It also consumes almost no rate limit — the bucket finished at full capacity, versus nine requests' worth spent by pagination.

**The rate limiter has still never triggered.** At concurrency 4 with ~17-point mutations at ~250ms each, spend was roughly 272 points/sec against a 1000/sec restore rate — refill outpaced consumption nearly 4×. Neither 2,000 concurrent mutations nor 1,019 sequential reads produced a single wait. `suggestedConcurrency()` returned its hardcoded ceiling of 20 throughout, never a bucket-derived figure.

On a Basic-plan store (100 points, 50/sec) the same workload would throttle within the first two products.

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

1. **Concurrency ceiling is arbitrary.** `suggestedConcurrency()` derives a rate from `restoreRate ÷ estimatedCost` but caps at 20. The uncapped figure on this store is around 60. The cap, not the bucket, has been the binding constraint in every run to date.

2. **Cost estimates are catalog-size dependent.** Observed cost ranged from 7 to 20 points depending on query depth. Actual cost scales with returned nodes, so no figure here is a constant.

3. **The rate limiter is untested under real pressure.** See *Measured behaviour* — no workload so far has come close to draining the bucket. The waiting path has never executed against a genuine limit, only against a stubbed 429.

4. **Single store per process.** `getConfig()` memoizes into module scope and `shopify.ts` exports one shared limiter instance. `RateLimiter` is a class and would need no changes; the config layer would.

5. **No adaptive backoff on repeated throttling.** A sustained throttle is retried with the same computed wait each time, with no escalation.

6. **Non-idempotent failures require manual reconciliation.** A create that fails after the write reached Shopify is not retried, by design — but nothing records the ambiguity for a human to resolve. A production system would log the attempt with a correlation ID before sending.

7. **No scope preflight.** Scripts discover missing permissions when a mutation is denied mid-run. `check-scopes.ts` exists but must be run manually.

8. **Nested connection depth is fixed outside bulk queries.** `inventoryLevels(first: 20)`, `variants(first: 10)`, and `metafields(first: 10)` are hardcoded in the paginated scripts. Bulk queries have no such constraint and return every nested node, so this only affects code not yet moved to bulk.

9. **Teardown has a check-then-act race.** `collectIds()` and the delete loop are separate steps. Any product created between them is absent from the collected list and survives, while the script reports complete success. Observed by accidentally running generate and teardown concurrently — teardown reported `Deleted: 2, Failed: 0` and left a product behind.

10. **Generated products have no inventory.** `productSet` sets `tracked: true` but never creates inventory levels, so all 2,000 generated products show 0 in stock. Fine for read and pagination testing, useless for inventory logic testing — `inventory-report.ts` is still only exercised against the 17 seeded products.

11. **Bulk error paths are untested.** `FAILED`, `EXPIRED`, and `partialDataUrl` handling is written but has never executed — every run has completed cleanly. The timeout path is likewise unexercised.

12. **No persistence.** Results are printed to stdout and discarded.

13. **No tests.** Failure paths were verified manually: breaking credentials, pointing `SHOP_DOMAIN` at an unresolvable host, stubbing a 429, placing an unfulfilled order to force committed stock, and running every script twice to exercise both branches.

## Resolved

- ~~No token invalidation on 401~~ — a rejected token now clears the cache and retries.
- ~~Concurrency limit is hardcoded~~ — now derived from observed cost and restore rate.
- ~~Throttle reporting understates pressure~~ — replaced by a limiter that extrapolates rather than trusting the last reading.
- ~~`totalInventory` audit passed vacuously~~ — retested with committed stock present; the relationship holds and is documented.
- ~~`retry.ts` is unsafe for mutations~~ — retry is now opt-in per operation, driven by explicit idempotency classification.
- ~~Read-only~~ — write path implemented with `userErrors` handling and idempotency proven empirically.
- ~~Catalog too small to test at scale~~ — 2,000 generated products with 6,014 variants.
- ~~No bulk export~~ — implemented with JSONL streaming and verified against the paginated implementation.

## Roadmap

- Postgres persistence via Prisma
- Fulfillment orders and location routing
- Webhook receiver with HMAC verification and idempotent handlers