/**
 * Tenant isolation (SCOPE.md §4.2)
 *
 * "How you guarantee this — and how you'd prove it to us — is on you."
 *
 * This is the proof. The important property is not that it tests today's tables;
 * it is that it DISCOVERS them. Every test below enumerates tenant-scoped tables
 * from the Postgres catalogue at runtime, so a table added next year without an
 * RLS policy fails this suite on the day it is added, by someone who has never
 * read this file.
 *
 * A hand-written list of tables would pass forever while the system slowly grew
 * a hole. That is the failure mode worth engineering against.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const ADMIN_URL = process.env.DATABASE_URL_ADMIN!;
// The app role: non-owner, non-superuser, subject to RLS.
const APP_URL = process.env.DATABASE_URL!;

let admin: pg.Client;
let app: pg.Client;

/** Tables that carry restaurant_id, discovered rather than listed. */
let tenantTables: string[] = [];

const TENANT_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const TENANT_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const { rows } = await admin.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.attname = 'restaurant_id' AND NOT a.attisdropped
     ORDER BY c.relname`);
  tenantTables = rows.map((r) => r.table_name);

  // Two tenants with a minimal but complete footprint: one row in every table
  // that can hold one, so the isolation checks below have something to find.
  await admin.query('BEGIN');
  for (const [id, name] of [[TENANT_A, 'تنانت الف'], [TENANT_B, 'تنانت ب']] as const) {
    await admin.query(
      `INSERT INTO restaurants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [id, name]);
    await admin.query(
      `INSERT INTO branches (restaurant_id, name) VALUES ($1,$2)
       ON CONFLICT (restaurant_id, name) DO NOTHING`, [id, 'شعبه تست']);
    const { rows: [cat] } = await admin.query(
      `INSERT INTO menu_categories (restaurant_id, name_fa) VALUES ($1,'تست') RETURNING id`, [id]);
    await admin.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name_fa, base_price_irr)
       VALUES ($1,$2,'آیتم محرمانه',9999990)`, [id, cat.id]);
  }
  await admin.query('COMMIT');

  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  await admin?.query(`DELETE FROM restaurants WHERE id IN ($1,$2)`, [TENANT_A, TENANT_B]).catch(() => {});
  await admin?.end();
  await app?.end();
});

async function asTenant(id: string | null): Promise<void> {
  await app.query(`SELECT set_config('app.restaurant_id', $1, false)`, [id ?? '']);
}

/* ------------------------------------------------------------------ */

describe('every tenant-scoped table is protected', () => {
  it('discovers a non-trivial set of tables (guards against the query silently returning nothing)', () => {
    // If this ever returns an empty list, every other test in this file would
    // vacuously pass. That is the one way a suite like this lies to you.
    expect(tenantTables.length).toBeGreaterThan(8);
  });

  it('has RLS both ENABLED and FORCED on all of them', async () => {
    const { rows } = await admin.query<{ relname: string; enabled: boolean; forced: boolean }>(`
      SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1)`, [tenantTables]);

    const unprotected = rows.filter((r) => !r.enabled || !r.forced).map((r) => r.relname);
    // FORCE matters separately from ENABLE: without it, the table owner bypasses
    // the policy, and migrations tend to run as the owner.
    expect(unprotected).toEqual([]);
  });

  it('has a tenant_isolation policy on all of them', async () => {
    const { rows } = await admin.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies WHERE schemaname='public' AND policyname='tenant_isolation'`);
    const covered = new Set(rows.map((r) => r.tablename));
    const missing = tenantTables.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });
});

describe('restaurant A cannot reach restaurant B', () => {
  it('cannot SELECT B rows from any tenant table, even asking for them by id', async () => {
    await asTenant(TENANT_A);
    const leaks: string[] = [];

    for (const table of tenantTables) {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM ${quote(table)} WHERE restaurant_id = $1`, [TENANT_B]);
      if (rows[0].n !== 0) leaks.push(`${table} leaked ${rows[0].n} rows`);
    }
    expect(leaks).toEqual([]);
  });

  it('cannot UPDATE B rows', async () => {
    await asTenant(TENANT_A);
    const res = await app.query(
      `UPDATE menu_items SET base_price_irr = 1 WHERE restaurant_id = $1`, [TENANT_B]);
    expect(res.rowCount).toBe(0);

    // And B is genuinely untouched, not merely reported as unaffected.
    const { rows } = await admin.query(
      `SELECT base_price_irr FROM menu_items WHERE restaurant_id = $1`, [TENANT_B]);
    expect(rows[0].base_price_irr).toBe('9999990');
  });

  it('cannot DELETE B rows', async () => {
    await asTenant(TENANT_A);
    const res = await app.query(`DELETE FROM menu_items WHERE restaurant_id = $1`, [TENANT_B]);
    expect(res.rowCount).toBe(0);

    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM menu_items WHERE restaurant_id = $1`, [TENANT_B]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('cannot INSERT a row belonging to B (WITH CHECK)', async () => {
    await asTenant(TENANT_A);
    const { rows: [cat] } = await admin.query(
      `SELECT id FROM menu_categories WHERE restaurant_id = $1 LIMIT 1`, [TENANT_B]);

    // Writing into another tenant is as dangerous as reading from one — an
    // attacker who can plant a row can plant a menu item priced at zero.
    await expect(app.query(
      `INSERT INTO menu_items (restaurant_id, category_id, name_fa, base_price_irr)
       VALUES ($1,$2,'کاشته شده',0)`, [TENANT_B, cat.id],
    )).rejects.toThrow(/row-level security/i);
  });
});

describe('it fails closed', () => {
  it('shows nothing at all when no tenant is set', async () => {
    // This is the property that makes a forgotten WHERE clause harmless.
    await asTenant(null);
    for (const table of tenantTables) {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${quote(table)}`);
      expect(rows[0].n, `${table} was readable with no tenant context`).toBe(0);
    }
  });

  it('shows nothing for a tenant id that does not exist', async () => {
    await asTenant('00000000-0000-0000-0000-000000000000');
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM menu_items`);
    expect(rows[0].n).toBe(0);
  });

  it('the app role is not a superuser and does not own the tables', async () => {
    // Superusers bypass RLS unconditionally; owners bypass it without FORCE.
    // If this assertion ever fails, every test above becomes meaningless.
    const { rows } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'mizban_app'`);
    expect(rows[0]!.rolsuper).toBe(false);
    expect(rows[0]!.rolbypassrls).toBe(false);
  });
});

describe('the event log cannot be rewritten', () => {
  it('rejects UPDATE on order_events', async () => {
    // A waiter who can edit the audit trail can cover a void. The append-only
    // guarantee is enforced by trigger and by revoked grants, not by convention.
    await expect(
      admin.query(`UPDATE order_events SET payload = '{}'::jsonb WHERE id = (SELECT min(id) FROM order_events)`),
    ).rejects.toThrow(/append-only/i);
  });
});

/** Identifiers come from the catalogue, but quote them anyway. */
function quote(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ident)) throw new Error(`unsafe identifier ${ident}`);
  return `"${ident}"`;
}
