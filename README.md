# Shopify Automation Lab

A learning project for building reliable Shopify integrations: a batch sync layer against the GraphQL Admin API, an event-driven layer receiving webhooks, and an order pipeline that pushes to an external system and reconciles against it. The focus is not "make a request work" — it's what a request needs around it to run unattended: runtime validation, typed errors, retry with backoff, adaptive rate limiting, idempotent writes, persistence with change detection, durable queues, and drift detection across system boundaries.

## Stack

- **TypeScript** (strict, ESM, `nodenext`)
- **tsx** for running TypeScript directly
- **Zod v4** for runtime validation
- **Prisma 7** + **Postgres** (Neon) for persistence
- **BullMQ** + **Redis** (Upstash) for the webhook queue
- **Hono** for the HTTP receiver and the ERP stub
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
6. For order data: **App setup → Protected customer data access**, select a data use in step 1

Permanent `shpat_` tokens are no longer issued from the Shopify admin. Tokens are requested at runtime via the client credentials grant and are valid for 24 hours.

**Scope changes require reinstalling the app.** Releasing a new version updates the app's declared scopes, but an existing installation retains the grant it was authorized under. Every write script asserts its required scopes at startup and exits 77 with the missing list.

### Install

```bash
npm install
npx prisma generate
npx prisma migrate deploy
```

### Environment variables

```
SHOP_DOMAIN=
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
DATABASE_URL=
REDIS_URL=
ERP_URL=http://localhost:4000
```

`SHOP_DOMAIN` is the full `.myshopify.com` domain with no protocol. `DATABASE_URL` should end in `?sslmode=verify-full`. `REDIS_URL` must be the `rediss://` TCP form, not Upstash's REST URL: BullMQ uses blocking commands that need a persistent socket. `.env` is gitignored and must stay that way, as is `fixtures/` — captured order payloads contain real customer email addresses.

## Running it

### Session startup — event layer

Five processes. The tunnel URL changes on every restart, so each session begins by re-registering subscriptions.

```bash
# 1. tunnel — note the new URL
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000

# 2. receiver
npx tsx src/webhook-server.ts

# 3. worker
$env:ALLOW_TEST_ORDERS="yes"; npx tsx src/worker.ts

# 4. ERP stub
npx tsx src/erp-stub.ts

# 5. re-register
$env:TUNNEL_URL="https://NEW-URL.trycloudflare.com"; npx tsx src/register-webhooks.ts
```

### Batch layer

```bash
npx tsx src/check-scopes.ts        # what scopes does this token actually have
npx tsx src/first-query.ts         # minimal single query — 10 products
npx tsx src/export-products.ts     # full catalog via cursor pagination
npx tsx src/bulk-export.ts         # full catalog via Bulk Operations + JSONL
npx tsx src/sync-products.ts       # bulk export → Postgres, with change detection
npx tsx src/db-report.ts           # read Postgres only, no Shopify calls
npx tsx src/check-product.ts       # inspect one product's mirrored state (TITLE=)
npx tsx src/async-patterns.ts      # concurrency benchmark, 4 strategies
npx tsx src/inventory-report.ts    # per-location stock, quantity-name audit
npx tsx src/metafields.ts          # definition lifecycle, mutations, idempotency proof
npx tsx src/fetch-orders.ts        # capture real orders as webhook fixtures
npx tsx src/generate-products.ts   # create synthetic catalog data
npx tsx src/populate-inventory.ts  # activate inventory and set on_hand quantities
npx tsx src/test-flow-trigger.ts   # set one variant's on_hand by SKU
npx tsx src/teardown-products.ts   # delete ALL generated data (requires CONFIRM=yes)
```

### Diagnostics and reconciliation

```bash
npx tsx src/queue-monitor.ts       # queue counts and failed jobs (RETRY=yes to replay)
npx tsx src/queue-clear.ts         # wipe queue state (requires CONFIRM=yes)
npx tsx src/erp-report.ts          # ERP push status, including unknown outcomes
npx tsx src/reconcile-erp.ts       # compare local records against the ERP (REPAIR=yes)
npx tsx src/idempotency-report.ts  # processed events and duplicate detection
npx tsx src/test-webhook.ts        # simulate a delivery (MODE=, FIXTURE=, TOPIC=)
npx tsx src/test-redis.ts          # verify the Redis connection
npx tsx src/make-unknown.ts        # test tooling: force a push into `unknown` (ORDER=)
```

