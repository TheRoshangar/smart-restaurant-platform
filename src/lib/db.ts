/**
 * Database access and tenant context (SCOPE.md §4.2)
 *
 * Every query that touches tenant data runs inside withTenant(), which opens a
 * transaction and sets the `app.restaurant_id` GUC *locally* to it. The `true`
 * third argument to set_config is load-bearing: a session-level SET would leak
 * the tenant onto the next request that borrows the same pooled connection,
 * which is the exact bug this whole design exists to prevent.
 */

import pg from 'pg';
import { logger } from './log.js';

// BIGINT (OID 20) arrives as a string to avoid silent precision loss. We convert
// deliberately at the edge, in money.toRial(), rather than letting pg guess.
pg.types.setTypeParser(20, (v) => v);

export type Client = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Domestic PaaS Postgres commonly terminates idle TLS sessions aggressively.
      keepAlive: true,
    });
    pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  }
  return pool;
}

export interface TenantContext {
  restaurantId: string;
  staffId?: string;
  role?: string;
  requestId?: string;
}

/**
 * Run `fn` in a transaction scoped to one restaurant.
 *
 * If this is not called, or is called with a bad id, RLS makes the database look
 * empty rather than shared: app.current_restaurant_id() returns NULL and every
 * policy comparison evaluates to NULL, not true.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.restaurant_id', $1, true)", [ctx.restaurantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The login path only. Runs with no tenant set, and may call exactly one
 * SECURITY DEFINER function. Separated so that "queries that run untenanted"
 * is a list of length one that a reviewer can check.
 */
export async function withoutTenant<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Refuse to run if the connection role can bypass row-level security.
 *
 * This exists because it caught a real bug in this codebase. The isolation test
 * asserted that `mizban_app` is not a superuser — and it passed — while the
 * application pool was connecting as `postgres`, which is. Superusers bypass RLS
 * unconditionally, so every tenant policy was silently inert, and a cross-tenant
 * request returned another restaurant's orders. The test verified the role; it
 * did not verify that the app was USING that role.
 *
 * The realistic production version of this mistake is someone copying the admin
 * connection string into .env because migrations needed it. That must be a
 * refusal to boot, not a silent loss of every tenancy guarantee.
 */
export async function assertNonPrivilegedRole(): Promise<void> {
  const { rows } = await getPool().query<{
    who: string; is_super: boolean; can_bypass: boolean;
  }>(`SELECT current_user AS who,
             rolsuper     AS is_super,
             rolbypassrls AS can_bypass
        FROM pg_roles WHERE rolname = current_user`);

  const role = rows[0];
  if (!role) throw new Error('could not determine database role');

  if (role.is_super || role.can_bypass) {
    throw new Error(
      `REFUSING TO START: connected as "${role.who}", which bypasses row-level security. ` +
      `Tenant isolation would be silently disabled. Point DATABASE_URL at the ` +
      `application role (mizban_app) and use DATABASE_URL_ADMIN for migrations.`,
    );
  }

  // Owners bypass RLS unless FORCE is set. FORCE is set in 0002_rls.sql, but if
  // a future migration drops it this is where we would rather find out.
  const { rows: owned } = await getPool().query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND pg_get_userbyid(c.relowner) = current_user
        AND NOT c.relforcerowsecurity`);
  if (owned.length > 0) {
    throw new Error(
      `REFUSING TO START: role owns tables without FORCE ROW LEVEL SECURITY: ` +
      owned.map((r) => r.relname).join(', '));
  }

  logger.info({ event: 'db.role_verified', role: role.who }, 'database role cannot bypass RLS');
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
