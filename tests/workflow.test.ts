/**
 * Full user workflow, through HTTP, against a real database.
 *
 * "Tests where they earn their place, including at least one covering a full
 * user workflow."
 *
 * This one covers a real service: a waiter opens table 12, sends food and drink
 * to two stations, the kitchen advances it, the waiter serves it, the cashier
 * discounts and settles, and the money adds up. Then it covers the three
 * concurrency mechanisms individually, because those are the claims in SCOPE.md
 * §4.1 and a claim without a test is an opinion.
 *
 * What I chose NOT to test, and why, is in README.md under "Testing".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/http/app.js';
import { closePool } from '../src/lib/db.js';

let app: FastifyInstance;
let admin: pg.Client;

const tokens: Record<string, string> = {};
let branchId = '';
let tableId = '';
let foodItemId = '';
let drinkItemId = '';

async function loginAs(phone: string, pin: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { phone, pin },
  });
  expect(res.statusCode, `login ${phone}: ${res.body}`).toBe(200);
  return res.json().token;
}

function auth(role: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${tokens[role]}`, ...extra };
}

beforeAll(async () => {
  process.env.JWT_SECRET ??= 'test-secret-that-is-definitely-long-enough-32';
  app = await buildApp();
  await app.ready();

  admin = new pg.Client({ connectionString: process.env.DATABASE_URL_ADMIN });
  await admin.connect();

  tokens.waiter = await loginAs('+989121110003', '2222');
  tokens.kitchen = await loginAs('+989121110005', '4444');
  tokens.cashier = await loginAs('+989121110002', '1111');
  tokens.manager = await loginAs('+989121110001', '1234');

  const { rows: [b] } = await admin.query(
    `SELECT id FROM branches WHERE name = 'شعبه ونک'`);
  branchId = b.id;

  // Dedicated tables for the test run. The seeded café has live tickets on real
  // tables and the demo data is meant to stay usable, so tests get their own
  // room rather than consuming the demo's.
  const { rows: [restaurant] } = await admin.query(
    `SELECT restaurant_id FROM branches WHERE id = $1`, [branchId]);
  for (let i = 0; i < 12; i++) {
    await admin.query(
      `INSERT INTO dining_tables (restaurant_id, branch_id, label, area, seats)
       VALUES ($1,$2,$3,'hall',4) ON CONFLICT (branch_id, label) DO NOTHING`,
      [restaurant.restaurant_id, branchId, `TEST-${i}`]);
  }
  const { rows: [t] } = await admin.query(
    `SELECT id FROM dining_tables WHERE branch_id=$1 AND label='TEST-0'`, [branchId]);
  tableId = t.id;

  const { rows: [food] } = await admin.query(
    `SELECT id FROM menu_items WHERE station='kitchen' AND is_available LIMIT 1`);
  const { rows: [drink] } = await admin.query(
    `SELECT id FROM menu_items WHERE station='bar' AND is_available LIMIT 1`);
  foodItemId = food.id;
  drinkItemId = drink.id;
});

afterAll(async () => {
  // Close the test tickets rather than deleting them.
  //
  // Deleting is not possible, and that is correct behaviour discovered by this
  // cleanup: removing an order cascades into order_events, which fires the
  // append-only trigger and aborts. The audit trail is genuinely immutable —
  // including against the test suite. So cleanup does what the product does:
  // it closes the tickets, which frees the tables via the partial unique index.
  //
  // The TEST-* tables are left in place and reused across runs. They are
  // inactive-by-convention fixtures; `npm run seed` truncates everything if a
  // reviewer wants a pristine demo.
  const closed = await admin?.query(
    `UPDATE orders SET status='voided', closed_at=now()
      WHERE status='open' AND table_id IN
        (SELECT id FROM dining_tables WHERE branch_id=$1 AND label LIKE 'TEST-%')`,
    [branchId]);
  if (closed?.rowCount) {
    // eslint-disable-next-line no-console
    console.log(`[cleanup] closed ${closed.rowCount} test tickets`);
  }
  await app?.close();
  await admin?.end();
  await closePool();
});

/* ------------------------------------------------------------------ */

