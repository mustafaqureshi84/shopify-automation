import { prisma } from './db.js';
import { idempotencyKey } from './constants.js';
import { z } from 'zod';

const ERP_URL = process.env['ERP_URL'] ?? 'http://localhost:4000';

/** Shopify sends REST-shaped payloads to webhooks, not GraphQL shapes. */
const OrderPayloadSchema = z.looseObject({
  id: z.number(),
  admin_graphql_api_id: z.string(),
  name: z.string(),
  created_at: z.string(),
  test: z.boolean(),
  financial_status: z.string().nullable(),
  fulfillment_status: z.string().nullable(),
  total_price: z.string(),
  currency: z.string(),
  email: z.string().nullable(),
  line_items: z.array(
    z.looseObject({
      admin_graphql_api_id: z.string(),
      title: z.string(),
      quantity: z.number(),
      sku: z.string().nullable(),
      admin_graphql_api_variant_id: z.string().nullable(),
      price: z.string(),
    })
  ),
});

export type OrderPayload = z.infer<typeof OrderPayloadSchema>;

interface ErpResponse {
  reference: string;
  duplicate: boolean;
}

async function pushToErp(
  orderGid: string,
  key: string,
  payload: OrderPayload
): Promise<ErpResponse> {
  const res = await fetch(`${ERP_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      orderGid,
      orderNumber: payload.name,
      total: payload.total_price,
      currency: payload.currency,
      lines: payload.line_items.map((item) => ({
        sku: item.sku,
        title: item.title,
        quantity: item.quantity,
      })),
    }),
    // Without a timeout, a hung ERP hangs the worker until the job stalls,
    // turning a slow dependency into a queue outage.
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`ERP returned ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as ErpResponse;
}

export async function handleOrderCreate(
  rawPayload: string,
  shop: string
): Promise<string> {
  const parsed = OrderPayloadSchema.safeParse(JSON.parse(rawPayload));

  if (!parsed.success) {
    throw new Error(
      `Unexpected order payload shape: ${JSON.stringify(parsed.error.issues)}`
    );
  }

  const order = parsed.data;
  const gid = order.admin_graphql_api_id;

  /**
   * Mirror the order and its line items in one transaction. Both are in the
   * same database, so atomicity is available here — unlike the ERP push.
   */
  await prisma.$transaction(async (tx) => {
    await tx.order.upsert({
      where: { gid },
      create: {
        gid,
        shopDomain: shop,
        orderNumber: order.name,
        financialStatus: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        totalPrice: order.total_price,
        currencyCode: order.currency,
        customerEmail: order.email,
        test: order.test,
        shopifyCreatedAt: new Date(order.created_at),
      },
      update: {
        financialStatus: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        totalPrice: order.total_price,
        currencyCode: order.currency,
      },
    });

    for (const item of order.line_items) {
      await tx.orderLineItem.upsert({
        where: { gid: item.admin_graphql_api_id },
        create: {
          gid: item.admin_graphql_api_id,
          orderGid: gid,
          variantGid: item.admin_graphql_api_variant_id,
          sku: item.sku,
          title: item.title,
          quantity: item.quantity,
          price: item.price,
        },
        update: {
          quantity: item.quantity,
          price: item.price,
        },
      });
    }
  });

  console.log(`  mirrored ${order.name} — ${order.line_items.length} line item(s)`);

  /**
   * Test orders must never reach a live ERP. The bogus gateway marks every
   * development order with test: true, and pushing one downstream creates a
   * shipment nobody ordered.
   */
  if (order.test && process.env['ALLOW_TEST_ORDERS'] !== 'yes') {
    console.log(`  test order — not pushed to ERP`);
    return `mirrored ${order.name} (test order, ERP skipped)`;
  }

  const key = idempotencyKey('erp-order', gid);

  /**
   * Separate from the ProcessedEvent guard: that one is keyed on the webhook,
   * this one on the order — so a *different* webhook for the same order also
   * won't double-push.
   */
  const priorConfirmed = await prisma.erpPush.findFirst({
    where: { orderGid: gid, status: 'confirmed' },
  });

  if (priorConfirmed) {
    console.log(`  already pushed as ${priorConfirmed.erpReference} — skipping`);
    return `mirrored ${order.name}, ERP push already confirmed`;
  }

  /**
   * PHASE 1 — record the intent before the call.
   *
   * No transaction can span Postgres and someone else's HTTP API. Writing
   * "attempting" first means a crash leaves evidence that a push may have
   * happened. Writing only after the call would leave no trace at all, and
   * the outcome would be unknowable.
   */
  const attemptCount = await prisma.erpPush.count({ where: { orderGid: gid } });

  const push = await prisma.erpPush.upsert({
    where: { idempotencyKey: key },
    create: {
      orderGid: gid,
      idempotencyKey: key,
      status: 'attempting',
      attempt: attemptCount + 1,
    },
    update: {
      status: 'attempting',
      attempt: attemptCount + 1,
      startedAt: new Date(),
      error: null,
    },
  });

  try {
    const result = await pushToErp(gid, key, order);

    // PHASE 2 — record the outcome.
    await prisma.erpPush.update({
      where: { id: push.id },
      data: {
        status: 'confirmed',
        erpReference: result.reference,
        completedAt: new Date(),
      },
    });

    const note = result.duplicate ? ' (ERP recognised duplicate)' : '';
    console.log(`  pushed to ERP as ${result.reference}${note}`);

    return `mirrored ${order.name}, pushed as ${result.reference}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    /**
     * A timeout or connection failure means the outcome is genuinely unknown
     * — the ERP may have processed it and lost the response. Marking this
     * `unknown` rather than `failed` is the honest distinction: a failure can
     * be retried freely, an unknown needs reconciliation against the ERP.
     */
    const isAmbiguous =
      message.includes('timeout') ||
      message.includes('aborted') ||
      message.includes('fetch failed');

    await prisma.erpPush.update({
      where: { id: push.id },
      data: {
        status: isAmbiguous ? 'unknown' : 'failed',
        error: message,
        completedAt: new Date(),
      },
    });

    throw err;
  }
}