### Environment overrides

```bash
LIMIT=5                            # sample mode — process N items and stop
PAGE_SIZE=250                      # export-products.ts page size
COUNT=2000 START_AT=21 SEED=42     # generate-products.ts
SKU=AL-00500-0 TO=5                # test-flow-trigger.ts
TITLE="Helmet 02000"               # check-product.ts
ORDER="#1001"                      # make-unknown.ts
CONFIRM=yes                        # destructive script safety gate
REPAIR=yes                         # reconcile-erp.ts — apply safe repairs
TUNNEL_URL=https://x.trycloudflare.com   # register-webhooks.ts
MODE=tampered FIXTURE=... TOPIC=...      # test-webhook.ts
RETRY=yes                          # queue-monitor.ts — replay failed jobs
IDEMPOTENT=off                     # worker.ts — disable the processed-event guard
FAIL_AFTER_STEP=1                  # worker.ts — fail mid-transaction
ALLOW_TEST_ORDERS=yes              # worker.ts — permit test orders to reach the ERP
ERP_MODE=ok|fail|flaky|slow|lost   # erp-stub.ts — failure injection
```

`LIMIT` exists because two twenty-minute runs died on mutation shapes a five-item sample would have caught in seconds.

**PowerShell note:** `$env:VAR` persists for the terminal session only. A stale `PAGE_SIZE=2` turned a 6-second export into a 9-minute one more than once.

## Structure

| File | Responsibility |
|---|---|
| `src/constants.ts` | Shared values and pure helpers, including `idempotencyKey`. No imports, no side effects |
| `src/config.ts` | Reads and validates Shopify env vars; memoized |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter |
| `src/exit.ts` | `describeError` renders any thrown value; `handleFatal` adds the exit code |
| `src/preflight.ts` | `assertScopes` startup guard; `applyLimit` sample-mode convention |
| `src/rate-limiter.ts` | Leaky-bucket model; gates requests, derives concurrency |
| `src/shopify.ts` | Transport layer — the only file that calls Shopify |
| `src/mutations.ts` | Write path: `userErrors`, idempotency classification, `requireData` |
| `src/paginate.ts` | Generic cursor-pagination async generators |
| `src/bulk.ts` | Bulk Operations lifecycle: submit, poll, stream JSONL, group by parent |
| `src/db.ts` | Prisma client singleton with driver adapter |
| `src/queue.ts` | Redis connection and BullMQ queue definition; retry policy |
| `src/webhook-verify.ts` | HMAC verification. Pure crypto, no HTTP |
| `src/order-handler.ts` | Order mirroring and two-phase ERP push with derived keys |
| `src/types.ts` | Zod schemas; types derived via `z.infer` |
| `src/webhook-server.ts` | Long-running: verifies, enqueues, responds in ms |
| `src/worker.ts` | Long-running: consumes the queue, routes to handlers |
| `src/erp-stub.ts` | Long-running: external system stand-in with failure injection |
| `src/reconcile-erp.ts` | Compares local push records against the ERP; classifies and repairs |
| `src/register-webhooks.ts` | Subscription management — deletes stale, creates current |
| Remaining `src/*.ts` | Batch scripts, reports, and test tooling |

Dependencies flow one direction. `constants.ts`, `types.ts`, and `errors.ts` have no dependencies; scripts sit at the top.

## Database schema

Nine tables: `Product`, `Variant`, `SyncRun`, `ProcessedEvent`, `WarehouseNotification`, `Order`, `OrderLineItem`, `ErpPush`, `ReconciliationRun`.

**Shopify GID is the primary key.** A surrogate key would cost a lookup on every upsert and buys nothing until a second store exists. `shopDomain` is present so a composite unique constraint can be added later without restructuring relationships.

**`sku` is indexed but not unique.** Shopify does not enforce SKU uniqueness — 23 seeded variants have no SKU at all. Constraints must match the source system's actual guarantees.

**Soft deletes via `deletedAt`.** A full catalog replacement marked 2,000 rows deleted; that history would otherwise be gone. Two products can share a handle across time, because Shopify frees a handle when a product is deleted.

