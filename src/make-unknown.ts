import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';

/**
 * Test tooling. Forces an ErpPush into the `unknown` state so the
 * reconciliation path can be exercised without racing a retry window.
 *
 * `unknown` is genuinely hard to produce on purpose here, because the
 * derived idempotency key plus the ERP's deduplication mean retries keep
 * succeeding — which is the system working, but leaves the state unreachable.
 */
async function main(): Promise<void> {
  const orderNumber = process.env['ORDER'] ?? '#1001';

  const order = await prisma.order.findFirst({
    where: { orderNumber },
    include: { erpPushes: true },
  });

  if (!order) {
    console.log(`No order found with number ${orderNumber}`);
    await disconnect();
    return;
  }

  const push = order.erpPushes[0];

  if (!push) {
    console.log(`${orderNumber} has no ERP push recorded`);
    await disconnect();
    return;
  }

  await prisma.erpPush.update({
    where: { id: push.id },
    data: {
      status: 'unknown',
      erpReference: null,
      error: 'Simulated: response lost, outcome undetermined',
    },
  });

  console.log(`${orderNumber} push forced to 'unknown'`);
  console.log(`  key: ${push.idempotencyKey}`);
  console.log('\nThe ERP still holds this order. Run reconcile-erp.ts.');

  await disconnect();
}

main().catch(handleFatal);