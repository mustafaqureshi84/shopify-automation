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

async function handleProductUpdate(job: Job<WebhookJob>): Promise<void> {
    /**
   * Deliberate failure injection for testing retry and dead-letter paths.
   * FAIL_MODE=always  — throw every time, exhausts retries
   * FAIL_MODE=once    — throw on attempt 1 only, proves recovery
   * FAIL_MODE=slow    — take 30s, so the worker can be killed mid-job
   */
  const failMode = process.env['FAIL_MODE'];

  if (failMode === 'always') {
    throw new Error('Injected failure (FAIL_MODE=always)');
  }

  if (failMode === 'once' && job.attemptsMade === 0) {
    throw new Error('Injected failure (FAIL_MODE=once, attempt 1)');
  }

  if (failMode === 'slow') {
    console.log('  sleeping 30s — kill the worker now to test job recovery');
    await new Promise((r) => setTimeout(r, 30_000));
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
    return;
  }

  /**
   * An update keyed on the primary key is naturally idempotent: applying the
   * same values twice leaves the same row. That is what makes retrying this
   * job safe.
   */
  await prisma.product.update({
    where: { gid },
    data: {
      title: product.title,
      handle: product.handle,
      status: product.status.toUpperCase(),
      lastSeenAt: new Date(),
      deletedAt: null,
    },
  });

  console.log(`  ${product.title} — updated: ${changes.join(', ')}`);
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
    /** Process up to 5 jobs at once. */
    concurrency: 5,
  }
);

worker.on('completed', (job) => {
  console.log(`[done] ${job.id}\n`);
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

console.log('Worker started, waiting for jobs...\n');

async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  // Waits for in-flight jobs to finish rather than abandoning them mid-write.
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);