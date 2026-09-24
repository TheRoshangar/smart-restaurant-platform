/**
 * Entrypoint.
 *
 * Configuration is validated at boot and the process refuses to start if
 * anything required is missing or weak. A server that starts with a default JWT
 * secret and fails later, in production, at 21:00, is strictly worse than one
 * that refuses to start at all.
 */

import { z } from 'zod';
import { buildApp } from './http/app.js';
import { logger } from './lib/log.js';
import { closePool, getPool, assertNonPrivilegedRole } from './lib/db.js';
import { pruneIdempotencyKeys } from './lib/idempotency.js';
import 'dotenv/config';

const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // No default. A default secret in a repo is the same as no secret.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.string().default('development'),

  // Optional. Absent means menu import runs heuristic-only, which is a supported
  // mode, not a degraded one — see SCOPE.md §5.
  AI_BASE_URL: z.string().url().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
});

async function main(): Promise<void> {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    // Printed as field errors, never as the values themselves.
    console.error('Invalid configuration:');
    for (const [key, msgs] of Object.entries(parsed.error.flatten().fieldErrors)) {
      console.error(`  ${key}: ${msgs?.join(', ')}`);
    }
    process.exit(1);
  }
  const env = parsed.data;

  const app = await buildApp();

  // Fail fast on a database that is not reachable, rather than serving 500s.
  await getPool().query('SELECT 1');

  // And fail fast if the role we connected as would make RLS inert.
  await assertNonPrivilegedRole();

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({
    event: 'server.started', port: env.PORT,
    ai_configured: Boolean(env.AI_API_KEY && env.AI_BASE_URL),
  }, 'mizban started');

  // Single-instance deployment, so housekeeping lives in the process. At two
  // instances this moves to a scheduled job so it does not run twice.
  const prune = setInterval(() => {
    getPool().connect()
      .then(async (c) => {
        try {
          const n = await pruneIdempotencyKeys(c);
          if (n > 0) logger.info({ event: 'idempotency.pruned', count: n }, 'pruned keys');
        } finally { c.release(); }
      })
      .catch((err) => logger.error({ err, event: 'idempotency.prune_failed' }, 'prune failed'));
  }, 60 * 60 * 1000);

  const shutdown = async (signal: string) => {
    logger.info({ event: 'server.shutdown', signal }, 'shutting down');
    clearInterval(prune);
    // Close the listener first so in-flight requests finish before the pool goes.
    await app.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err, event: 'server.start_failed' }, 'failed to start');
  process.exit(1);
});
