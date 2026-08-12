import { serve } from '@hono/node-server';
import { Hono } from 'hono';

interface ErpRecord {
  reference: string;
  orderGid: string;
  at: string;
}

const app = new Hono();
const PORT = Number(process.env['ERP_PORT'] ?? 4000);

/**
 * Keyed by idempotency key. A real ERP would persist this, but the behaviour
 * is what matters: a repeated key returns the original result rather than
 * creating a second record.
 */
const received = new Map<string, ErpRecord>();

let sequence = 1000;

/**
 * ERP_MODE controls failure behaviour:
 *   ok     — normal
 *   fail   — 500 on every request
 *   flaky  — 500 roughly half the time
 *   slow   — 10s delay, so the caller times out while the write succeeds
 *   lost   — processes the request, then never responds
 */
function mode(): string {
  return process.env['ERP_MODE'] ?? 'ok';
}

app.get('/health', (c) => c.text('erp ok'));

app.get('/orders', (c) => {
  const orders = [...received.entries()].map(([key, value]) => ({
    idempotencyKey: key,
    reference: value.reference,
    orderGid: value.orderGid,
    at: value.at,
  }));

  return c.json({ count: received.size, orders });
});

app.post('/orders', async (c) => {
  const key = c.req.header('idempotency-key');
  const currentMode = mode();

  if (!key) {
    console.log('[erp] rejected — no idempotency key');
    return c.json({ error: 'Idempotency-Key header required' }, 400);
  }

  /**
   * Deduplication happens BEFORE any failure simulation. A real ERP that has
   * already accepted an order should acknowledge the duplicate rather than
   * failing it — otherwise a retry after a lost response looks like a new
   * error when the work was already done.
   */
  const existing = received.get(key);

  if (existing) {
    console.log(
      `[erp] duplicate key ${key} — returning original ${existing.reference}`
    );
    return c.json({ reference: existing.reference, duplicate: true }, 200);
  }

  if (currentMode === 'fail') {
    console.log(`[erp] injected 500 for ${key}`);
    return c.json({ error: 'ERP unavailable' }, 500);
  }

  if (currentMode === 'flaky' && Math.random() < 0.5) {
    console.log(`[erp] flaky 500 for ${key}`);
    return c.json({ error: 'ERP unavailable' }, 500);
  }

  const body = (await c.req.json()) as { orderGid?: string };
  const orderGid = body.orderGid ?? 'unknown';

  if (currentMode === 'slow') {
    console.log(`[erp] slow mode — sleeping 10s for ${key}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }

  sequence += 1;
  const reference = `ERP-${sequence}`;

  received.set(key, {
    reference,
    orderGid,
    at: new Date().toISOString(),
  });

  console.log(`[erp] accepted ${orderGid} as ${reference} (key ${key})`);

  if (currentMode === 'lost') {
    /**
     * The worst case, and the reason two-phase recording exists: the write
     * succeeded but the caller never learns of it. A blind retry would be a
     * duplicate if the ERP were not idempotent.
     */
    console.log(`[erp] response deliberately lost for ${key}`);
    await new Promise(() => {
      // never resolves
    });
  }

  return c.json({ reference, duplicate: false }, 201);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`ERP stub listening on http://localhost:${info.port}`);
  console.log(`  mode: ${mode()}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /orders   — what the ERP has received`);
  console.log(`  POST /orders   — push an order (Idempotency-Key required)\n`);
});