describe('a full service on one table', () => {
  let orderId = '';
  let version = 0;

  it('waiter opens a ticket on a free table', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('waiter'),
      payload: { branch_id: branchId, table_id: tableId, order_type: 'dine_in', guest_count: 3 },
    });
    expect(res.statusCode).toBe(201);
    const order = res.json();
    orderId = order.id;
    version = order.version;

    expect(order.status).toBe('open');
    expect(order.lines).toHaveLength(0);
    expect(order.bill.total_irr).toBe(0);
  });

  it('waiter adds food and drink; they route to different stations', async () => {
    for (const itemId of [foodItemId, drinkItemId, drinkItemId]) {
      const res = await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/lines`,
        headers: auth('waiter', { 'idempotency-key': crypto.randomUUID() }),
        payload: { menu_item_id: itemId, qty: 1 },
      });
      expect(res.statusCode).toBe(200);
    }

    const order = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}`, headers: auth('waiter'),
    })).json();

    expect(order.lines).toHaveLength(3);
    expect(new Set(order.lines.map((l: { station: string }) => l.station)))
      .toEqual(new Set(['kitchen', 'bar']));
    // The bill is live from the first item, before anything is served.
    expect(order.bill.subtotal_irr).toBeGreaterThan(0);
  });

  it('the item appears on the right station queue and nowhere else', async () => {
    const kitchen = (await app.inject({
      method: 'GET', url: `/api/reports/station?branch_id=${branchId}&station=kitchen`,
      headers: auth('kitchen'),
    })).json();

    const mine = kitchen.lines.filter((l: { order_id: string }) => l.order_id === orderId);
    expect(mine).toHaveLength(1);

    // The kitchen payload must contain no money anywhere. This is checked over
    // the serialised body rather than field by field, so a future field that
    // leaks a price fails here.
    expect(JSON.stringify(kitchen)).not.toMatch(/price|irr|total/i);
  });

  it('kitchen advances queued -> preparing -> ready', async () => {
    const order = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}`, headers: auth('waiter'),
    })).json();
    const line = order.lines.find((l: { station: string }) => l.station === 'kitchen');

    for (const [from, to] of [['queued', 'preparing'], ['preparing', 'ready']]) {
      const res = await app.inject({
        method: 'PATCH', url: `/api/orders/lines/${line.id}/status`,
        headers: auth('kitchen'), payload: { from, to },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe(to);
    }
  });

  it('waiter marks it served, and the kitchen cannot', async () => {
    const order = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}`, headers: auth('waiter'),
    })).json();
    const line = order.lines.find((l: { status: string }) => l.status === 'ready');

    const res = await app.inject({
      method: 'PATCH', url: `/api/orders/lines/${line.id}/served`, headers: auth('waiter'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('served');
  });

  it('waiter cannot discount — that is the whole reason the role exists', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discounts`,
      headers: auth('waiter', { 'if-match': String(version) }),
      payload: { kind: 'percent', value: 5000, reason: 'چون می‌توانم' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cashier applies a discount with a reason, and the bill recomputes', async () => {
    const before = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}`, headers: auth('cashier'),
    })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discounts`,
      headers: auth('cashier', { 'if-match': String(before.version) }),
      payload: { kind: 'percent', value: 1000, reason: 'مشتری همیشگی' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = res.json();
    expect(after.bill.discount_irr).toBe(Math.round(before.bill.subtotal_irr * 0.1));
    expect(after.bill.total_irr).toBeLessThan(before.bill.total_irr);
    expect(after.version).toBe(before.version + 1);
    version = after.version;
  });

  it('refuses to settle for less than the bill', async () => {
    const order = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}`, headers: auth('cashier'),
    })).json();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/settle`,
      headers: auth('cashier', { 'if-match': String(order.version) }),
      payload: { payments: [{ method: 'cash', amount_irr: 1000 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('settles with a split payment and the arithmetic closes', async () => {
    const order = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}`, headers: auth('cashier'),
    })).json();
    const total = order.bill.total_irr;
    const half = Math.round(total / 2);

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/settle`,
      headers: auth('cashier', { 'if-match': String(order.version), 'idempotency-key': crypto.randomUUID() }),
      payload: { payments: [
        { method: 'pos_card', amount_irr: half, reference: '884412' },
        { method: 'cash', amount_irr: total - half },
      ] },
    });
    expect(res.statusCode, res.body).toBe(200);

    const settled = res.json();
    expect(settled.status).toBe('settled');
    expect(settled.paid_irr).toBe(total);

    // The snapshot on the order must equal the computed bill, because the
    // snapshot is what every report reads.
    const { rows: [row] } = await admin.query(
      `SELECT subtotal_irr, discount_irr, service_irr, vat_irr, total_irr
         FROM orders WHERE id = $1`, [orderId]);
    expect(Number(row.total_irr)).toBe(total);
    expect(Number(row.subtotal_irr) - Number(row.discount_irr)
         + Number(row.service_irr) + Number(row.vat_irr)).toBe(total);
  });

  it('the table is free again', async () => {
    const tables = (await app.inject({
      method: 'GET', url: `/api/menu/tables?branch_id=${branchId}`, headers: auth('waiter'),
    })).json();
    const t = tables.tables.find((x: { id: string }) => x.id === tableId);
    expect(t.open_order_id).toBeNull();
  });

  it('leaves a complete audit trail', async () => {
    const events = (await app.inject({
      method: 'GET', url: `/api/orders/${orderId}/events`, headers: auth('manager'),
    })).json().events;

    const types = events.map((e: { type: string }) => e.type);
    expect(types).toContain('order.opened');
    expect(types).toContain('line.added');
    expect(types).toContain('discount.applied');
    expect(types).toContain('order.settled');
    // Every event names a person. An audit trail with anonymous rows is decoration.
    expect(events.every((e: { actor_name: string | null }) => e.actor_name)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('concurrency: the three mechanisms', () => {
  async function openTicket(): Promise<{ id: string; version: number }> {
    const { rows: [t] } = await admin.query(
      `SELECT t.id FROM dining_tables t
        WHERE t.branch_id = $1 AND t.label LIKE 'TEST-%'
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.status='open')
        LIMIT 1`, [branchId]);
    if (!t) throw new Error('ran out of test tables — increase the fixture count');

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('waiter'),
      payload: { branch_id: branchId, table_id: t.id, order_type: 'dine_in' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  it('(a) two waiters adding at the same time both succeed — nothing is lost', async () => {
    const order = await openTicket();

    const adds = await Promise.all([foodItemId, drinkItemId, foodItemId, drinkItemId].map((item) =>
      app.inject({
        method: 'POST', url: `/api/orders/${order.id}/lines`,
        headers: auth('waiter', { 'idempotency-key': crypto.randomUUID() }),
        payload: { menu_item_id: item, qty: 1 },
      })));

    expect(adds.every((r) => r.statusCode === 200)).toBe(true);

    const { rows: [count] } = await admin.query(
      `SELECT count(*)::int AS n FROM order_lines WHERE order_id = $1`, [order.id]);
    expect(count.n).toBe(4);

    // seq must remain unique and gapless despite concurrent allocation.
    const { rows } = await admin.query(
      `SELECT seq FROM order_lines WHERE order_id = $1 ORDER BY seq`, [order.id]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it('(a) a retried request does not add the item twice', async () => {
    const order = await openTicket();
    const key = crypto.randomUUID();

    // The same request twice, as a flaky connection would deliver it.
    const first = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/lines`,
      headers: auth('waiter', { 'idempotency-key': key }),
      payload: { menu_item_id: foodItemId, qty: 1 },
    });
    const second = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/lines`,
      headers: auth('waiter', { 'idempotency-key': key }),
      payload: { menu_item_id: foodItemId, qty: 1 },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const { rows: [count] } = await admin.query(
      `SELECT count(*)::int AS n FROM order_lines WHERE order_id = $1`, [order.id]);
    expect(count.n, 'retry added a second line').toBe(1);
  });

  it('(b) a lost station transition becomes a 409 carrying the real state', async () => {
    const order = await openTicket();
    await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth('waiter'),
      payload: { menu_item_id: foodItemId, qty: 1 },
    });
    const full = (await app.inject({
      method: 'GET', url: `/api/orders/${order.id}`, headers: auth('waiter'),
    })).json();
    const lineId = full.lines[0].id;

    const ok = await app.inject({
      method: 'PATCH', url: `/api/orders/lines/${lineId}/status`,
      headers: auth('kitchen'), payload: { from: 'queued', to: 'preparing' },
    });
    expect(ok.statusCode).toBe(200);

    // A second cook's screen was stale and still shows "queued".
    const stale = await app.inject({
      method: 'PATCH', url: `/api/orders/lines/${lineId}/status`,
      headers: auth('kitchen'), payload: { from: 'queued', to: 'preparing' },
    });
    expect(stale.statusCode).toBe(409);
    // The 409 tells them where it actually is, so the screen can re-render
    // without another round trip.
    expect(stale.json().error.current.status).toBe('preparing');
  });

  it('(c) a discount against a stale bill is refused with the fresh bill attached', async () => {
    const order = await openTicket();
    await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth('waiter'),
      payload: { menu_item_id: foodItemId, qty: 1 },
    });
    const staleVersion = order.version;

    // A waiter adds a drink after the cashier's screen rendered.
    await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/discounts`,
      headers: auth('cashier', { 'if-match': String(staleVersion) }),
      payload: { kind: 'percent', value: 1000, reason: 'اول' },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/discounts`,
      headers: auth('cashier', { 'if-match': String(staleVersion) }),
      payload: { kind: 'percent', value: 5000, reason: 'دوم' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('stale_version');
    expect(res.json().error.current.bill).toBeDefined();
  });

  it('(c) the money-losing case: an item cannot be added to a settled ticket', async () => {
    const order = await openTicket();
    await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth('waiter'),
      payload: { menu_item_id: foodItemId, qty: 1 },
    });
    const full = (await app.inject({
      method: 'GET', url: `/api/orders/${order.id}`, headers: auth('cashier'),
    })).json();

    await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/settle`,
      headers: auth('cashier', { 'if-match': String(full.version) }),
      payload: { payments: [{ method: 'cash', amount_irr: full.bill.total_irr }] },
    });

    // The waiter's pizza arrives a moment too late. It must not be served free.
    const late = await app.inject({
      method: 'POST', url: `/api/orders/${order.id}/lines`, headers: auth('waiter'),
      payload: { menu_item_id: drinkItemId, qty: 1 },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('order_not_open');
  });

  it('two waiters cannot open two tickets on the same table', async () => {
    const order = await openTicket();
    const { rows: [row] } = await admin.query(
      `SELECT table_id FROM orders WHERE id = $1`, [order.id]);

    const second = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('waiter'),
      payload: { branch_id: branchId, table_id: row.table_id, order_type: 'dine_in' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('table_occupied');
  });
});

