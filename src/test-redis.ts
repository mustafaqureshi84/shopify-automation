import 'dotenv/config';
import IORedis from 'ioredis';
import { ConfigError } from './errors.js';
import { handleFatal } from './exit.js';

const url = process.env['REDIS_URL'];

if (!url) {
  throw new ConfigError('Missing REDIS_URL in .env');
}

async function main(): Promise<void> {
  const redis = new IORedis(url!, { maxRetriesPerRequest: null });

  await redis.set('automation-lab:ping', 'pong');
  const value = await redis.get('automation-lab:ping');
  await redis.del('automation-lab:ping');

  console.log(`Redis round-trip: ${value}`);

  const info = await redis.info('server');
  const version = info.match(/redis_version:(\S+)/)?.[1] ?? 'unknown';
  console.log(`Server version: ${version}`);

  await redis.quit();
}

main().catch(handleFatal);