# Shopify Automation Lab

A learning project for building reliable Shopify integrations against the GraphQL Admin API. The focus is not "make a request work" — it's what a request needs around it to run unattended: runtime validation, typed errors, retry with backoff, adaptive rate limiting, idempotent writes, persistence with change detection, and meaningful exit codes.

## Stack

- **TypeScript** (strict, ESM, `nodenext`)
- **tsx** for running TypeScript directly
- **Zod v4** for runtime validation
- **Prisma 7** + **Postgres** (Neon) for persistence
- **Shopify GraphQL Admin API** `2026-07` (REST is legacy and not used)
- **OAuth client credentials** for authentication

## Setup

### Prerequisites

- Node.js 22 LTS
- A Shopify Partner account
- A development store created from the Dev Dashboard
- A Postgres database (Neon free tier is sufficient)

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
npx prisma generate
npx prisma migrate deploy
```

### Environment variables

Create a `.env` file at the project root:

```
SHOP_DOMAIN=
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
DATABASE_URL=
```

`SHOP_DOMAIN` is the full `.myshopify.com` domain with no protocol. `DATABASE_URL` should end in `?sslmode=verify-full` — `require` is currently an alias for it but will adopt weaker libpq semantics in `pg` v9. `.env` is gitignored and must stay that way.

## Scripts

```bash
npx tsx src/check-scopes.ts        # what scopes does this token actually have
npx tsx src/first-query.ts         # minimal single query — 10 products
npx tsx src/export-products.ts     # full catalog via cursor pagination
npx tsx src/bulk-export.ts         # full catalog via Bulk Operations + JSONL
npx tsx src/sync-products.ts       # bulk export → Postgres, with change detection
npx tsx src/db-report.ts           # read Postgres only, no Shopify calls
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

**PowerShell note:** `$env:VAR` persists for the terminal session only. A stale `PAGE_SIZE=2` turned a 6-second export into a 9-minute one more than once.

## Structure

| File | Responsibility |
|---|---|
| `src/constants.ts` | Shared values. No imports, no side effects, safe to import anywhere |
| `src/config.ts` | Reads and validates Shopify env vars; memoized, throws `ConfigError` |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter; `RetryExhaustedError` |
| `src/exit.ts` | `describeError` renders any thrown value; `handleFatal` adds the exit code |
| `src/rate-limiter.ts` | Leaky-bucket model; gates requests, tracks cost, derives concurrency |
| `src/shopify.ts` | Transport layer — the only file that calls `fetch` |
| `src/mutations.ts` | Write path: `userErrors` handling, idempotency classification, `requireData` |
| `src/paginate.ts` | Generic cursor-pagination async generators |
| `src/bulk.ts` | Bulk Operations lifecycle: submit, poll, stream JSONL, group by parent |
| `src/db.ts` | Prisma client singleton with driver adapter — only file importing generated code |
| `src/types.ts` | Zod schemas; TypeScript types derived via `z.infer` |
| `src/check-scopes.ts` | Script: diagnostic for granted vs declared scopes |
| `src/first-query.ts` | Script: minimal query example |
| `src/export-products.ts` | Script: paginated catalog export |
| `src/bulk-export.ts` | Script: bulk catalog export, cross-checked against pagination |
| `src/sync-products.ts` | Script: bulk export into Postgres with create/update/delete detection |
| `src/db-report.ts` | Script: database state and sync run history |
| `src/async-patterns.ts` | Script: concurrency benchmark |
| `src/inventory-report.ts` | Script: location and inventory-level traversal |
| `src/metafields.ts` | Script: metafield definitions and idempotent writes |
| `src/generate-products.ts` | Script: synthetic catalog generation via atomic `productSet` |
| `src/populate-inventory.ts` | Script: inventory activation and quantity setting |
| `src/teardown-products.ts` | Script: tag-scoped deletion of generated data |

Dependencies flow one direction. `constants.ts`, `types.ts`, and `errors.ts` have no dependencies; scripts sit at the top.

## Database schema

Three tables: `Product`, `Variant`, `SyncRun`.

**Shopify GID is the primary key.** A surrogate key would cost a lookup on every upsert and buys nothing until a second store exists. Multi-store is handled by the `shopDomain` column already present, which can be promoted to a composite unique constraint `(shopDomain, gid)` in a later migration without restructuring relationships.

