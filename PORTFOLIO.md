# Shopify Automation Engineering — Project Overview

Two repositories built over eight weeks, learning Shopify integration engineering from first principles.

- **[shopify-automation](https://github.com/mustafaqureshi84/shopify-automation)** — headless integration layer
- **[catalog-guard](https://github.com/mustafaqureshi84/catalog-guard)** — merchant-facing app

## What they demonstrate

### Reliability under failure

Every failure path in the event-driven layer was exercised rather than assumed. Retry with exponential backoff, dead-lettering after five attempts, replay from the failed set across a worker restart, and stalled-job recovery after a hard process kill — verified by killing the worker mid-job and watching another reclaim it 57 seconds later.

The hardest case: an external system accepted an order and then never responded. The retry carried the same derived idempotency key and received the original reference back rather than creating a second order. A `randomUUID()` per attempt would have shipped two.

### Correctness across system boundaries

No transaction can span a database and someone else's API. Push then record, and a crash between them means the retry pushes again; record then push, and a crash means the push never happens. There is no ordering that fixes it.

So the pipeline records intent before the call and outcome after, and distinguishes `failed` from `unknown`. A failure can be retried freely; an undetermined outcome must be reconciled against the remote system. A reconciliation job classifies every disagreement into four verdicts and repairs only the one that can be repaired without doing work — because re-pushing a missing order is an action, not a record, and nothing on the local side can distinguish "the remote lost it" from "the remote is reporting a partial view."

### Judgement about when not to act

Shopify does not enforce SKU uniqueness, so a supplier feed row matching two variants is a real case. Applying to both is unrecoverable if wrong; skipping costs one manual fix. The app skips and flags.

A parser that turns `"N/A"` into `0` zeroes out inventory across thousands of SKUs and reports success. Coercion refuses rather than defaults.

A circuit breaker blocks a run when too much of it looks dangerous — but permits changes the policy graded safe, because blocking those too would train merchants to reach for the override, which is the opposite of what a breaker is for.

### Honest documentation

Both READMEs list known limitations alongside what works — around twenty in total, including gaps that were observed rather than reasoned about. One records a conclusion that turned out to be wrong, with the reasoning that produced the error and the test that disproved it.

That entry is there deliberately. A finding stated confidently and later contradicted is worse than one qualified honestly, and the difference between a hypothesis and a verified fact is a distinction worth making visible.

## Technical coverage

**Shopify platform:** GraphQL Admin API, Bulk Operations, webhooks with HMAC verification, Shopify Flow including a custom trigger, embedded apps with OAuth and App Bridge, Polaris, and Shopify Functions compiled to WebAssembly.

**Engineering:** TypeScript strict mode, runtime validation with Zod, Postgres and SQLite via Prisma, durable job queues with BullMQ and Redis, React Router 7 with server-side rendering, and automated testing of pure functions and compiled Wasm binaries.

**Verified at scale:** 2,017 products and 6,040 variants across 234,274 inventory units. Four independent implementations agreeing exactly on the catalogue count. A full sync detecting 1,999 deletions Shopify never announced.

## Findings

Roughly fifty platform behaviours documented from direct observation, several of which are not in the documentation or contradict it. A sample:

- Deletion produces no Shopify event; absence from a full snapshot is the only signal
- `THROTTLED` arrives as HTTP 200 in the GraphQL `errors` array
- Granted scopes and declared scopes drift, and reads keep working while writes are denied
- Protected customer data gates the `Order` object itself, not just webhook subscriptions — and unlocks for development in five minutes, not a review cycle
- A Flow trigger property typed as text produces a trigger that fires correctly but offers no numeric operators, with no other symptom
- Function-backed discounts never appear in Shopify's native create-discount list; the app must create the record

## Reading order

Start with [shopify-automation's README](https://github.com/mustafaqureshi84/shopify-automation#readme) — the design notes and platform findings sections carry most of the reasoning. [Catalog Guard's](https://github.com/mustafaqureshi84/catalog-guard#readme) shows the same instincts applied to something a merchant would use.