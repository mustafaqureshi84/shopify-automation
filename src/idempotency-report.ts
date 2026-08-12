import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';

async function main(): Promise<void> {
  const processed = await prisma.processedEvent.count();
  const notifications = await prisma.warehouseNotification.count();

  console.log(`Processed events:       ${processed}`);
  console.log(`Warehouse notifications: ${notifications}\n`);

  const recent = await prisma.processedEvent.findMany({
    orderBy: { processedAt: 'desc' },
    take: 5,
  });

  if (recent.length > 0) {
    console.log('Recent processed events:\n');
    for (const event of recent) {
      console.log(`  ${event.webhookId}`);
      console.log(`    ${event.topic} — ${event.summary ?? '(no summary)'}`);
      console.log(`    ${event.processedAt.toISOString()}\n`);
    }
  }

  // Duplicates here mean the same change was announced more than once.
  const grouped = await prisma.warehouseNotification.groupBy({
    by: ['productGid'],
    _count: true,
    orderBy: { _count: { productGid: 'desc' } },
    take: 5,
  });

  if (grouped.length > 0) {
    console.log('Notifications per product:\n');
    for (const row of grouped) {
      const flag = row._count > 1 ? '  <-- DUPLICATE' : '';
      console.log(`  ${row.productGid}: ${row._count}${flag}`);
    }
  }

  await disconnect();
}

main().catch(handleFatal);