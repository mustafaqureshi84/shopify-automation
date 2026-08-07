# Shopify Automation Lab

A learning project for building reliable Shopify integrations against the GraphQL Admin API. The focus is not "make a request work" — it's what a request needs around it to run unattended: runtime validation, typed errors, retry with backoff, adaptive rate limiting, and meaningful exit codes.

## Stack

- **TypeScript** (strict, ESM, `nodenext`)
- **tsx** for running TypeScript directly
- **Zod** for runtime validation
- **Shopify GraphQL Admin API** `2026-07` (REST is legacy and not used)
- **OAuth client credentials** for authentication

## Setup

### Prerequisites

- Node.js 22 LTS
- A Shopify Partner account
- A development store created from the Dev Dashboard

### Create the app

1. In the Dev Dashboard, create an app via **Start from Dev Dashboard**
2. Set these scopes: `read_customers`, `read_inventory`, `read_locations`, `read_orders`, `read_products`
3. Leave **Embed app in Shopify admin** unchecked — this app has no UI
4. Leave **Use legacy install flow** unchecked (managed installation)
5. Release the version, then install the app on your store

Permanent `shpat_` tokens are no longer issued from the Shopify admin. Tokens are requested at runtime via the client credentials grant and are valid for 24 hours.

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
npx tsx src/first-query.ts       # minimal single query — 10 products
npx tsx src/export-products.ts   # full catalog via cursor pagination
npx tsx src/async-patterns.ts    # concurrency benchmark, 4 strategies
npx tsx src/inventory-report.ts  # per-location stock, quantity-name audit
```

`export-products.ts` accepts `PAGE_SIZE` to control page size:

```bash
PAGE_SIZE=250 npx tsx src/export-products.ts
```

## Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | Reads and validates env vars; memoized, throws `ConfigError` naming every missing variable |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter; `RetryExhaustedError` |
| `src/exit.ts` | Maps any thrown error to a log line and exit code |
| `src/rate-limiter.ts` | Leaky-bucket model; gates requests, tracks cost, derives concurrency |
| `src/shopify.ts` | Transport layer — the only file that calls `fetch` |
| `src/paginate.ts` | Generic cursor-pagination async generators |
| `src/types.ts` | Zod schemas; TypeScript types derived via `z.infer` |
| `src/first-query.ts` | Script: minimal query example |
| `src/export-products.ts` | Script: paginated catalog export |
| `src/async-patterns.ts` | Script: concurrency benchmark |
| `src/inventory-report.ts` | Script: location and inventory-level traversal |

Dependencies flow one direction. `types.ts` and `errors.ts` have no dependencies; scripts sit at the top.

## Design notes

### Engineering

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions — types are a consequence of validation rather than a promise to the compiler.

**Retry decisions are status-based, not text-based.** 429 and 5xx retry; 4xx does not. Shopify's error pages contain reassuring prose like "this store will be right back" even for stores that never existed, so response body text is not used to decide retryability.

**`Retry-After` overrides local backoff.** When the server states when to retry, that instruction wins over the exponential curve.

**Backoff includes jitter.** Delays land between roughly 85% and 115% of target so concurrent failures don't retry in lockstep.

**Token caching expires early.** A 300-second safety margin is subtracted from the token lifetime to avoid a token expiring between the validity check and the request reaching Shopify. A 401 mid-run invalidates the cache and retries.

**`THROTTLED` arrives as HTTP 200.** Shopify returns rate-limit rejections in the GraphQL `errors` array with a normal status code, so `res.ok` checks miss them entirely. They are detected by inspecting the response body and converted into a retryable error carrying a computed wait.

**Rate limiting is adaptive, not configured.** The limiter reads `throttleStatus` from every response, extrapolates refill from elapsed time, and reserves points before admitting a request. Concurrency is derived as `restoreRate ÷ estimatedCost` rather than hardcoded. A 20% reserve is held back so this client doesn't starve other processes sharing the same store's bucket.

**Cost estimation biases toward the peak.** The estimate is the midpoint of the mean and maximum observed cost, because underestimating causes throttles while overestimating only costs a little throughput.

**Nested connections truncate silently.** `inventoryLevels(first: 20)` inside a paginated variant query cannot itself be paginated by the outer generator. A variant stocked at more than 20 locations would be under-reported with no error. `inventory-report.ts` counts these cases explicitly rather than assuming they don't occur.

### Shopify data model

Findings verified against a live development store, not taken from documentation.

**Inventory does not live on a variant.** The chain is `ProductVariant → InventoryItem → InventoryLevel → Location`. A variant has one level per location. `variant.inventoryQuantity` is a convenience sum and returns `null` when tracking is disabled.

**Untracked variants are not zero-stock variants.** A variant with `inventoryItem.tracked === false` has no levels at all. Treating it as `0` in a sync would overwrite a downstream system with a number meaning "none" when the truth is "unknown."

**Quantity names are not interchangeable.** Verified by placing an unfulfilled test order: one unit moved from `available` while `on_hand` stayed constant and `committed` rose to 1. The same physical unit is simultaneously on the shelf, unsellable, and owed to a customer. Syncing `on_hand` to a sales channel oversells; syncing `available` to a warehouse system reports a phantom discrepancy at every stock count.

**`totalInventory` reflects `available`, not `on_hand`.** Confirmed under the committed-stock condition above — the product total tracked the drop in `available` and the audit still reconciled. It is a safe sum-of-available shortcut and an unsafe measure of physical stock, despite the name.

**Location capability constrains usable inventory.** The test store holds 50 units at a location flagged `shipsInventory: false`. Summing `available` across all locations overstates fulfillable stock by that amount. Any "can we ship this" calculation must filter on `shipsInventory` and `fulfillsOnlineOrders` before summing.

**Deactivated locations still hold stock.** `locations` omits inactive locations unless `includeInactive: true` is passed, so inventory at a closed warehouse silently disappears from a naive query.

**Top-level `productVariants` avoids nesting cost.** 17 products expand to 26 variants. Querying variants nested inside products multiplies query cost and truncates at the inner connection limit; the flat connection does neither.

## Exit codes

Following the `sysexits` convention so a scheduler can distinguish failure classes without parsing logs.

| Code | Meaning |
|---|---|
| 0 | Success |
| 70 | API error — GraphQL errors, unexpected response shape, non-retryable HTTP failure |
| 75 | Temporary failure — retries exhausted, or a retryable auth error |
| 77 | Permission denied — credentials rejected; retrying will not help |
| 78 | Configuration error — missing or invalid environment variables |
| 1 | Unexpected error |

## Known limitations

1. **Concurrency ceiling is arbitrary.** `suggestedConcurrency()` derives a rate from `restoreRate ÷ estimatedCost` but caps the result at 20. On a Plus store the uncapped figure is around 90, so the cap — not the bucket — is the binding constraint. The number was chosen for safety, not measured.

2. **Cost estimates are catalog-size dependent.** Observed cost ranged from 11 to 20 points depending on query depth, against a 17-product store. Actual cost scales with returned nodes, so the same queries against a 4,000-product catalog cost substantially more. The limiter adapts, but no figure recorded here is a constant.

3. **Only tested against a Plus development store.** That store has a 20,000-point bucket restoring at 1000/sec. A Basic-plan store has 100 points at 50/sec. Benchmarks used under 3% of available capacity, so throttling has never been exercised against a real limit — only against a simulated one.

4. **Single store per process.** `getConfig()` memoizes into module scope and `shopify.ts` exports one shared limiter instance, so this cannot talk to two shops in one run. `RateLimiter` is a class and would need no changes; the config layer would.

5. **No adaptive backoff on repeated throttling.** A sustained throttle is retried with the same computed wait each time. There is no escalation if the store is under pressure from another client.

6. **`retry.ts` is unsafe for mutations.** `withRetry` wraps every request indiscriminately. All current operations are reads, which are naturally idempotent, so this has not caused a problem. A retried write without an idempotency key could duplicate data.

7. **Read-only.** No mutations are performed and no write scopes are requested.

8. **Nested connection depth is fixed.** `inventoryLevels(first: 20)` and `variants(first: 10)` are hardcoded. Stores exceeding those limits are under-reported; the count is surfaced but not handled.

9. **No persistence.** Results are printed to stdout and discarded.

10. **No tests.** Failure paths were verified manually by breaking credentials, pointing `SHOP_DOMAIN` at an unresolvable host, stubbing a 429 response, and placing an unfulfilled order to force committed stock.

## Resolved

- ~~No token invalidation on 401~~ — a rejected token now clears the cache and retries.
- ~~Concurrency limit is hardcoded~~ — now derived from observed cost and restore rate.
- ~~Throttle reporting understates pressure~~ — replaced by a limiter that extrapolates rather than trusting the last reading.
- ~~`totalInventory` audit passed vacuously~~ — retested with committed stock present; the relationship holds and is now documented.

## Roadmap

- Metafields and metaobjects; first mutations and idempotency
- Fulfillment orders and location routing
- Bulk Operations for large catalogs
- Postgres persistence via Prisma
- Webhook receiver with HMAC verification and idempotent handlers