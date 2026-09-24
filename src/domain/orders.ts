/**
 * The open ticket (SCOPE.md §3, §4.1)
 *
 * Three concurrency mechanisms, deliberately different, because the three cases
 * have different correctness requirements:
 *
 *   (a) adding lines      -> append-only + FOR SHARE. Both writers succeed.
 *   (b) station status    -> conditional UPDATE. Lost transitions become 409s.
 *   (c) discount / settle -> FOR UPDATE + optimistic version. Serialised.
 *
 * Using one mechanism for all three would mean either serialising the waiters
 * (slow, and wrong — two people adding drinks is not a conflict) or leaving the
 * money unprotected.
 */

import type { Client } from '../lib/db.js';
import { errors } from '../lib/errors.js';
import { toRial } from '../lib/money.js';
import { computeBill, amountPaid, type Bill } from '../lib/totals.js';
import { businessDay } from '../lib/calendar.js';
import { ticketLogger } from '../lib/log.js';

const PG_UNIQUE_VIOLATION = '23505';

export interface Actor {
  staffId: string;
  role: 'manager' | 'cashier' | 'waiter' | 'kitchen';
  restaurantId: string;
  branchId: string | null;
  requestId?: string;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

async function recordEvent(
  client: Client,
  actor: Actor,
  orderId: string,
  type: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO order_events
       (restaurant_id, order_id, type, payload, actor_staff_id, actor_role, request_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.restaurantId, orderId, type, payload, actor.staffId, actor.role,
     actor.requestId ?? null, idempotencyKey ?? null],
  );
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface OrderView {
  id: string;
  branch_id: string;
  table_id: string | null;
  table_label: string | null;
  order_type: 'dine_in' | 'takeaway' | 'delivery';
  status: 'open' | 'settled' | 'voided';
  guest_count: number | null;
  version: number;
  opened_at: string;
  business_day: string;
  lines: LineView[];
  bill: Bill;
  paid_irr: number;
}

export interface LineView {
  id: string;
  seq: number;
  name_fa: string;
  qty: number;
  unit_price_irr: number;
  station: string;
  status: string;
  note: string | null;
  added_by_name: string;
  added_at: string;
}

export async function loadOrder(
  client: Client,
  orderId: string,
  opts: { forUpdate?: boolean; forShare?: boolean } = {},
): Promise<OrderView> {
  const lock = opts.forUpdate ? 'FOR UPDATE' : opts.forShare ? 'FOR SHARE' : '';

  // Locking clauses cannot appear with an outer join in Postgres, so the row is
  // locked on its own and decorated afterwards.
  const orderRes = await client.query(
    `SELECT id, branch_id, table_id, order_type, status, guest_count, version,
            opened_at, business_day
       FROM orders WHERE id = $1 ${lock}`,
    [orderId],
  );
  if (orderRes.rowCount === 0) throw errors.notFound('فاکتور');
  const o = orderRes.rows[0];

  const [linesRes, discountsRes, paymentsRes, branchRes, tableRes] = await Promise.all([
    client.query(
      `SELECT l.id, l.seq, l.name_fa_snapshot, l.qty, l.unit_price_irr, l.station,
              l.status, l.note, l.is_vat_exempt, l.added_at, s.full_name AS added_by_name
         FROM order_lines l JOIN staff s ON s.id = l.added_by
        WHERE l.order_id = $1 ORDER BY l.seq`,
      [orderId],
    ),
    client.query(
      `SELECT kind, value, voided_at FROM order_discounts
        WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    ),
    client.query(`SELECT amount_irr FROM payments WHERE order_id = $1`, [orderId]),
    client.query(
      `SELECT service_charge_bps, vat_bps, vat_applies_to_service
         FROM branches WHERE id = $1`,
      [o.branch_id],
    ),
    o.table_id
      ? client.query(`SELECT label FROM dining_tables WHERE id = $1`, [o.table_id])
      : Promise.resolve({ rows: [] as { label: string }[] }),
  ]);

  const lines = linesRes.rows.map((r) => ({
    ...r,
    unit_price_irr: toRial(r.unit_price_irr),
    value: undefined,
  }));

  const bill = computeBill(
    lines.map((l) => ({
      unit_price_irr: l.unit_price_irr,
      qty: l.qty,
      status: l.status,
      is_vat_exempt: l.is_vat_exempt,
    })),
    discountsRes.rows.map((d) => ({ kind: d.kind, value: toRial(d.value), voided_at: d.voided_at })),
    branchRes.rows[0],
    o.order_type,
  );

  return {
    id: o.id,
    branch_id: o.branch_id,
    table_id: o.table_id,
    table_label: tableRes.rows[0]?.label ?? null,
    order_type: o.order_type,
    status: o.status,
    guest_count: o.guest_count,
    version: o.version,
    opened_at: o.opened_at,
    business_day: o.business_day,
    lines: lines.map((l) => ({
      id: l.id, seq: l.seq, name_fa: l.name_fa_snapshot, qty: l.qty,
      unit_price_irr: l.unit_price_irr, station: l.station, status: l.status,
      note: l.note, added_by_name: l.added_by_name, added_at: l.added_at,
    })),
    bill,
    paid_irr: amountPaid(paymentsRes.rows.map((p) => ({ amount_irr: toRial(p.amount_irr) }))),
  };
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

export async function openOrder(
  client: Client,
  actor: Actor,
  input: {
    branchId: string;
    tableId?: string | null;
    orderType: 'dine_in' | 'takeaway' | 'delivery';
    guestCount?: number | null;
  },
): Promise<OrderView> {
  const branch = await client.query(
    `SELECT business_day_cutoff_hour FROM branches WHERE id = $1`,
    [input.branchId],
  );
  if (branch.rowCount === 0) throw errors.notFound('شعبه');

  const day = businessDay(new Date(), branch.rows[0].business_day_cutoff_hour);

  // The savepoint lets us query for the conflicting ticket after the insert
  // fails. Without it the transaction is already aborted and the lookup below
  // raises "current transaction is aborted", turning a clean 409 into a 500 —
  // which is exactly what happened before the workflow test caught it.
  await client.query('SAVEPOINT open_order');
  try {
    const res = await client.query(
      `INSERT INTO orders (restaurant_id, branch_id, table_id, order_type, guest_count,
                           opened_by, business_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [actor.restaurantId, input.branchId, input.tableId ?? null, input.orderType,
       input.guestCount ?? null, actor.staffId, day],
    );
    await client.query('RELEASE SAVEPOINT open_order');

    const orderId = res.rows[0].id;
    await recordEvent(client, actor, orderId, 'order.opened', {
      table_id: input.tableId, order_type: input.orderType, business_day: day,
    });
    return loadOrder(client, orderId);
  } catch (err: unknown) {
    await client.query('ROLLBACK TO SAVEPOINT open_order');

    // The partial unique index `one_open_ticket_per_table` is what makes
    // "one open ticket per table" true under concurrency. Two waiters both
    // tapping table 12 is a race that check-then-insert would lose.
    if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      const existing = await client.query(
        `SELECT id FROM orders WHERE table_id = $1 AND status = 'open'`,
        [input.tableId],
      );
      throw errors.tableOccupied({ order_id: existing.rows[0]?.id ?? null });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* (a) Adding a line — both writers must succeed                       */
/* ------------------------------------------------------------------ */

export async function addLine(
  client: Client,
  actor: Actor,
  orderId: string,
  input: { menuItemId: string; qty: number; note?: string | null },
  idempotencyKey?: string,
): Promise<OrderView> {
  const log = ticketLogger({
    request_id: actor.requestId, restaurant_id: actor.restaurantId,
    order_id: orderId, staff_id: actor.staffId, role: actor.role,
  });

  // FOR SHARE, not FOR UPDATE. Share locks are compatible with each other, so
  // two waiters adding at the same time do not block each other — but a cashier's
  // FOR UPDATE in settle() must wait for both to commit. That closes the gap
  // where a pizza lands on a ticket that was settled a millisecond earlier and
  // is served free. This is the scenario that actually loses money.
  const orderRes = await client.query(
    `SELECT id, branch_id, status, version FROM orders WHERE id = $1 FOR SHARE`,
    [orderId],
  );
  if (orderRes.rowCount === 0) throw errors.notFound('فاکتور');
  const order = orderRes.rows[0];

  if (order.status !== 'open') {
    log.warn({ event: 'conflict.add_to_closed_order', status: order.status },
      'attempt to add line to non-open order');
    throw errors.orderNotOpen(await loadOrder(client, orderId));
  }

  // Resolve price with the branch override, then snapshot it. A manager raising a
  // price at 21:00 must not silently reprice bills that are already open.
  const itemRes = await client.query(
    `SELECT mi.id, mi.name_fa, mi.station, mi.is_vat_exempt, mi.is_available,
            COALESCE(bp.price_irr, mi.base_price_irr) AS price_irr
       FROM menu_items mi
       LEFT JOIN menu_item_branch_prices bp
              ON bp.menu_item_id = mi.id AND bp.branch_id = $2
      WHERE mi.id = $1`,
    [input.menuItemId, order.branch_id],
  );
  if (itemRes.rowCount === 0) throw errors.notFound('آیتم منو');
  const item = itemRes.rows[0];
  if (!item.is_available) {
    throw errors.validation(`«${item.name_fa}» موجود نیست.`);
  }

  // seq is allocated optimistically. Two concurrent adds can pick the same number;
  // the UNIQUE (order_id, seq) constraint catches it and we retry. Retrying is
  // correct here precisely *because* we did not take an exclusive lock — the whole
  // point is that both adds land.
  //
  // The SAVEPOINT is not decoration: in Postgres a failed statement aborts the
  // whole transaction, so without it the second attempt would fail with
  // "current transaction is aborted" rather than succeeding.
  let lineId: string | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < 4 && !lineId; attempt++) {
    await client.query('SAVEPOINT add_line');
    try {
      const ins = await client.query(
        `INSERT INTO order_lines
           (restaurant_id, order_id, seq, menu_item_id, name_fa_snapshot,
            unit_price_irr, is_vat_exempt, qty, station, note, added_by)
         SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5, $6, $7, $8, $9, $10
           FROM order_lines WHERE order_id = $2
         RETURNING id, seq`,
        [actor.restaurantId, orderId, item.id, item.name_fa, item.price_irr,
         item.is_vat_exempt, input.qty, item.station, input.note ?? null, actor.staffId],
      );
      lineId = ins.rows[0].id;
      await client.query('RELEASE SAVEPOINT add_line');
    } catch (err: unknown) {
      await client.query('ROLLBACK TO SAVEPOINT add_line');
      if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION) throw err;
      lastErr = err;
      log.debug({ event: 'seq.collision', attempt }, 'retrying line seq allocation');
    }
  }

  if (!lineId) {
    // Four collisions on one ticket means contention far beyond a real table.
    log.error({ event: 'seq.collision_exhausted', err: lastErr }, 'gave up allocating line seq');
    throw errors.lineMoved({ order_id: orderId });
  }

  await recordEvent(client, actor, orderId, 'line.added', {
    line_id: lineId, menu_item_id: item.id, name_fa: item.name_fa,
    qty: input.qty, unit_price_irr: Number(item.price_irr), station: item.station,
  }, idempotencyKey);

  log.info({ event: 'line.added', line_id: lineId, qty: input.qty }, 'line added');
  return loadOrder(client, orderId);
}

/* ------------------------------------------------------------------ */
/* (b) Station transitions — conditional update, never read-modify-write */
/* ------------------------------------------------------------------ */

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  queued: ['preparing', 'ready'],
  preparing: ['ready'],
  ready: ['served'],
  served: [],
  void: [],
};

const TIMESTAMP_COLUMN: Record<string, string> = {
  preparing: 'started_at',
  ready: 'ready_at',
  served: 'served_at',
};

export async function advanceLine(
  client: Client,
  actor: Actor,
  lineId: string,
  from: string,
  to: string,
): Promise<{ line_id: string; status: string; order_id: string }> {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw errors.validation(`انتقال از «${from}» به «${to}» مجاز نیست.`);
  }

  const stamp = TIMESTAMP_COLUMN[to];

  // The entire concurrency control is the `AND status = $2` clause. No SELECT,
  // no lock, no read-modify-write. A cook double-tapping "ready" while another
  // screen marks it "served" cannot walk the state backwards, because the second
  // update matches zero rows.
  const res = await client.query(
    `UPDATE order_lines
        SET status = $3 ${stamp ? `, ${stamp} = now()` : ''}
      WHERE id = $1 AND status = $2
      RETURNING id, order_id, status`,
    [lineId, from, to],
  );

  const log = ticketLogger({
    request_id: actor.requestId, restaurant_id: actor.restaurantId,
    line_id: lineId, staff_id: actor.staffId, role: actor.role,
  });

  if (res.rowCount === 0) {
    const currentRes = await client.query(
      `SELECT id, order_id, status FROM order_lines WHERE id = $1`,
      [lineId],
    );
    if (currentRes.rowCount === 0) throw errors.notFound('آیتم');

    // Logged as a conflict, with both the expected and actual state. At 3am this
    // is the line that answers "the kitchen swears they marked it ready".
    log.warn({
      event: 'conflict.line_transition',
      expected_from: from, requested_to: to, actual: currentRes.rows[0].status,
    }, 'line transition lost a race');

    throw errors.lineMoved(currentRes.rows[0]);
  }

  const row = res.rows[0];
  await recordEvent(client, actor, row.order_id, 'line.status_changed',
    { line_id: lineId, from, to });
  log.info({ event: 'line.status_changed', from, to, order_id: row.order_id }, 'line advanced');
  return { line_id: row.id, status: row.status, order_id: row.order_id };
}

/* ------------------------------------------------------------------ */
/* Voiding — the main theft vector, so it is never silent              */
/* ------------------------------------------------------------------ */

export async function voidLine(
  client: Client,
  actor: Actor,
  lineId: string,
  reason: string,
): Promise<OrderView> {
  if (actor.role !== 'manager' && actor.role !== 'cashier') {
    throw errors.forbidden('فقط مدیر یا صندوق می‌تواند آیتم را حذف کند.');
  }
  if (!reason || reason.trim().length < 3) {
    throw errors.validation('برای حذف آیتم باید دلیل ثبت شود.');
  }

  const res = await client.query(
    `UPDATE order_lines
        SET status = 'void', voided_by = $2, voided_at = now(), void_reason = $3
      WHERE id = $1 AND status <> 'void'
        AND order_id IN (SELECT id FROM orders WHERE id = order_lines.order_id AND status = 'open')
      RETURNING order_id, seq, name_fa_snapshot, unit_price_irr, qty, status`,
    [lineId, actor.staffId, reason.trim()],
  );
  if (res.rowCount === 0) {
    const cur = await client.query(
      `SELECT l.id, l.status, o.status AS order_status
         FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = $1`,
      [lineId],
    );
    if (cur.rowCount === 0) throw errors.notFound('آیتم');
    throw errors.lineMoved(cur.rows[0]);
  }

  const row = res.rows[0];
  await recordEvent(client, actor, row.order_id, 'line.voided', {
    line_id: lineId, reason: reason.trim(),
    value_irr: toRial(row.unit_price_irr) * row.qty, name_fa: row.name_fa_snapshot,
  });

  ticketLogger({
    request_id: actor.requestId, restaurant_id: actor.restaurantId,
    order_id: row.order_id, staff_id: actor.staffId, role: actor.role,
  }).warn({ event: 'money.line_voided', line_id: lineId, reason,
            value_irr: toRial(row.unit_price_irr) * row.qty }, 'line voided');

  return loadOrder(client, row.order_id);
}

/* ------------------------------------------------------------------ */
/* (c) Money — serialised with FOR UPDATE + optimistic version         */
/* ------------------------------------------------------------------ */

export async function applyDiscount(
  client: Client,
  actor: Actor,
  orderId: string,
  input: { kind: 'percent' | 'amount'; value: number; reason: string; expectedVersion: number },
): Promise<OrderView> {
  if (actor.role !== 'manager' && actor.role !== 'cashier') {
    throw errors.forbidden('فقط مدیر یا صندوق می‌تواند تخفیف اعمال کند.');
  }
  if (!input.reason?.trim()) throw errors.validation('ثبت دلیل تخفیف الزامی است.');

  const res = await client.query(
    `SELECT status, version FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (res.rowCount === 0) throw errors.notFound('فاکتور');
  const order = res.rows[0];
  if (order.status !== 'open') throw errors.orderNotOpen(await loadOrder(client, orderId));

  // Optimistic check: the cashier is looking at a bill. If a waiter added two
  // drinks since it rendered, a 30% discount means something different from what
  // the cashier agreed to. Bounce it and show them the new bill.
  if (order.version !== input.expectedVersion) {
    throw errors.staleVersion(await loadOrder(client, orderId));
  }

  await client.query(
    `INSERT INTO order_discounts (restaurant_id, order_id, kind, value, reason, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.restaurantId, orderId, input.kind, input.value, input.reason.trim(), actor.staffId],
  );
  await client.query(`UPDATE orders SET version = version + 1 WHERE id = $1`, [orderId]);

  await recordEvent(client, actor, orderId, 'discount.applied', {
    kind: input.kind, value: input.value, reason: input.reason.trim(),
  });

  ticketLogger({ request_id: actor.requestId, restaurant_id: actor.restaurantId,
                 order_id: orderId, staff_id: actor.staffId, role: actor.role })
    .info({ event: 'money.discount_applied', kind: input.kind, value: input.value }, 'discount applied');

  return loadOrder(client, orderId);
}

export interface PaymentInput {
  method: 'cash' | 'pos_card' | 'card_to_card' | 'online_psp' | 'on_account';
  amount_irr: number;
  reference?: string | null;
  psp?: string | null;
}

export async function settleOrder(
  client: Client,
  actor: Actor,
  orderId: string,
  input: { payments: PaymentInput[]; expectedVersion: number },
  idempotencyKey?: string,
): Promise<OrderView> {
  if (actor.role !== 'manager' && actor.role !== 'cashier') {
    throw errors.forbidden('فقط مدیر یا صندوق می‌تواند فاکتور را تسویه کند.');
  }

  // Exclusive lock. Any addLine() holding FOR SHARE commits before we proceed,
  // so the bill we compute below includes every line that was in flight.
  const res = await client.query(
    `SELECT status, version FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (res.rowCount === 0) throw errors.notFound('فاکتور');
  const order = res.rows[0];
  if (order.status !== 'open') throw errors.orderNotOpen(await loadOrder(client, orderId));
  if (order.version !== input.expectedVersion) {
    throw errors.staleVersion(await loadOrder(client, orderId));
  }

  // Recomputed here, inside the lock, from the stored lines. A total sent by a
  // client is never trusted — not because the cashier is dishonest, but because
  // their screen may be four seconds stale.
  const view = await loadOrder(client, orderId);
  const paid = input.payments.reduce((s, p) => s + p.amount_irr, 0);

  if (paid < view.bill.total_irr) {
    throw errors.validation('مبلغ پرداختی کمتر از مبلغ فاکتور است.', {
      total_irr: view.bill.total_irr, paid_irr: paid,
    });
  }

  for (const p of input.payments) {
    await client.query(
      `INSERT INTO payments (restaurant_id, order_id, method, amount_irr, reference, psp, taken_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.restaurantId, orderId, p.method, p.amount_irr,
       p.reference ?? null, p.psp ?? null, actor.staffId],
    );
  }

  await client.query(
    `UPDATE orders
        SET status = 'settled', closed_by = $2, closed_at = now(), version = version + 1,
            subtotal_irr = $3, discount_irr = $4, service_irr = $5,
            vat_irr = $6, total_irr = $7
      WHERE id = $1`,
    [orderId, actor.staffId, view.bill.subtotal_irr, view.bill.discount_irr,
     view.bill.service_irr, view.bill.vat_irr, view.bill.total_irr],
  );

  await recordEvent(client, actor, orderId, 'order.settled', {
    ...view.bill, paid_irr: paid,
    change_irr: paid - view.bill.total_irr,
    methods: input.payments.map((p) => p.method),
  }, idempotencyKey);

  ticketLogger({ request_id: actor.requestId, restaurant_id: actor.restaurantId,
                 order_id: orderId, staff_id: actor.staffId, role: actor.role })
    .info({ event: 'money.order_settled', total_irr: view.bill.total_irr, paid_irr: paid },
          'order settled');

  return loadOrder(client, orderId);
}
