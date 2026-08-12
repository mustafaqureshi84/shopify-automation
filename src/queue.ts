import 'dotenv/config';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { ConfigError } from './errors.js';

const url = process.env['REDIS_URL'];

if (!url) {
  throw new ConfigError(
    'Missing required environment variable: REDIS_URL\n' +
      'Check your .env file at the project root.'
  );
}

/**
 * Named import, not default. ioredis is CommonJS; its default export is the
 * module namespace object, which is not constructable. The class is the
 * named `Redis` export.
 *
 * BullMQ requires `maxRetriesPerRequest: null`. Its workers use blocking
 * commands that wait for a job to appear, and ioredis's default retry
 * behaviour would abort those as timeouts.
 */
export const connection = new Redis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export interface WebhookJob {
  /** Shopify's delivery ID. Same value on every retry of the same event. */
  webhookId: string;
  topic: string;
  shop: string;
  triggeredAt: string;
  /** Raw body, already HMAC-verified before enqueueing. */
  payload: string;
  receivedAt: number;
}

export const WEBHOOK_QUEUE = 'shopify-webhooks';

export const webhookQueue = new Queue<WebhookJob>(WEBHOOK_QUEUE, {
  connection,
  defaultJobOptions: {
    /**
     * Five attempts with exponential backoff: ~2s, 4s, 8s, 16s. A downstream
     * system that's briefly down recovers without intervention; one that's
     * genuinely broken lands in the failed set for a human to inspect.
     */
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },

    /**
     * Keep completed jobs briefly for observability, failed ones for much
     * longer — a failure nobody can inspect is a failure nobody can fix.
     *
     * Note this retention window IS the deduplication guarantee: a job ID
     * only blocks a duplicate for as long as the job is retained.
     */
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

export async function closeQueue(): Promise<void> {
  await webhookQueue.close();
  await connection.quit();
}