/**
 * Idempotency (SCOPE.md §2.5, §4.1)
 *
 * The single most important reliability decision in the build, and it exists
 * because of a local condition rather than a general principle: international
 * connectivity from Iran drops, so the client WILL retry, so "add pizza" will
 * arrive twice. Without this, a dropped response costs the customer a pizza and
 * costs the café an argument.
 *
 * Every mutating request carries a client-generated Idempotency-Key. The stored
 * response is replayed on retry. The request body is hashed so that reusing a key
 * with different content is an error rather than a silent wrong answer.
 */

import { createHash } from 'node:crypto';
import type { Client } from './db.js';
import { errors } from './errors.js';
import { logger } from './log.js';

const PG_UNIQUE_VIOLATION = '23505';

export function hashRequest(endpoint: string, body: unknown): string {
  return createHash('sha256')
    .update(endpoint)
    .update('\0')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Runs `fn` at most once per (restaurant, key).
 *
 * The claim is inserted BEFORE the work, inside the same transaction, so two
 * concurrent retries of the same request cannot both execute: the second one
 * hits the primary key and is told to wait, then replays. This is the reason the
 * claim row carries a placeholder status that is updated afterwards, rather than
 * being written at the end.
 */
export async function withIdempotency<T>(
  client: Client,
  opts: { restaurantId: string; key: string | undefined; endpoint: string; body: unknown },
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  // No key supplied: the caller accepts at-least-once semantics. Reads and
  // genuinely idempotent operations (status transitions are conditional and
  // therefore already safe) do not need one.
  if (!opts.key) {
    return { result: await fn(), replayed: false };
  }

  const requestHash = hashRequest(opts.endpoint, opts.body);

  const existing = await client.query<{
    request_hash: string; response_status: number; response_body: unknown;
  }>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_keys WHERE restaurant_id = $1 AND key = $2`,
    [opts.restaurantId, opts.key],
  );

  if (existing.rowCount && existing.rows[0]) {
    const row = existing.rows[0];
    // Same key, different body: the client has a bug, or someone is replaying a
    // captured request against different content. Refuse rather than guess.
    if (row.request_hash !== requestHash) throw errors.idempotencyMismatch();

    logger.info({
      event: 'idempotency.replayed', restaurant_id: opts.restaurantId, endpoint: opts.endpoint,
    }, 'replayed stored response');

    return { result: row.response_body as T, replayed: true };
  }

  try {
    await client.query(
      `INSERT INTO idempotency_keys
         (restaurant_id, key, endpoint, request_hash, response_status, response_body)
       VALUES ($1,$2,$3,$4,0,'null'::jsonb)`,
      [opts.restaurantId, opts.key, opts.endpoint, requestHash],
    );
  } catch (err) {
    if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      // Lost the race with a concurrent retry. The winner's transaction will
      // commit the real response; surfacing a conflict lets the client retry
      // once more and hit the replay path above.
      throw errors.idempotencyMismatch();
    }
    throw err;
  }

  const result = await fn();

  await client.query(
    `UPDATE idempotency_keys SET response_status = 200, response_body = $3
      WHERE restaurant_id = $1 AND key = $2`,
    [opts.restaurantId, opts.key, JSON.stringify(result)],
  );

  return { result, replayed: false };
}

/**
 * Keys are kept 24h — comfortably longer than any realistic retry window and
 * short enough that the table stays small. Called from a scheduled task, or on
 * boot in the single-instance deployment this ships as.
 */
export async function pruneIdempotencyKeys(client: Client): Promise<number> {
  const res = await client.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  return res.rowCount ?? 0;
}