**`lastSeenAt` is the deletion mechanism.** Every row touched by a run is stamped with that run's start time. Anything holding an older timestamp was absent from the snapshot.

**`OrderLineItem.variantGid` is nullable.** A variant deleted after the order was placed leaves the line item intact but unlinked.

**`ErpPush` records intent before the call, outcome after.** No transaction can span Postgres and someone else's API, so a row is written as `attempting` first. A row stuck in that state means the outcome is genuinely unknown and needs reconciliation, not a blind retry.

**`ReconciliationRun` makes drift trends visible.** A single mismatch is noise; a rising count is a systemic problem.

**Money is `Decimal(12,2)`, never `Float`.**

## Design notes

### Engineering

**Script modules must never be imported.** A file ending in `main().catch(...)` executes on import in ESM. `teardown-products.ts` imported `GENERATED_TAG` from `generate-products.ts` and thereby launched a full 2,000-product generation on every single run — silently, interleaved with its own output. The symptom looked exactly like operator error and was misdiagnosed as such for hours.

**When the same "user error" recurs repeatedly, it usually isn't user error.**

**A negative result only means something once the boring explanations are ruled out.** Two separate wrong conclusions in this project came from a plausible story arriving before the evidence justified it.

**Fail fast on missing permissions.** `assertScopes` costs one API call at startup and replaced two failed runs — nine and twenty minutes — that were never going to succeed.

**Batch database writes into single statements.** 500 individual `prisma.upsert()` calls inside one transaction is 500 sequential round trips, exceeding Prisma's 5-second transaction timeout. One `INSERT ... ON CONFLICT DO UPDATE` per batch writes 2,017 products in 9 seconds. **When a timeout fires, ask why the work is slow before making the deadline longer.**

**Raw SQL is parameterised via `Prisma.sql` and `Prisma.join`.** Product titles are merchant-controlled text.

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions.

**Three separate error channels.** HTTP status, the GraphQL `errors` array, and mutation `userErrors`. A mutation rejected by a business rule returns HTTP 200 with no `errors` array.

**Errors are checked before shape.** A rejected request frequently returns `null` data *as a consequence* of the error.

**Error description lives in one place.** `describeError` renders any thrown value with the detail its class carries. Call sites that write their own summaries drop the useful part — this happened twice before the logic was extracted.

**Generated code and type definitions are the most reliable documentation available.** The Prisma 7 constructor signature was resolved by reading a JSDoc example in the generated client after two wrong guesses.

### Webhooks and queues

**HMAC must be computed on the raw request body, before any parsing.** Parsing and re-serializing changes the bytes and the signature will not match. The receiver reads `c.req.text()`, never `c.req.json()`.

**Signature comparison uses `timingSafeEqual`, not `===`.** A normal comparison exits at the first differing byte, leaking how many leading bytes were correct.

**HMAC provides integrity, not just authentication.** Verified by signing a payload correctly and then altering `total_price` from `750.00` to `0.01` in transit — rejected.

**Acknowledge before processing.** The receiver verifies, enqueues, and returns 200 in around 100ms; all processing happens in a separate worker.

**The webhook ID is the job ID.** BullMQ refuses a job whose ID already exists, so a redelivery is silently dropped — while still returning 200, because refusing it would make Shopify retry harder.

**Deduplication lasts only as long as job retention.** With `removeOnComplete: { age: 3600 }`, the retention window *is* the deduplication guarantee, and it is a configuration decision rather than a property of the queue.

**A crashed worker's jobs are owned by nobody.** After `stalledInterval` without lock renewal the job is reclaimed — verified by hard-killing a worker mid-job and watching another pick it up 57 seconds later.

**Stall reclaim does not count as a retry.** The reclaimed job resumed at `attempt 1`. A crash should not consume one of the handler's five attempts.

**Graceful shutdown waits for in-flight jobs.** Which is also why testing crash recovery requires a hard kill rather than Ctrl+C.

**Long jobs get reclaimed while still running.** **At-least-once is the queue's guarantee too, not only Shopify's.**

### Idempotency and reconciliation

