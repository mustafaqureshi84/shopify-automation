import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';

async function main(): Promise<void> {
  const pushes = await prisma.erpPush.findMany({
    orderBy: { startedAt: 'desc' },
    take: 20,
    include: { order: { select: { orderNumber: true } } },
  });

  if (pushes.length === 0) {
    console.log('No ERP pushes recorded.');
    await disconnect();
    return;
  }

  const counts = new Map<string, number>();
  for (const p of pushes) {
    counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  }

  console.log('By status:');
  for (const [status, count] of counts) {
    console.log(`  ${status.padEnd(12)} ${count}`);
  }

  console.log('\nRecent pushes:\n');

  for (const p of pushes) {
    console.log(`${p.order.orderNumber} — ${p.status} (attempt ${p.attempt})`);
    console.log(`  key:       ${p.idempotencyKey}`);
    console.log(`  reference: ${p.erpReference ?? '(none)'}`);
    if (p.error) console.log(`  error:     ${p.error}`);
    console.log('');
  }

  const unknown = pushes.filter((p) => p.status === 'unknown');

  if (unknown.length > 0) {
    console.log(
      `${unknown.length} push(es) in UNKNOWN state — the ERP may or may not`
    );
    console.log('have them. Reconcile against the ERP rather than retrying blindly.');
  }

  await disconnect();
}

main().catch(handleFatal);