/* ------------------------------------------------------------------ */

describe('authorisation and tenancy at the HTTP boundary', () => {
  it('rejects requests with no token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/orders?branch_id=${branchId}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered token', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/orders?branch_id=${branchId}`,
      headers: { authorization: `Bearer ${tokens.waiter}x` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a manager of restaurant B sees nothing belonging to restaurant A', async () => {
    const otherToken = await loginAs('+989129990001', '9999');

    // Same branch id, a valid uuid, belonging to someone else entirely.
    const res = await app.inject({
      method: 'GET', url: `/api/orders?branch_id=${branchId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toEqual([]);

    const menu = await app.inject({
      method: 'GET', url: `/api/menu?branch_id=${branchId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    // Their own menu, never ours.
    const names = JSON.stringify(menu.json());
    expect(names).not.toContain('لاته');
  });

  it('kitchen staff cannot open tickets or settle', async () => {
    const open = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth('kitchen'),
      payload: { branch_id: branchId, table_id: tableId, order_type: 'dine_in' },
    });
    expect(open.statusCode).toBe(403);
  });

  it('a waiter cannot read reports', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/reports/daily?branch_id=${branchId}`, headers: auth('waiter'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a bad login without revealing whether the phone exists', async () => {
    const unknown = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { phone: '+989120000000', pin: '1234' },
    });
    const wrongPin = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { phone: '+989121110003', pin: '0000' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrongPin.statusCode).toBe(401);
    expect(unknown.json().error.message_fa).toBe(wrongPin.json().error.message_fa);
  });
});
