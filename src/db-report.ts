import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';

async function main(): Promise<void> {
  const products = await prisma.product.count({ where: { deletedAt: null } });
  const deletedProducts = await prisma.product.count({
    where: { deletedAt: { not: null } },
  });
  const variants = await prisma.variant.count({ where: { deletedAt: null } });

  const byStatus = await prisma.product.groupBy({
    by: ['status'],
    where: { deletedAt: null },
    _count: true,
    orderBy: { status: 'asc' },
  });

  const inventory = await prisma.product.aggregate({
    where: { deletedAt: null },
    _sum: { totalInventory: true },
  });

  const noSku = await prisma.variant.count({
    where: { deletedAt: null, sku: null },
  });

  console.log(`Products:  ${products} live, ${deletedProducts} deleted`);
  for (const row of byStatus) {
    console.log(`  ${row.status}: ${row._count}`);
  }
  console.log(`Variants:  ${variants} live`);
  console.log(`  without SKU: ${noSku}`);
  console.log(`Total inventory: ${inventory._sum.totalInventory ?? 0}`);

  const runs = await prisma.syncRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: 5,
  });

  console.log('\nRecent sync runs:\n');

  for (const run of runs) {
    const seconds = run.finishedAt
      ? ((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1)
      : '—';

    console.log(
      `${run.startedAt.toISOString()} [${run.status}] ${seconds}s — ` +
        `${run.productsSeen} seen, ${run.productsCreated} created, ` +
        `${run.productsUpdated} updated, ${run.productsUnchanged} unchanged, ` +
        `${run.productsDeleted} deleted`
    );

    if (run.error) console.log(`  error: ${run.error}`);
  }

  await disconnect();
}

main().catch(handleFatal);