**`sku` is indexed but not unique.** Shopify does not enforce SKU uniqueness, and a constraint here would reject data that legitimately exists in the store. Constraints must match the source system's actual guarantees, not the ones you wish it had.

**Soft deletes via `deletedAt`.** A hard delete discards the fact that something once existed and when it vanished, which is unrecoverable if a sync run was incomplete.

**`lastSeenAt` is the deletion mechanism.** Every row touched by a run is stamped with that run's start time. Anything still holding an older timestamp was absent from the snapshot and is marked deleted.

**Money is `Decimal(12,2)`, never `Float`.** Binary floating point cannot represent 0.1 exactly.

## Design notes

### Engineering

**Script modules must never be imported.** A file ending in `main().catch(...)` executes on import in ESM. `teardown-products.ts` imported `GENERATED_TAG` from `generate-products.ts` and thereby launched a full 2,000-product generation on every single run — silently, interleaved with its own output. The symptom looked exactly like operator error and was misdiagnosed as such for hours. Shared values now live in `constants.ts`.

**When the same "user error" recurs repeatedly, it usually isn't user error.**

**Batch database writes into single statements.** 500 individual `prisma.upsert()` calls inside one transaction is 500 sequential round trips — about 5.7 seconds against a remote database, exceeding Prisma's 5-second transaction timeout. Rewritten as one `INSERT ... ON CONFLICT DO UPDATE` per batch, the full 2,017-product catalog writes in 9 seconds. **When a timeout fires, ask why the work is slow before making the deadline longer** — raising the timeout would have produced a sync that took minutes at this scale and hours at a real one.

**Raw SQL is parameterised via `Prisma.sql` and `Prisma.join`.** Every value becomes a bound parameter. Building the same statement with template literals and `.join(',')` would be an injection hole, and product titles are merchant-controlled text.

**Change detection compares against a snapshot loaded up front.** One `findMany` into a `Map` rather than 2,017 individual existence checks.

**Sync runs are recorded, including failures.** A crash that leaves no trace makes "did it run last night" unanswerable. The `SyncRun` table holds counts, duration, and the error text for failed runs.

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions — types are a consequence of validation rather than a promise to the compiler.

**Three separate error channels.** HTTP status, the GraphQL `errors` array, and mutation `userErrors`. All three must be checked. A mutation rejected by a business rule returns HTTP 200 with no `errors` array.

**Errors are checked before shape.** `requireData` inspects the `errors` array before validating structure, because a rejected request frequently returns `null` data *as a consequence* of the error.

**Error description lives in one place.** `describeError` renders any thrown value with the detail its class carries; `handleFatal` wraps it with an exit code. Call sites that write their own summaries drop the useful part — this happened twice before the logic was extracted.

**Retry decisions are status-based, not text-based.** 429 and 5xx retry; 4xx does not. Shopify's error pages contain reassuring prose like "this store will be right back" even for stores that never existed.

**`Retry-After` overrides local backoff.** Backoff includes jitter so concurrent failures don't retry in lockstep.

**Token caching expires early.** A 300-second safety margin avoids a token expiring between the validity check and the request arriving. A 401 mid-run invalidates the cache and retries.

**`THROTTLED` arrives as HTTP 200** in the GraphQL `errors` array, so `res.ok` checks miss it entirely.

**Rate limiting is adaptive, not configured.** The limiter reads `throttleStatus` from every response, extrapolates refill from elapsed time, and reserves points before admitting a request. A 20% reserve is held back so this client doesn't starve other processes sharing the bucket.

**Retry is opt-in per operation.** `mutate` sets it from an explicit `idempotency` argument. Idempotency is a property of the operation, not something a wrapper can add.

**Bulk writes record per-item outcomes rather than throwing.** One failure at item 1,400 does not abandon the rest. At scale, partial success is the normal case.

**JSONL parsing must handle chunk boundaries.** Network chunks do not align with newlines. Splitting each chunk on `\n` independently produces corrupt JSON on any file large enough to span chunks.

**Bulk results are grouped by streaming, not buffering.** Works at 2,000 products and at 500,000.