**Two guards, defending different failures.** The queue guard (`jobId`) stops duplicate jobs from Shopify redelivery and lasts one hour. The handler guard (`ProcessedEvent`) stops duplicate work from retry, stall, or lock expiry and is backed by Postgres, so it survives queue obliteration. Verified by clearing the queue entirely and replaying a webhook ID that had already been processed.

**A transaction covers what shares a database.** Injecting a failure between two steps rolled back all five attempts: `step 1: updated title` logged five times, zero rows changed.

**Stale is a good failure; half-applied is not.** Stale is detectable by the next full sync and internally consistent. A mirror updated but a downstream system never told looks current while being wrong.

**No transaction can span a database and someone else's API.** Push then record, and a crash between them means the retry pushes again. Record then push, and a crash means the push never happens. There is no ordering that fixes it.

**So: record intent before, outcome after.** `ErpPush` is written as `attempting`, then updated to `confirmed`, `failed`, or `unknown`.

**`unknown` is a distinct status from `failed`, deliberately.** A timeout means the outcome is undetermined — the remote may have processed it and lost the response. A failure can be retried freely; an unknown must be reconciled.

**Idempotency keys must be derived, not random.** `idempotencyKey()` hashes the parts identifying an operation, so every attempt carries the same key. Verified against an ERP that accepted an order and then never responded: the retry returned the original reference instead of creating a second order. A `randomUUID()` per attempt would have produced two shipments for one purchase.

**Reconciliation narrows the human decision set; it does not decide.** Four verdicts, only one repairable automatically:

| Local | Remote | Verdict | Repairable |
|---|---|---|---|
| `confirmed` | present | agreed | n/a |
| `confirmed` | absent | missing-remote | **No** |
| `unknown` | present | resolved-unknown | **Yes** |
| `unknown` | absent | confirmed-failed | No — but safe to retry |
| — | present | orphaned-remote | **No** |

Resolving an `unknown` records work that already happened; zero risk. Re-pushing a `missing-remote` *performs* work, and nothing on the local side can distinguish "the ERP lost it" from "the ERP is reporting a partial view." Auto-repairing that could ship a duplicate order.

**Test orders must be blocked from reaching a live downstream system.** The bogus gateway marks every development order `test: true`.

**Set a timeout on outbound calls.** Without `AbortSignal.timeout`, a hung downstream system hangs the worker until the job stalls — converting a slow dependency into a queue outage.

**A well-built retry path makes failure states hard to reproduce.** Producing a lingering `unknown` required forcing the row directly, because every organic attempt healed itself: the derived key held, the ERP deduplicated, and the retry succeeded. Hard-to-reach failure states are a sign the mechanism works, not a testing problem — but they do mean the reconciliation logic is verified against a fabricated state rather than an observed one.

### Shopify data model

Findings verified against a live development store, not taken from documentation.

**Inventory does not live on a variant.** The chain is `ProductVariant → InventoryItem → InventoryLevel → Location`.

**Setting `tracked: true` does not create inventory levels.** An item must be activated at a location via `inventoryActivate` first.

**Untracked variants are not zero-stock variants.** Treating it as `0` would overwrite a downstream system with a number meaning "none" when the truth is "unknown."

**Quantity names are not interchangeable.** Verified with an unfulfilled test order: one unit moved from `available` while `on_hand` stayed constant and `committed` rose to 1.

**`on_hand` is settable; `available` is derived** as `on_hand − committed`.

**Location capability is a filter, not metadata.** 38,312 of 234,204 units sit at a `shipsInventory: false` location — 16% of stock, real but unfulfillable online.

**Financial and fulfillment status are independent.** An order can be paid and unfulfilled, or fulfilled and refunded. Treating fulfillment as a function of payment is a common and expensive mistake.

**Shopify does not enforce SKU uniqueness.** Handles are auto-deduplicated; SKUs are not.

**`userError` payload types differ per mutation.** `inventoryActivate` has **no** `userErrors` field. Requesting a field that doesn't exist fails at query *validation*.

**Inventory mutations require an explicit `@idempotent` directive.** Shopify enforces at the protocol level the same distinction this project classifies by hand.

**`ignoreCompareQuantity` was removed in 2026-04.** Compare-and-swap moved to a per-quantity `changeFromQuantity`.

