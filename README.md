# Shopify Automation Lab

A learning project for building reliable Shopify integrations against the GraphQL Admin API. The focus is not "make a request work" — it's what a request needs around it to run unattended: runtime validation, typed errors, retry with backoff, and meaningful exit codes.

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
npx tsx src/first-query.ts      # list 10 products with variant counts
npx tsx src/async-patterns.ts   # compare sequential / parallel / bounded concurrency
```

## Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | Reads and validates env vars; memoized, throws `ConfigError` naming every missing variable |
| `src/errors.ts` | `ConfigError`, `ShopifyAuthError`, `ShopifyApiError` |
| `src/retry.ts` | `withRetry` with exponential backoff and jitter; `RetryExhaustedError` |
| `src/shopify.ts` | Token acquisition and caching, GraphQL transport, error body summarizing |
| `src/types.ts` | Zod schemas; TypeScript types derived via `z.infer` |
| `src/first-query.ts` | Minimal product query |
| `src/async-patterns.ts` | Concurrency comparison with throttle reporting |

## Design notes

**Validation at the boundary.** Every response is parsed with `safeParse` before use. There are no `as` type assertions — types are a consequence of validation rather than a promise to the compiler.

**Retry decisions are status-based, not text-based.** 429 and 5xx retry; 4xx does not. Shopify's error pages contain reassuring prose like "this store will be right back" even for stores that never existed, so response body text is not used to decide retryability.

**`Retry-After` overrides local backoff.** When the server states when to retry, that instruction wins over the exponential curve.

**Backoff includes jitter.** Delays land between roughly 85% and 115% of target so concurrent failures don't retry in lockstep.

**Token caching expires early.** A 300-second safety margin is subtracted from the token lifetime to avoid a token expiring between the validity check and the request reaching Shopify.

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

1. **No token invalidation on 401.** If a cached token is rejected mid-run, the cache is not cleared and the request cannot self-heal. A 401 should invalidate the cache and trigger one retry; it currently fails as permanent.

2. **Concurrency limit is hardcoded.** `mapWithConcurrency` takes a fixed limit of 3. Shopify returns `throttleStatus` on every response — a correct client would derive its rate from `currentlyAvailable` and `restoreRate` and slow down as the bucket drains.

3. **Only tested against a Plus development store.** That store has a 20,000-point bucket restoring at 1000/sec. A Basic-plan store has 100 points at 50/sec. The unbounded `Promise.all` path appeared safe here purely because of that headroom and would be throttled immediately on a standard plan.

4. **Throttle reporting understates pressure.** `async-patterns.ts` records the throttle status from the last response to return, not the minimum observed. Under parallelism the bucket has already partially refilled by then.

5. **Single store per process.** `getConfig()` memoizes into module scope, so this cannot talk to two shops in one run. A multi-store integration would need config passed explicitly rather than imported.

6. **Read-only.** No mutations are performed. Nothing here has been tested against write scopes or idempotency requirements.

7. **No pagination.** Queries are capped at the first 10–50 records. Anything at real catalog scale needs cursor pagination or the Bulk Operations API.

8. **No persistence.** Results are printed to stdout and discarded.

9. **No tests.** Failure paths were verified manually by breaking credentials and pointing `SHOP_DOMAIN` at an unresolvable host.

## Roadmap

- Adaptive rate limiting driven by `throttleStatus`
- Cursor pagination and Bulk Operations
- Postgres persistence via Prisma
- Webhook receiver with HMAC verification and idempotent handlers