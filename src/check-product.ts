import { prisma, disconnect } from './db.js';
import { handleFatal } from './exit.js';

async function main(): Promise<void> {
  const title = process.env['TITLE'] ?? '';

  const products = await prisma.product.findMany({
    where: { title: { contains: title } },
    select: {
      gid: true,
      title: true,
      handle: true,
      status: true,
      updatedAt: true,
      deletedAt: true,
    },
    take: 10,
  });

  if (products.length === 0) {
    console.log(`No product in Postgres with title containing "${title}"`);
    return;
  }

  for (const p of products) {
    console.log(`${p.title}`);
    console.log(`  gid:       ${p.gid}`);
    console.log(`  handle:    ${p.handle}`);
    console.log(`  status:    ${p.status}`);
    console.log(`  updatedAt: ${p.updatedAt.toISOString()}`);
    console.log(`  deletedAt: ${p.deletedAt?.toISOString() ?? 'null'}\n`);
  }

  await disconnect();
}

main().catch(handleFatal);