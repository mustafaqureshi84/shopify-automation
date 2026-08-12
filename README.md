# Shopify Automation Lab

A learning project for building reliable Shopify integrations: a batch sync layer against the GraphQL Admin API, and an event-driven layer receiving webhooks. The focus is not "make a request work" — it's what a request needs around it to run unattended: runtime validation, typed errors, retry with backoff, adaptive rate limiting, idempotent writes, persistence with change detection, durable queues, and meaningful exit codes.

## Stack

- **TypeScript** (strict, ESM, `nodenext`)
- **tsx** for running TypeScript directly
- **Zod v4** for runtime validation
- **Prisma 7** + **Postgres** (Neon) for persistence
- **BullMQ** + **Redis** (Upstash) for the webhook queue
- **Hono** for the HTTP receiver
- **cloudflared** quick tunnels for local webhook delivery
- **Shopify GraphQL Admin API** `2026-07` (REST is legacy and not used)
- **OAuth client credentials** for authentication

## Setup

### Prerequisites

- Node.js 22 LTS
- A Shopify Partner account
- A development store created from the Dev Dashboard
- A Postgres database (Neon free tier is sufficient)
- A Redis database (Upstash free tier is sufficient)
- `cloudflared` for tunnelling, if receiving webhooks locally

### Create the app

1. In the Dev Dashboard, create an app via **Start from Dev Dashboard**
2. Set these scopes: `read_customers`, `read_inventory`, `write_inventory`, `read_locations`, `read_orders`, `read_products`, `write_products`
3. Leave **Embed app in Shopify admin** unchecked — this app has no UI
4. Leave **Use legacy install flow** unchecked (managed installation)
5. Release the version, then install the app on your store

Permanent `shpat_` tokens are no longer issued from the Shopify admin. Tokens are requested at runtime via the client credentials grant and are valid for 24 hours.

**Scope changes require reinstalling the app.** Releasing a new version updates the app's declared scopes, but an existing installation retains the grant it was authorized under, and tokens are issued against the installation. Every write script asserts its required scopes at startup and exits 77 with the missing list.

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
REDIS_URL=
```

`SHOP_DOMAIN` is the full `.myshopify.com` domain with no protocol. `DATABASE_URL` should end in `?sslmode=verify-full` — `require` is currently an alias for it but will adopt weaker libpq semantics in `pg` v9. `REDIS_URL` must be the `rediss://` TCP form, not Upstash's REST URL: BullMQ uses blocking commands that need a persistent socket, which HTTP cannot provide. `.env` is gitignored and must stay that way.

## Scripts

### Batch layer

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
npx tsx src/test-flow-trigger.ts   # set one variant's on_hand by SKU, printing before/after
npx tsx src/teardown-products.ts   # delete ALL generated data (requires CONFIRM=yes)
```

### Event layer

Four processes, in separate terminals:

```bash
# 1. tunnel — exposes localhost:3000 publicly
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000

# 2. receiver — verifies HMAC, enqueues, responds
npx tsx src/webhook-server.ts

# 3. worker — consumes the queue
npx tsx src/worker.ts