**Generated code and type definitions are the most reliable documentation available.** The Prisma 7 constructor signature was resolved by reading a JSDoc example in the generated client after two wrong guesses — that file is produced by the exact installed version and cannot be stale.

### Shopify data model

Findings verified against a live development store, not taken from documentation.

**Inventory does not live on a variant.** The chain is `ProductVariant → InventoryItem → InventoryLevel → Location`.

**Setting `tracked: true` does not create inventory levels.** An item must be activated at a location via `inventoryActivate` before any quantity can be set there.

**Untracked variants are not zero-stock variants.** No levels at all. Treating it as `0` would overwrite a downstream system with a number meaning "none" when the truth is "unknown."

**Quantity names are not interchangeable.** Verified with an unfulfilled test order: one unit moved from `available` while `on_hand` stayed constant and `committed` rose to 1.

**`on_hand` is settable; `available` is derived** as `on_hand − committed`.

**`totalInventory` reflects `available`, not `on_hand`.**

**Location capability is a filter, not metadata.** 38,312 of 234,204 units sit at a `shipsInventory: false` location — 16% of stock, real but unfulfillable online. Summing `available` across locations overstates sellable inventory.

**Deactivated locations still hold stock.** `locations` omits them unless `includeInactive: true`.

**Shopify does not enforce SKU uniqueness.** Handles are auto-deduplicated; SKUs are not. 23 seeded variants have no SKU at all.

**`userError` payload types differ per mutation.** `productCreate` and `productDelete` return plain `UserError`; `productSet` and `metafieldsSet` carry `code`; `inventoryActivate` has **no** `userErrors` field. Requesting a field that doesn't exist fails at query *validation*.

**Inventory mutations require an explicit `@idempotent` directive.** Both `inventoryActivate` and `inventorySetQuantities` reject requests without `@idempotent(key: $key)`. Shopify enforces at the protocol level the same distinction this project classifies by hand.

**`ignoreCompareQuantity` was removed in 2026-04.** Compare-and-swap moved to a per-quantity `changeFromQuantity`; `null` explicitly opts out, and the field must always be present. The unsafe path now requires deliberate repeated effort rather than one convenient flag.

**Two sequential mutations have no transaction.** `productCreate` then `productVariantsBulkCreate` leaves an orphan when the second fails. `productSet` with `synchronous: true` is atomic.

**Bulk queries use a different dialect.** `edges { node { } }` required; nested connections take no `first:` and return everything.

**`objectCount` counts JSONL lines, not records.**

**Metafield definitions require namespace ownership.** The `$app:` prefix reserves one. App-namespaced metafields are invisible in the admin — correct for machine state, wrong for merchant-managed data.

**`metafieldsSet` is an upsert**, matching on `ownerId` + `namespace` + `key`.

**Granted scopes and declared scopes drift.** Reads worked normally while every mutation was denied. `currentAppInstallation.accessScopes` is ground truth. Cost an hour twice.

**Deletion produces no event.** A product removed from Shopify simply stops appearing in exports. An incremental sync filtering on `updatedAt` can never detect it — deleted rows have no update to find. Full-snapshot sync plus `lastSeenAt` is the only way to answer "what is no longer here."

### Prisma 7 specifics

**The client no longer bundles a database driver.** `new PrismaClient()` requires a driver adapter — `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`. `datasourceUrl` and `datasources` no longer exist.

**`prisma.config.ts` configures the CLI only.** The `datasource` block in `schema.prisma` declares the provider; the runtime connection is established separately in application code.

**The generated client is TypeScript source at a configured `output` path**, not a patch to `node_modules`. It is gitignored and rebuilt by `prisma generate`; `prisma/migrations/` is committed.

**`migrate dev` does not always emit the client.** Run `prisma generate` explicitly.

## Measured behaviour

Plus development store: 20,000-point bucket, 1000/sec restore. Catalog of 2,017 products / 6,040 variants / 234,274 units.

