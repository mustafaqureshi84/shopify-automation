import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { ConfigError } from './errors.js';

const connectionString = process.env['DATABASE_URL'];

if (!connectionString) {
  throw new ConfigError(
    'Missing required environment variable: DATABASE_URL\n' +
      'Check your .env file at the project root.'
  );
}

/**
 * Prisma 7 no longer bundles a database driver. The client is constructed
 * with a driver adapter, which is why `prisma.config.ts` only configures
 * the CLI — the runtime connection is established here.
 *
 * One client for the process: Prisma manages a connection pool internally,
 * and creating a client per call would exhaust Neon's connection cap.
 * Pool exhaustion presents as a hang, not a clear error.
 */
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}