**Two sequential mutations have no transaction.** `productSet` with `synchronous: true` is atomic where `productCreate` + `productVariantsBulkCreate` is not.

**Bulk queries use a different dialect.** `edges { node { } }` required; nested connections take no `first:`.

**Metafield definitions require namespace ownership.** The `$app:` prefix reserves one; app-namespaced metafields are invisible in the admin.

**Granted scopes and declared scopes drift.** `currentAppInstallation.accessScopes` is ground truth.

**Deletion produces no event.** Full-snapshot sync plus `lastSeenAt` is the only way to answer "what is no longer here."

**Protected customer data gates the Order object itself, not just webhook subscriptions.** With `read_orders` granted and the scope preflight passing, `orders(first: 10)` was rejected. **Selecting a data use under App setup → Protected customer data access unlocks it immediately for development** — no App Store review; the Draft status and data protection questionnaire only gate distribution. Worth knowing before quoting a client: the answer is "five minutes," not "pending review."

**`products/update` fires on inventory changes.** The topic covers the product as an aggregate, so a store syncing inventory generates high volume on a topic whose name suggests otherwise.

**Quick tunnels are ephemeral.** New URL on every restart, expiry on idle.

### Shopify Flow

**Flow triggers fire identically for admin edits and API writes.** An earlier conclusion that inventory triggers ignored API changes was wrong: the workflow used an edge-triggered condition and no write in the random sample crossed the threshold from above. **Zero runs was correct behaviour, not a missing trigger.**

**Edge-triggered conditions are the right pattern for threshold alerts.** Checking only `quantity < 10` fires on every subsequent change while the item stays low; adding the prior-value check fires once, on the transition.

**Flow can generate synthetic test events, including negative cases.** A workflow that fires when it should is half-verified; one that also stays quiet when it shouldn't is verified.

### Prisma 7 specifics

