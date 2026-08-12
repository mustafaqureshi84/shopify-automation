import { webhookQueue, closeQueue } from './queue.js';
import { handleFatal } from './exit.js';

async function main(): Promise<void> {
  const counts = await webhookQueue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed'
  );

  console.log('Queue: shopify-webhooks\n');
  for (const [state, count] of Object.entries(counts)) {
    console.log(`  ${state.padEnd(10)} ${count}`);
  }

  const failed = await webhookQueue.getFailed(0, 9);

  if (failed.length > 0) {
    console.log(`\nFailed jobs (${failed.length} shown):\n`);

    for (const job of failed) {
      console.log(`  ${job.id} — ${job.name}`);
      console.log(`    attempts: ${job.attemptsMade}`);
      console.log(`    reason:   ${job.failedReason}`);
      console.log(`    shop:     ${job.data.shop}\n`);
    }

    console.log('Retry all with: $env:RETRY="yes"; npx tsx src/queue-monitor.ts');
  }

  if (process.env['RETRY'] === 'yes' && failed.length > 0) {
    console.log('\nRetrying failed jobs...');
    for (const job of failed) {
      await job.retry();
      console.log(`  requeued ${job.id}`);
    }
  }

  await closeQueue();
}

main().catch(handleFatal);