import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { connection, WEBHOOK_QUEUE } from './queue.js';
import type { WebhookJob } from './queue.js';
import { prisma } from './db.js';
import { describeError } from './exit.js';
import { z } from 'zod';

/** Shopify sends REST-shaped payloads to webhooks, not GraphQL shapes. */
const ProductPayloadSchema = z.looseObject({
  id: z.number(),
  admin_graphql_api_id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(),
  updated_at: z.string().optional(),
});

/**
 * IDEMPOTENT=off disables the processed-event guard, so the cost of not
 * having one can be observed rather than described.
 */
const GUARD_ENABLED = process.env['IDEMPOTENT'] !== 'off';

/**
 * FAIL_AFTER_STEP=1 throws after the product update but before the
 * warehouse notification — the partial-completion case that makes
 * multi-step handlers dangerous.
 */
const FAIL_AFTER_STEP = process.env['FAIL_AFTER_STEP'];

async function handleProductUpdate(job: Job<WebhookJob>): Promise<void> {
  const { webhookId, topic, shop } = job.data;

  if (GUARD_ENABLED) {
    const already = await prisma.processedEvent.findUnique({
      where: { webhookId },
    });

    if (already) {
      console.log(
        `  already processed at ${already.processedAt.toISOString()} — skipping`
      );
      return;
    }
  }

  const parsed = ProductPayloadSchema.safeParse(JSON.parse(job.data.payload));

  if (!parsed.success) {
    // A malformed payload will be malformed on every retry. Failing fast is
    // more honest than five attempts at parsing the same broken JSON.
    throw new Error(
      `Unexpected product payload shape: ${JSON.stringify(parsed.error.issues)}`
    );
  }

  const product = parsed.data;
  const gid = product.admin_graphql_api_id;

  const existing = await prisma.product.findUnique({
    where: { gid },
    select: { title: true, handle: true, status: true },
  });

  if (!existing) {
    console.log(`  ${gid} not in database — full sync needed to backfill`);
    return;
  }

  const changes: string[] = [];
  if (existing.title !== product.title) changes.push('title');
  if (existing.handle !== product.handle) changes.push('handle');
  if (existing.status !== product.status.toUpperCase()) changes.push('status');

  if (changes.length === 0) {
    console.log(`  ${product.title} — no tracked fields changed`);

    // Still record it. A no-op is a completed outcome, and without the row
    // a redelivery would repeat the comparison work.
    if (GUARD_ENABLED) {
      await prisma.processedEvent.create({
        data: { webhookId, topic, shopDomain: shop, summary: 'no changes' },
      });
    }
    return;
  }

  /**
   * Both writes plus the processed-event row happen in one transaction.
   * A crash anywhere inside leaves the database exactly as it was, so the
   * retry starts clean rather than half-applied.
   *
   * This only works because every step is in the same database. A real
   * warehouse call would be HTTP, which no transaction can cover — see the
   * note on WarehouseNotification in schema.prisma.
   */
  await prisma.$transaction(async (tx) => {
    // Step 1 — update the mirror.
    await tx.product.update({
      where: { gid },
      data: {
        title: product.title,
        handle: product.handle,
        status: product.status.toUpperCase(),
        lastSeenAt: new Date(),
        deletedAt: null,
      },
    });

    console.log(`  step 1: updated ${changes.join(', ')}`);

    if (FAIL_AFTER_STEP === '1') {
      throw new Error('Injected failure after step 1 (FAIL_AFTER_STEP=1)');
    }

    // Step 2 — notify the "warehouse". This is the non-idempotent one:
    // every call creates a new row.
    await tx.warehouseNotification.create({
      data: {
        productGid: gid,
        title: product.title,
        reason: `changed: ${changes.join(', ')}`,
      },
    });

    console.log(`  step 2: warehouse notified`);

    if (GUARD_ENABLED) {
      await tx.processedEvent.create({
        data: {
          webhookId,
          topic,
          shopDomain: shop,
          summary: `updated ${changes.join(', ')}`,
        },
      });
    }
  });

  console.log(`  ${product.title} — complete`);
}

const worker = new Worker<WebhookJob>(
  WEBHOOK_QUEUE,
  async (job) => {
    const lag = Date.now() - job.data.receivedAt;
    console.log(
      `[job ${job.id}] ${job.data.topic} attempt ${job.attemptsMade + 1} — ${lag}ms after receipt`
    );

    switch (job.data.topic) {
      case 'products/update':
        await handleProductUpdate(job);
        break;
      default:
        console.log(`  no handler for ${job.data.topic} — acknowledged`);
    }
  },
  {
    connection,
    concurrency: 5,

    /**
     * A worker holds a lock on each job and renews it on a heartbeat. If the
     * process dies, renewal stops and the job is left "active" but owned by
     * nobody. After `stalledInterval` without renewal it is reclaimed.
     *
     * The tradeoff: a job legitimately taking longer than the lock will be
     * reclaimed while still running, and processed twice. Long work needs
     * `job.extendLock()` or a longer lock.
     */
    stalledInterval: 30_000,
    maxStalledCount: 2,
  }
);

worker.on('completed', (job) => {
  console.log(`[done] ${job.id}\n`);
});

worker.on('stalled', (jobId) => {
  console.warn(`[stalled] ${jobId} — lock expired, requeued for another worker\n`);
});

worker.on('failed', (job, err) => {
  const attempts = job?.attemptsMade ?? 0;
  const max = job?.opts.attempts ?? 0;
  const final = attempts >= max;

  console.error(
    `[${final ? 'DEAD' : 'retry'}] ${job?.id} attempt ${attempts}/${max}`
  );
  console.error(describeError(err));

  if (final) {
    console.error('  Job exhausted retries. Inspect with queue-monitor.ts\n');
  }
});

console.log(
  `Worker started — idempotency guard ${GUARD_ENABLED ? 'ON' : 'OFF'}\n`
);

async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);