| Workload | Result |
|---|---|
| 2,000 products via `productSet`, concurrency 4 | 8m 27s, 0 failures |
| 6,014 variants activated + quantities set, concurrency 6 | 22m 23s, 0 failures |
| 4,053 products deleted | 2m 38s, 0 failures |
| Full read, `PAGE_SIZE=250` | 9 pages, 6.2s |
| Full read, Bulk Operations | 6.2s + 2.2s parse, bucket stayed at 20,000 |
| Full sync to Postgres, first run | 2,017 created + 6,040 variants in 9.0s |
| Full sync to Postgres, second run | 2,017 unchanged in 12.3s |
| Query cost | 7–51 points depending on depth |

**Four independent implementations agree exactly** on 2,017 products: paginated export, bulk export, inventory report, and the Postgres mirror.

**Change detection verified.** Second run reports 0 created / 0 updated / 2,017 unchanged. **Deletion detection verified** by removing one product in the admin: the next run reported 2,016 seen, 1 newly deleted, 2 variants deleted, with no event from Shopify.

**The rate limiter has never triggered.** The bucket never dropped below 19,800 in any run. On a Basic-plan store (100 points, 50/sec) the same workload would throttle within the first two products.

**Retry has been exercised under genuine network failure** — multiple runs hit real connection drops and recovered.

## Exit codes

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

1. **Concurrency ceiling is arbitrary.** Capped at 20; the uncapped figure on this store is around 60. The cap, not the bucket, has been the binding constraint in every run.

2. **Cost estimates are catalog-size dependent.** Observed 7–51 points depending on query depth.

3. **The rate limiter is untested under real pressure.** The waiting path has never executed against a genuine limit, only a stubbed 429.

4. **Idempotency keys are random per call, not derived.** `randomUUID()` means a retried request sends a *different* key, so server-side deduplication never actually engages. Harmless for naturally-safe operations, wrong for anything where the key must survive a retry.

5. **Single store per process.** `getConfig()` memoizes into module scope and `shopify.ts` exports one shared limiter. The schema is multi-store ready; the config layer is not.

6. **Sync is full-snapshot only.** Every run reads the entire catalog. Correct, and the only way to detect deletions, but a 500,000-product store would want incremental updates for routine syncs and full snapshots only periodically for reconciliation.

7. **Inventory is not persisted.** `Product.totalInventory` is stored, but per-location `InventoryLevel` rows are not — so the database cannot answer the fulfillability question the inventory report can.

8. **No scope preflight.** Missing permissions surface mid-run. Cost two full runs.

9. **No dry-run or sample mode.** Two 20-minute runs died on errors a 5-variant sample would have caught in seconds.

10. **Non-idempotent failures require manual reconciliation.** Nothing records the ambiguity for a human to resolve.

11. **No adaptive backoff on repeated throttling.**

12. **Nested connection depth is fixed outside bulk queries.**

13. **Teardown has a check-then-act race.** Anything created between `collectIds()` and the delete loop survives while the script reports success.

14. **Bulk error paths are untested.** `FAILED`, `EXPIRED`, `partialDataUrl`, and timeout handling have never executed.

15. **No tests.** Failure paths verified manually: broken credentials, unresolvable hosts, stubbed 429s, an unfulfilled order to force committed stock, a deleted product to force deletion detection, and running every script twice.

## Resolved

- ~~No token invalidation on 401~~ — a rejected token now clears the cache and retries.
- ~~Concurrency limit is hardcoded~~ — derived from observed cost and restore rate.
- ~~Throttle reporting understates pressure~~ — limiter extrapolates rather than trusting the last reading.
- ~~`totalInventory` audit passed vacuously~~ — retested with committed stock present.
- ~~`retry.ts` is unsafe for mutations~~ — retry is opt-in per operation.
- ~~Read-only~~ — write path implemented with `userErrors` handling and proven idempotency.
- ~~Catalog too small to test at scale~~ — 2,017 products, 6,040 variants.
- ~~No bulk export~~ — JSONL streaming, verified against pagination.
- ~~Generated products have no inventory~~ — 234,274 units across two locations.
- ~~Scripts appear to interfere when run concurrently~~ — root cause was a module side-effect import.
- ~~No persistence~~ — Postgres mirror with create, update, and delete detection, all verified.

## Roadmap

- Persist inventory levels per location
- Fulfillment orders and location routing
- Webhook receiver with HMAC verification and idempotent handlers
- Incremental sync with periodic full reconciliation