**The client no longer bundles a database driver.** `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.

**`prisma.config.ts` configures the CLI only.** The runtime connection is established in application code.

**The generated client is TypeScript source at a configured `output` path.** Gitignored and rebuilt by `prisma generate`; `prisma/migrations/` is committed. `migrate dev` does not always emit it — run `prisma generate` explicitly.

**ioredis needs a named import.** `import { Redis } from 'ioredis'` — the default export is the module namespace and is not constructable.

## Measured behaviour

Plus development store: 20,000-point bucket, 1000/sec restore. Catalog of 2,017 products / 6,040 variants / 234,274 units.

### Batch layer

| Workload | Result |
|---|---|
| 2,000 products via `productSet`, concurrency 4 | 8m 47s, 0 failures |
| 6,014 variants activated + quantities set, concurrency 6 | 20m 10s, 0 failures |
| Full read, `PAGE_SIZE=250` | 9 pages, 6.2s |
| Full read, Bulk Operations | 6.2s + 2.2s parse, bucket stayed at 20,000 |
| Full sync, initial load | 2,017 created + 6,040 variants in 9.0s |
| Full sync, no changes | 2,017 unchanged in 12.3s |
| Full sync, complete catalog replacement | 2,000 created, 1,999 + 6,012 deleted in 10.7s |
| Full sync catching webhook drift | 10 updated, detected without knowing why |

**Four independent implementations agree exactly** on 2,017 products.

**The rate limiter has never triggered.** The bucket never dropped below 19,800 in any run.

### Event layer

| Path | Result |
|---|---|
| Receipt → verified → enqueued | 68–250ms |
| Enqueue → worker pickup | 170–614ms |
| Valid signature | 200, job queued |
| Wrong secret / tampered / missing header | 401, nothing queued |
| Redelivery with same webhook ID | 200 returned, job silently dropped |
| Same webhook ID after queue obliteration | handler guard caught it, no work done |
| Exponential backoff across 5 attempts | 160ms → 2.5s → 6.9s → 15.1s → 31.4s, then `[DEAD]` |
| Dead-letter replay | resumed after 178s, across a worker restart |
| Hard-killed worker mid-job | stall detected, requeued, completed 57s later at `attempt 1` |
| Failure mid-transaction, 5 attempts | 5 partial executions, 0 rows changed |
| ERP accepted then lost the response | retried with same derived key, ERP returned original reference — one order, not two |
| Reconciliation against a reset ERP | 1 agreed, 1 resolved-unknown (repaired), 2 missing-remote (flagged for a human) |

**Every failure path has been exercised**, not assumed.

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

1. **Reconciliation is manual and one-directional.** `reconcile-erp.ts` must be run by hand, and `missing-remote` findings accumulate with no workflow for resolving them. A production system would schedule it and route unresolvable findings somewhere a human sees them.

2. **The ERP stub has no persistence.** In-memory state resets on restart — realistic for a stub, but it means long-lived deduplication cannot be demonstrated, and it is why two `missing-remote` findings exist.

3. **`unknown` was verified against a fabricated state.** The genuine lost-response case healed itself on retry every time, so `make-unknown.ts` forces the row directly. The reconciliation logic is verified; the state's origin is not observed.

4. **Concurrency ceiling is arbitrary.** Capped at 20; the uncapped figure on this store is around 60.

5. **The rate limiter is untested under real pressure.** The waiting path has never executed against a genuine limit.

6. **Single store per process.** `getConfig()` memoizes into module scope and `shopify.ts` exports one shared limiter.

7. **Sync is full-snapshot only.** Correct, and the only way to detect deletions, but a 500,000-product store would want incremental updates with periodic full reconciliation.

8. **Inventory levels are not persisted.** The database cannot answer the fulfillability question `inventory-report.ts` can.

9. **Only one webhook topic is subscribed live.** `products/update`. Order events are driven from captured fixtures rather than real deliveries.

10. **The receiver has no rate limiting or body size cap.** A public endpoint accepting arbitrary POST bodies with no upper bound is a denial-of-service surface, even though invalid signatures are rejected.

11. **Failed jobs are not alerted on.** The dead-letter queue must be inspected manually.

12. **Teardown cannot distinguish test data from real data**, and has a check-then-act race.

13. **Bulk error paths are untested.** `FAILED`, `EXPIRED`, `partialDataUrl`, and timeout handling have never executed.

14. **No automated tests.** Everything has been verified manually — broken credentials, unresolvable hosts, stubbed 429s, committed stock, catalog replacement, a fake required scope, four webhook signature modes, injected worker failures, mid-transaction failure, a lost ERP response, and cross-system drift — but none of it is repeatable without a human.

## Resolved

- ~~No token invalidation on 401~~ — a rejected token now clears the cache and retries.
- ~~Concurrency limit is hardcoded~~ — derived from observed cost and restore rate.
- ~~Throttle reporting understates pressure~~ — limiter extrapolates rather than trusting the last reading.
- ~~`retry.ts` is unsafe for mutations~~ — retry is opt-in per operation.
- ~~Read-only~~ — write path with `userErrors` handling and proven idempotency.
- ~~Catalog too small to test at scale~~ — 2,017 products, 6,040 variants.
- ~~No bulk export~~ — JSONL streaming, verified against pagination.
- ~~Generated products have no inventory~~ — 234,274 units across two locations.
- ~~Scripts appear to interfere when run concurrently~~ — root cause was a module side-effect import.
- ~~No persistence~~ — Postgres mirror with create, update, and delete detection.
- ~~No scope preflight~~ — every write script asserts scopes and exits 77 in about two seconds.
- ~~No dry-run or sample mode~~ — shared `LIMIT` convention.
- ~~Flow inventory triggers appear blind to API writes~~ — false; the edge-triggered condition wasn't satisfied by the test data.
- ~~No real-time events~~ — webhook receiver with HMAC verification, durable queue, every failure path tested.
- ~~Handlers are not explicitly idempotent~~ — `ProcessedEvent` guard plus transactional multi-step writes.
- ~~Order data inaccessible~~ — protected customer data unlocked for development; five real orders captured as fixtures.
- ~~Idempotency keys are random per call~~ — `idempotencyKey()` derives from operation identity; applied to inventory and ERP pushes.
- ~~No reconciliation against the ERP~~ — four-verdict classification with selective repair.

## Roadmap

- Automated tests for `retry.ts`, `webhook-verify.ts`, and `idempotencyKey`
- Persist inventory levels per location
- Scheduled reconciliation with alerting on unresolvable findings
- Incremental sync with periodic full reconciliation
- Custom app: React Router 7, OAuth, Polaris, Flow triggers and actions