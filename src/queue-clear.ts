import { webhookQueue, closeQueue } from './queue.js';
import { handleFatal } from './exit.js';

async function main(): Promise<void> {
  if (process.env['CONFIRM'] !== 'yes') {
    console.log('This clears all completed and failed jobs from the queue.');
    console.log('Job history is lost — deduplication resets with it.\n');
    console.log('Rerun with CONFIRM=yes:');
    console.log('  $env:CONFIRM="yes"; npx tsx src/queue-clear.ts');
    return;
  }

  const before = await webhookQueue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed'
  );

  console.log('Before:', before);

  await webhookQueue.obliterate({ force: true });

  console.log('\nQueue cleared.');
  console.log('Any webhook ID can now be enqueued again as a new job.');

  await closeQueue();
}

main().catch(handleFatal);