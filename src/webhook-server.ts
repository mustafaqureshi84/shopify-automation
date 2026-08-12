import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { verifyWebhook } from './webhook-verify.js';

const app = new Hono();

const PORT = Number(process.env['PORT'] ?? 3000);

app.get('/health', (c) => c.text('ok'));

app.post('/webhooks/:topic{.*}', async (c) => {
  const received = Date.now();

  const hmac = c.req.header('x-shopify-hmac-sha256');
  const topic = c.req.header('x-shopify-topic') ?? 'unknown';
  const shop = c.req.header('x-shopify-shop-domain') ?? 'unknown';
  const webhookId = c.req.header('x-shopify-webhook-id') ?? 'unknown';
  const attempt = c.req.header('x-shopify-triggered-at') ?? '';

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

  const elapsed = Date.now() - received;

  console.log(
    `[accept] ${topic} from ${shop}\n` +
      `  webhook-id: ${webhookId}\n` +
      `  triggered:  ${attempt}\n` +
      `  bytes:      ${rawBody.length}\n` +
      `  verified in ${elapsed}ms`
  );

  /**
   * Respond immediately. Shopify's delivery timeout is a few seconds; doing
   * real work before responding means the delivery fails, Shopify retries,
   * and now there are duplicates on top of a slow handler.
   *
   * Day 2 replaces this with: enqueue the job, then respond.
   */
  return c.text('ok', 200);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Webhook receiver listening on http://localhost:${info.port}`);
  console.log(`  health:   GET  /health`);
  console.log(`  webhooks: POST /webhooks/*\n`);
});