import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { verifyWebhook } from './webhook-verify.js';
import { webhookQueue } from './queue.js';

const app = new Hono();

const PORT = Number(process.env['PORT'] ?? 3000);

app.get('/health', (c) => c.text('ok'));

app.post('/webhooks/:topic{.*}', async (c) => {
  const received = Date.now();

  const hmac = c.req.header('x-shopify-hmac-sha256');
  const topic = c.req.header('x-shopify-topic') ?? 'unknown';
  const shop = c.req.header('x-shopify-shop-domain') ?? 'unknown';
  const webhookId = c.req.header('x-shopify-webhook-id') ?? 'unknown';
  const triggeredAt = c.req.header('x-shopify-triggered-at') ?? '';

  // Raw text, not c.req.json(). Verification depends on the exact bytes.
  const rawBody = await c.req.text();

  if (!hmac) {
    console.warn(`[reject] ${topic} — no HMAC header`);
    return c.text('Unauthorized', 401);
  }

  if (!verifyWebhook(rawBody, hmac)) {
    console.warn(`[reject] ${topic} — HMAC mismatch`);
    return c.text('Unauthorized', 401);
  }

  /**
   * The webhook ID is the job ID. BullMQ refuses to add a job whose ID
   * already exists, so a redelivery of the same event is silently ignored.
   *
   * This is deduplication at the queue boundary. It does NOT make the
   * handler idempotent — a job that fails partway and retries can still
   * repeat work. The handler must be safe on its own; this only stops
   * Shopify's at-least-once delivery from creating duplicate jobs.
   */
  await webhookQueue.add(
    topic,
    {
      webhookId,
      topic,
      shop,
      triggeredAt,
      payload: rawBody,
      receivedAt: received,
    },
    { jobId: webhookId }
  );

  const elapsed = Date.now() - received;

  console.log(
    `[queued] ${topic} ${webhookId} from ${shop} — ${rawBody.length} bytes, ${elapsed}ms`
  );

  /**
   * Respond immediately. Shopify's delivery timeout is a few seconds; doing
   * real work before responding means the delivery fails, Shopify retries,
   * and there are duplicates on top of a slow handler.
   */
  return c.text('ok', 200);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Webhook receiver listening on http://localhost:${info.port}`);
  console.log(`  health:   GET  /health`);
  console.log(`  webhooks: POST /webhooks/*\n`);
});