# 4. everything else
npx tsx src/register-webhooks.ts   # subscribe topics (needs TUNNEL_URL)
npx tsx src/queue-monitor.ts       # queue counts and failed jobs (RETRY=yes to replay)
npx tsx src/test-webhook.ts        # simulate a delivery locally (MODE=valid|wrong-secret|tampered|missing)
npx tsx src/test-redis.ts          # verify the Redis connection
```

### Environment overrides

```bash
LIMIT=5                            # sample mode — process N items and stop
PAGE_SIZE=250                      # export-products.ts page size
COUNT=2000 START_AT=21 SEED=42     # generate-products.ts
SEED=7                             # populate-inventory.ts distribution
SKU=AL-00500-0 TO=5                # test-flow-trigger.ts
CONFIRM=yes                        # teardown-products.ts safety gate
TUNNEL_URL=https://x.trycloudflare.com   # register-webhooks.ts
MODE=tampered                      # test-webhook.ts
RETRY=yes                          # queue-monitor.ts — replay failed jobs
FAIL_MODE=always|once|slow         # worker.ts — inject failures for testing
```

`LIMIT` exists because two twenty-minute runs died on mutation shapes a five-item sample would have caught in seconds. Use it whenever a write script changes.

**PowerShell note:** `$env:VAR` persists for the terminal session only. A stale `PAGE_SIZE=2` turned a 6-second export into a 9-minute one more than once.

## Structure

| File | Responsibility |
|---|---|
| `src/constants.ts` | Shared values. No imports, no side effects, safe to import anywhere |
| `src/config.ts` | Reads and validates Shopify env vars; memoized, throws `ConfigError` |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter; `RetryExhaustedError` |
| `src/exit.ts` | `describeError` renders any thrown value; `handleFatal` adds the exit code |
| `src/preflight.ts` | `assertScopes` startup guard; `applyLimit` sample-mode convention |
| `src/rate-limiter.ts` | Leaky-bucket model; gates requests, tracks cost, derives concurrency |
| `src/shopify.ts` | Transport layer — the only file that calls `fetch` |
| `src/mutations.ts` | Write path: `userErrors` handling, idempotency classification, `requireData` |
| `src/paginate.ts` | Generic cursor-pagination async generators |
| `src/bulk.ts` | Bulk Operations lifecycle: submit, poll, stream JSONL, group by parent |
| `src/db.ts` | Prisma client singleton with driver adapter — only file importing generated code |
| `src/queue.ts` | Redis connection and BullMQ queue definition; retry policy lives here |
| `src/webhook-verify.ts` | HMAC verification. Pure crypto, no HTTP, testable in isolation |
| `src/types.ts` | Zod schemas; TypeScript types derived via `z.infer` |
| `src/webhook-server.ts` | Long-running: verifies signatures, enqueues, responds in ms |
| `src/worker.ts` | Long-running: consumes the queue, processes jobs, handles failures |
| `src/register-webhooks.ts` | Script: subscription management — deletes stale, creates current |
| `src/queue-monitor.ts` | Script: queue counts, failed job inspection, replay |
| `src/test-webhook.ts` | Script: simulates Shopify delivery, correctly or deliberately wrong |
| `src/test-redis.ts` | Script: Redis connection diagnostic |
| `src/check-scopes.ts` | Script: granted vs declared scopes diagnostic |
| `src/test-flow-trigger.ts` | Script: isolates one inventory change for testing downstream reactions |
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

**Shopify GID is the primary key.** A surrogate key would cost a lookup on every upsert and buys nothing until a second store exists. Multi-store is handled by the `shopDomain` column already present, which can be promoted to a composite unique constraint `(shopDomain, gid)` later without restructuring relationships.

**`sku` is indexed but not unique.** Shopify does not enforce SKU uniqueness, and a constraint here would reject data that legitimately exists — 23 seeded variants have no SKU at all. Constraints must match the source system's actual guarantees, not the ones you wish it had.

**Soft deletes via `deletedAt`.** A hard delete discards the fact that something once existed and when it vanished. A full catalog replacement marked 2,000 rows deleted; that history would otherwise be gone.

**`lastSeenAt` is the deletion mechanism.** Every row touched by a run is stamped with that run's start time. Anything still holding an older timestamp was absent from the snapshot.

**Money is `Decimal(12,2)`, never `Float`.** Binary floating point cannot represent 0.1 exactly.

## Design notes

### Engineering

**Script modules must never be imported.** A file ending in `main().catch(...)` executes on import in ESM. `teardown-products.ts` imported `GENERATED_TAG` from `generate-products.ts` and thereby launched a full 2,000-product generation on every single run — silently, interleaved with its own output. The symptom looked exactly like operator error and was misdiagnosed as such for hours. Shared values now live in `constants.ts`.

**When the same "user error" recurs repeatedly, it usually isn't user error.**

**A negative result only means something once the boring explanations are ruled out.** Two separate wrong conclusions in this project came from a plausible story arriving before the evidence justified it.

**Fail fast on missing permissions.** `assertScopes` costs one API call at startup. It replaced two failed runs — nine and twenty minutes — that were never going to succeed.

**Batch database writes into single statements.** 500 individual `prisma.upsert()` calls inside one transaction is 500 sequential round trips — about 5.7 seconds against a remote database, exceeding Prisma's 5-second transaction timeout. Rewritten as one `INSERT ... ON CONFLICT DO UPDATE` per batch, the full 2,017-product catalog writes in 9 seconds. **When a timeout fires, ask why the work is slow before making the deadline longer.**

**Raw SQL is parameterised via `Prisma.sql` and `Prisma.join`.** Every value becomes a bound parameter. Template literals with `.join(',')` would be an injection hole, and product titles are merchant-controlled text.

**Change detection compares against a snapshot loaded up front.** One `findMany` into a `Map` rather than 2,017 individual existence checks.

**Sync runs are recorded, including failures.** A crash that leaves no trace makes "did it run last night" unanswerable.

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions.

**Three separate error channels.** HTTP status, the GraphQL `errors` array, and mutation `userErrors`. A mutation rejected by a business rule returns HTTP 200 with no `errors` array.

**Errors are checked before shape.** A rejected request frequently returns `null` data *as a consequence* of the error; validating first surfaces Zod's inference instead of the API's explanation.

**Error description lives in one place.** `describeError` renders any thrown value with the detail its class carries. Call sites that write their own summaries drop the useful part — this happened twice before the logic was extracted.

**Retry decisions are status-based, not text-based.** Shopify's error pages contain reassuring prose like "this store will be right back" even for stores that never existed.

**`Retry-After` overrides local backoff.** Backoff includes jitter so concurrent failures don't retry in lockstep.

**Token caching expires early.** A 300-second safety margin avoids a token expiring in flight. A 401 mid-run invalidates the cache and retries.

**`THROTTLED` arrives as HTTP 200** in the GraphQL `errors` array, so `res.ok` checks miss it entirely.

**Rate limiting is adaptive, not configured.** The limiter reads `throttleStatus` from every response, extrapolates refill from elapsed time, and reserves points before admitting a request. A 20% reserve protects other processes sharing the bucket.

**Retry is opt-in per operation.** Idempotency is a property of the operation, not something a wrapper can add.

**Bulk writes record per-item outcomes rather than throwing.** At scale, partial success is the normal case.

**JSONL parsing must handle chunk boundaries.** Network chunks do not align with newlines.

**Generated code and type definitions are the most reliable documentation available.** The Prisma 7 constructor signature was resolved by reading a JSDoc example in the generated client after two wrong guesses — that file is produced by the exact installed version and cannot be stale.

### Webhooks and queues

**HMAC must be computed on the raw request body, before any parsing.** Parsing and re-serializing changes the bytes — whitespace, key order, number formatting — and the signature will not match. The failure presents as "Shopify is sending bad signatures," which sends people hunting in entirely the wrong place. The receiver reads `c.req.text()`, never `c.req.json()`.

**Signature comparison uses `timingSafeEqual`, not `===`.** A normal string comparison exits at the first differing byte, so its duration leaks how many leading bytes were correct — enough to reconstruct a valid signature one byte at a time. Constant-time comparison removes the signal.

**HMAC provides integrity, not just authentication.** Verified by signing a payload correctly and then altering one field in transit: the `tampered` test case sends a real signature with `total_price` changed from `750.00` to `0.01` and is rejected. Checking *who sent it* is insufficient when the request crosses networks you do not control.

**Acknowledge before processing.** Shopify's delivery timeout is a few seconds. Work done before responding risks a failed delivery, a retry, and duplicates on top of a slow handler. The receiver verifies, enqueues, and returns 200 in around 100ms; all processing happens in a separate worker process.

**The webhook ID is the job ID.** `X-Shopify-Webhook-Id` is stable across redeliveries of the same event, and BullMQ refuses to add a job whose ID already exists. A redelivery is therefore silently dropped — while still returning 200, because refusing it would make Shopify retry harder.

**Deduplication lasts only as long as job retention.** With `removeOnComplete: { age: 3600 }`, a redelivery within an hour of the original is ignored; after that the ID is gone and the work would repeat. The retention window *is* the deduplication guarantee, and it is a configuration decision rather than a property of the queue.

**A crashed worker's jobs are owned by nobody.** Workers hold a lock on each job and renew it on a heartbeat; Redis cannot distinguish a dead process from a slow one. After `stalledInterval` without renewal the job is reclaimed and requeued — verified by hard-killing a worker mid-job and watching another pick it up 57 seconds later. Without this, every crash silently loses in-flight work, and nobody finds out because Shopify was acknowledged long ago.

**Stall reclaim does not count as a retry.** The reclaimed job resumed at `attempt 1`. A crash should not consume one of the handler's five attempts, because nothing actually failed.

**Graceful shutdown waits for in-flight jobs.** `SIGINT` calls `worker.close()` rather than exiting immediately, so a job halfway through a database write completes instead of being abandoned. This is what makes a worker safe to restart during a deploy — and it is also why testing crash recovery requires a hard kill rather than Ctrl+C.

**Long jobs get reclaimed while still running.** A handler that exceeds the lock duration will be treated as stalled and processed concurrently by another worker. Long work needs `job.extendLock()` on a heartbeat, or a longer lock. **At-least-once is the queue's guarantee too, not only Shopify's.**

### Shopify data model

Findings verified against a live development store, not taken from documentation.

**Inventory does not live on a variant.** The chain is `ProductVariant → InventoryItem → InventoryLevel → Location`.

**Setting `tracked: true` does not create inventory levels.** An item must be activated at a location via `inventoryActivate` before any quantity can be set there.

**Untracked variants are not zero-stock variants.** No levels at all. Treating it as `0` would overwrite a downstream system with a number meaning "none" when the truth is "unknown."

**Quantity names are not interchangeable.** Verified with an unfulfilled test order: one unit moved from `available` while `on_hand` stayed constant and `committed` rose to 1.

**`on_hand` is settable; `available` is derived** as `on_hand − committed`.

**`totalInventory` reflects `available`, not `on_hand`.**

**Location capability is a filter, not metadata.** 38,312 of 234,204 units sit at a `shipsInventory: false` location — 16% of stock, real but unfulfillable online.

**Deactivated locations still hold stock.** `locations` omits them unless `includeInactive: true`.

**Shopify does not enforce SKU uniqueness.** Handles are auto-deduplicated; SKUs are not.

**`userError` payload types differ per mutation.** `productCreate` and `productDelete` return plain `UserError`; `productSet` and `metafieldsSet` carry `code`; `inventoryActivate` has **no** `userErrors` field. Requesting a field that doesn't exist fails at query *validation*.

**Inventory mutations require an explicit `@idempotent` directive.** Both `inventoryActivate` and `inventorySetQuantities` reject requests without `@idempotent(key: $key)`. Shopify enforces at the protocol level the same distinction this project classifies by hand.

**`ignoreCompareQuantity` was removed in 2026-04.** Compare-and-swap moved to a per-quantity `changeFromQuantity`; `null` explicitly opts out, and the field must always be present.

**Two sequential mutations have no transaction.** `productSet` with `synchronous: true` is atomic where `productCreate` + `productVariantsBulkCreate` is not.

**Bulk queries use a different dialect.** `edges { node { } }` required; nested connections take no `first:` and return everything.

**`objectCount` counts JSONL lines, not records.**

**Metafield definitions require namespace ownership.** The `$app:` prefix reserves one. App-namespaced metafields are invisible in the admin — correct for machine state, wrong for merchant-managed data.

**`metafieldsSet` is an upsert**, matching on `ownerId` + `namespace` + `key`.

**Granted scopes and declared scopes drift.** Reads worked normally while every mutation was denied. `currentAppInstallation.accessScopes` is ground truth.

**Deletion produces no event.** A product removed from Shopify simply stops appearing in exports. An incremental sync filtering on `updatedAt` can never detect it. Full-snapshot sync plus `lastSeenAt` is the only way to answer "what is no longer here."

**Webhook subscription is gated separately from API scope.** `ORDERS_CREATE` is rejected with "not approved to subscribe to webhook topics containing protected customer data" even with `read_orders` granted. Reading orders via the API and receiving order webhooks are different permissions with different approval processes.

**`products/update` fires on inventory changes.** The topic covers the product as an aggregate — variants and their stock included — so a store syncing inventory generates high volume on a topic whose name suggests otherwise. Most of those payloads contain nothing a product mirror cares about, which is why the handler compares against stored values before writing.

**Quick tunnels are ephemeral.** `cloudflared`'s account-less tunnels have no uptime guarantee, expire on idle, and issue a new URL on every restart. Each session therefore requires restarting the tunnel and re-registering subscriptions; `register-webhooks.ts` deletes before creating, because otherwise subscriptions accumulate pointing at dead endpoints and Shopify retries deliveries into the void.

### Shopify Flow

**Flow triggers fire identically for admin edits and API writes.** Verified on both `Product created` (via `productSet`) and `Product variant inventory quantity changed` (via `inventorySetQuantities`). There is no admin-only behaviour.

An earlier conclusion that inventory triggers ignored API changes was wrong, and the reasoning behind the error is worth keeping. A batch of ~60 API inventory writes produced zero workflow runs while a manual admin edit fired immediately — which looked like clear evidence of an API blind spot. The real cause was that the workflow used an edge-triggered condition, `inventoryQuantityPrior >= 10 AND inventoryQuantity < 10`, and no write in that randomly-distributed sample crossed the threshold from above. **Zero runs was correct behaviour, not a missing trigger.**

Confirmed by isolating a single write: one variant taken from 21 to 5 fired the workflow immediately. `test-flow-trigger.ts` exists to make that kind of isolation cheap, printing the before-state alongside the change so a non-result cannot be mistaken for a failure.

**Edge-triggered conditions are the right pattern for threshold alerts.** Checking only `quantity < 10` fires on every subsequent change while the item stays low; adding the prior-value check fires once, on the transition.

**Flow can generate synthetic test events, including negative cases.** A workflow that fires when it should is half-verified; one that also stays quiet when it shouldn't is verified.

### Prisma 7 specifics

**The client no longer bundles a database driver.** `new PrismaClient()` requires a driver adapter — `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`. `datasourceUrl` and `datasources` no longer exist.

**`prisma.config.ts` configures the CLI only.** The runtime connection is established in application code.

**The generated client is TypeScript source at a configured `output` path.** It is gitignored and rebuilt by `prisma generate`; `prisma/migrations/` is committed.

**`migrate dev` does not always emit the client.** Run `prisma generate` explicitly.

## Measured behaviour

Plus development store: 20,000-point bucket, 1000/sec restore. Catalog of 2,017 products / 6,040 variants / 234,274 units.

### Batch layer

| Workload | Result |
|---|---|
| 2,000 products via `productSet`, concurrency 4 | 8m 47s, 0 failures |
| 6,014 variants activated + quantities set, concurrency 6 | 20m 10s, 0 failures |
| 4,053 products deleted | 2m 38s, 0 failures |
| Full read, `PAGE_SIZE=250` | 9 pages, 6.2s |
| Full read, Bulk Operations | 6.2s + 2.2s parse, bucket stayed at 20,000 |
| Full sync to Postgres, initial load | 2,017 created + 6,040 variants in 9.0s |
| Full sync, no changes | 2,017 unchanged in 12.3s |
| Full sync, complete catalog replacement | 2,000 created, 17 unchanged, 1,999 + 6,012 deleted in 10.7s |
| Query cost | 7–51 points depending on depth |

**Four independent implementations agree exactly** on 2,017 products: paginated export, bulk export, inventory report, and the Postgres mirror.

**The rate limiter has never triggered.** The bucket never dropped below 19,800 in any run. On a Basic-plan store (100 points, 50/sec) the same workload would throttle within the first two products.

### Event layer

| Path | Result |
|---|---|
| Receipt → verified → enqueued | 68–250ms |
| Enqueue → worker pickup | 170–420ms |
| Valid signature | 200, job queued |
| Wrong secret / tampered body / missing header | 401, nothing queued |
| Redelivery with same webhook ID | 200 returned, job silently dropped |
| Exponential backoff across 5 attempts | 160ms → 2.5s → 6.9s → 15.1s → 31.4s, then `[DEAD]` |
| Transient failure (`FAIL_MODE=once`) | recovered on attempt 2, ~2.4s later |
| Dead-letter replay | job resumed after 178s in the failed set, across a worker restart |
| Hard-killed worker mid-job | stall detected, requeued, completed 57s after receipt at `attempt 1` |

**Every failure path has been exercised**, not assumed: retry recovery, backoff escalation, dead-lettering, replay, and stalled-job reclaim.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 65 | Data error — a mutation was rejected via `userErrors` |
| 70 | API error — GraphQL errors, unexpected response shape, non-retryable HTTP failure |
| 75 | Temporary failure — retries exhausted, or a retryable auth error |
| 77 | Permission denied — credentials rejected or a required scope not granted |
| 78 | Configuration error — missing or invalid environment variables |
| 1 | Unexpected error |

## Known limitations

1. **Handlers are not explicitly idempotent.** Queue-level deduplication stops duplicate *jobs*, but a job that fails partway and retries still repeats whatever it already did. The current handler happens to be safe because a primary-key update is naturally idempotent; a multi-step handler would not be. No processed-event table exists.

2. **Concurrency ceiling is arbitrary.** Capped at 20; the uncapped figure on this store is around 60.

3. **The rate limiter is untested under real pressure.** The waiting path has never executed against a genuine limit, only a stubbed 429.

4. **Idempotency keys are random per call, not derived.** `randomUUID()` means a retried request sends a *different* key, so Shopify's server-side deduplication never actually engages.

5. **Single store per process.** `getConfig()` memoizes into module scope and `shopify.ts` exports one shared limiter.

6. **Sync is full-snapshot only.** Correct, and the only way to detect deletions, but a 500,000-product store would want incremental updates with periodic full reconciliation.

7. **Inventory levels are not persisted.** The database cannot answer the fulfillability question `inventory-report.ts` can.

8. **Only one webhook topic is subscribed.** `products/update` alone. Order topics require protected customer data approval.

9. **The receiver has no rate limiting or body size cap.** A public endpoint accepting arbitrary POST bodies with no upper bound is a denial-of-service surface, even though invalid signatures are rejected.

10. **Failed jobs are not alerted on.** The dead-letter queue must be inspected manually via `queue-monitor.ts`. Nothing notifies anyone that a job died.

11. **Teardown cannot distinguish test data from real data.** Every generated product carries the same tag, so removing three sample products removes all two thousand.

12. **Teardown has a check-then-act race.** Anything created between `collectIds()` and the delete loop survives while the script reports success.

13. **Nested connection depth is fixed outside bulk queries.**

14. **Bulk error paths are untested.** `FAILED`, `EXPIRED`, `partialDataUrl`, and timeout handling have never executed.

15. **No automated tests.** Everything has been verified manually — broken credentials, unresolvable hosts, stubbed 429s, committed stock, catalog replacement, a fake required scope, four webhook signature modes, and injected worker failures — but none of it is repeatable without a human.

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
- ~~No persistence~~ — Postgres mirror with create, update, and delete detection.
- ~~No scope preflight~~ — every write script asserts required scopes and exits 77 in about two seconds.
- ~~No dry-run or sample mode~~ — shared `LIMIT` convention across write scripts.
- ~~Flow inventory triggers appear blind to API writes~~ — false; the edge-triggered condition simply wasn't satisfied by the test data.
- ~~No real-time events~~ — webhook receiver with HMAC verification, durable queue, and every failure path tested.

## Roadmap

- Idempotent handlers with a processed-event table
- Order → ERP middleware as an integration project
- Persist inventory levels per location
- Alerting on dead-lettered jobs
- Incremental sync with periodic full reconciliation