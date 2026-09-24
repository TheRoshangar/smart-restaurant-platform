/**
 * The ticket API.
 *
 * Design notes worth reading before the code:
 *
 *  - Every mutation returns the FULL order, not a diff. A waiter's phone on café
 *    wifi cannot be trusted to have applied every previous response, so the
 *    cheapest correct thing is to send the whole ticket every time. It is a few
 *    hundred bytes.
 *  - Money mutations require If-Match with the order version. That is what turns
 *    "cashier discounts a stale bill" into a 409 the cashier can see rather than
 *    a wrong total nobody notices.
 *  - Station transitions do NOT take an Idempotency-Key. They are conditional
 *    updates keyed on the expected current status, which makes them naturally
 *    idempotent: replaying "queued -> preparing" a second time returns 409 with
 *    the current state, which is the correct answer.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { inTenant, parse, actorOf, sessionOf, requireCap } from '../app.js';
import { errors } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import {
  openOrder, addLine, advanceLine, voidLine, applyDiscount, settleOrder, loadOrder,
} from '../../domain/orders.js';

const Uuid = z.string().uuid();

const OpenBody = z.object({
  branch_id: Uuid,
  table_id: Uuid.nullable().optional(),
  order_type: z.enum(['dine_in', 'takeaway', 'delivery']).default('dine_in'),
  guest_count: z.number().int().min(1).max(50).nullable().optional(),
});

const AddLineBody = z.object({
  menu_item_id: Uuid,
  qty: z.number().int().min(1).max(50),
  note: z.string().max(200).nullable().optional(),
});

const AdvanceBody = z.object({
  from: z.enum(['queued', 'preparing', 'ready']),
  to: z.enum(['preparing', 'ready', 'served']),
});

const VoidBody = z.object({ reason: z.string().min(3).max(200) });

const DiscountBody = z.object({
  kind: z.enum(['percent', 'amount']),
  // Percent is basis points so 12.5% is expressible without a float.
  value: z.number().int().positive(),
  reason: z.string().min(3).max(200),
});

const SettleBody = z.object({
  payments: z.array(z.object({
    method: z.enum(['cash', 'pos_card', 'card_to_card', 'online_psp', 'on_account']),
    amount_irr: z.number().int().positive(),
    reference: z.string().max(60).nullable().optional(),
    psp: z.string().max(40).nullable().optional(),
  })).min(1).max(6),
});

/** If-Match carries the order version the client was looking at. */
function expectedVersion(req: { headers: Record<string, unknown> }): number {
  const raw = req.headers['if-match'];
  const n = Number(typeof raw === 'string' ? raw.replace(/"/g, '') : NaN);
  if (!Number.isInteger(n) || n < 1) {
    throw errors.validation('برای تغییرات مالی باید نسخه فاکتور ارسال شود (If-Match).');
  }
  return n;
}

export async function registerOrderRoutes(app: FastifyInstance): Promise<void> {

  /** Open tickets for a branch — the waiter's home screen. */
  app.get('/', async (req) => {
    const q = parse(z.object({ branch_id: Uuid }), req.query);
    return inTenant(req, async (client) => {
      const { rows } = await client.query(
        `SELECT o.id, o.table_id, t.label AS table_label, t.area, o.order_type,
                o.guest_count, o.opened_at, o.version, s.full_name AS opened_by_name,
                count(l.id) FILTER (WHERE l.status <> 'void')            AS line_count,
                count(l.id) FILTER (WHERE l.status IN ('queued','preparing')) AS pending_count,
                COALESCE(sum(l.unit_price_irr * l.qty)
                         FILTER (WHERE l.status <> 'void'), 0)           AS subtotal_irr
           FROM orders o
           JOIN staff s ON s.id = o.opened_by
           LEFT JOIN dining_tables t ON t.id = o.table_id
           LEFT JOIN order_lines l ON l.order_id = o.id
          WHERE o.status = 'open' AND o.branch_id = $1
          GROUP BY o.id, t.label, t.area, s.full_name
          ORDER BY o.opened_at`,
        [q.branch_id],
      );
      return { orders: rows };
    });
  });

  app.get('/:id', async (req) => {
    const { id } = parse(z.object({ id: Uuid }), req.params);
    return inTenant(req, (client) => loadOrder(client, id));
  });

  app.post('/', async (req, reply) => {
    requireCap(req, 'order.open');
    const body = parse(OpenBody, req.body);

    const order = await inTenant(req, async (client) => openOrder(client, actorOf(req, body.branch_id), {
      branchId: body.branch_id,
      tableId: body.table_id ?? null,
      orderType: body.order_type,
      guestCount: body.guest_count ?? null,
    }), { endpoint: 'POST /orders', body });

    publish(sessionOf(req).restaurantId, body.branch_id, {
      type: 'order.opened', order_id: order.id,
    });
    return reply.status(201).send(order);
  });

  app.post('/:id/lines', async (req) => {
    requireCap(req, 'order.add_line');
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const body = parse(AddLineBody, req.body);

    const order = await inTenant(req, (client) => addLine(client, actorOf(req), id, {
      menuItemId: body.menu_item_id,
      qty: body.qty,
      note: body.note ?? null,
    }, req.headers['idempotency-key'] as string | undefined),
    { endpoint: `POST /orders/${id}/lines`, body });

    // The bar and the kitchen both listen; each filters by station.
    publish(sessionOf(req).restaurantId, order.branch_id, {
      type: 'line.added', order_id: order.id,
    });
    return order;
  });

  /** Kitchen / bar: advance a line. Conditional update; 409 carries current state. */
  app.patch('/lines/:lineId/status', async (req) => {
    requireCap(req, 'station.advance');
    const { lineId } = parse(z.object({ lineId: Uuid }), req.params);
    const body = parse(AdvanceBody, req.body);

    const result = await inTenant(req, (client) =>
      advanceLine(client, actorOf(req), lineId, body.from, body.to));

    const order = await inTenant(req, (client) => loadOrder(client, result.order_id));
    publish(sessionOf(req).restaurantId, order.branch_id, {
      type: 'line.status_changed', order_id: result.order_id, line_id: lineId,
    });
    return result;
  });

  /**
   * Marking served is a waiter action, not a station action, and it is the same
   * conditional update underneath. Split from the route above purely so the two
   * capabilities differ.
   */
  app.patch('/lines/:lineId/served', async (req) => {
    requireCap(req, 'order.serve');
    const { lineId } = parse(z.object({ lineId: Uuid }), req.params);

    const result = await inTenant(req, (client) =>
      advanceLine(client, actorOf(req), lineId, 'ready', 'served'));

    const order = await inTenant(req, (client) => loadOrder(client, result.order_id));
    publish(sessionOf(req).restaurantId, order.branch_id, {
      type: 'line.status_changed', order_id: result.order_id, line_id: lineId,
    });
    return result;
  });

  app.post('/lines/:lineId/void', async (req) => {
    requireCap(req, 'order.void_line');
    const { lineId } = parse(z.object({ lineId: Uuid }), req.params);
    const body = parse(VoidBody, req.body);

    const order = await inTenant(req, (client) =>
      voidLine(client, actorOf(req), lineId, body.reason),
    { endpoint: `POST /lines/${lineId}/void`, body });

    publish(sessionOf(req).restaurantId, order.branch_id, {
      type: 'line.voided', order_id: order.id, line_id: lineId,
    });
    return order;
  });

  app.post('/:id/discounts', async (req) => {
    requireCap(req, 'order.discount');
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const body = parse(DiscountBody, req.body);
    const version = expectedVersion(req);

    const order = await inTenant(req, (client) => applyDiscount(client, actorOf(req), id, {
      kind: body.kind, value: body.value, reason: body.reason, expectedVersion: version,
    }), { endpoint: `POST /orders/${id}/discounts`, body });

    publish(sessionOf(req).restaurantId, order.branch_id, {
      type: 'discount.applied', order_id: order.id,
    });
    return order;
  });

  app.post('/:id/settle', async (req) => {
    requireCap(req, 'order.settle');
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const body = parse(SettleBody, req.body);
    const version = expectedVersion(req);

    const order = await inTenant(req, (client) => settleOrder(client, actorOf(req), id, {
      payments: body.payments, expectedVersion: version,
    }, req.headers['idempotency-key'] as string | undefined),
    { endpoint: `POST /orders/${id}/settle`, body });

    publish(sessionOf(req).restaurantId, order.branch_id, {
      type: 'order.settled', order_id: order.id,
    });
    return order;
  });

  /** The ticket's own history. This is what you open when a bill is disputed. */
  app.get('/:id/events', async (req) => {
    const { id } = parse(z.object({ id: Uuid }), req.params);
    return inTenant(req, async (client) => {
      const { rows } = await client.query(
        `SELECT e.id, e.type, e.payload, e.at, e.actor_role, s.full_name AS actor_name
           FROM order_events e LEFT JOIN staff s ON s.id = e.actor_staff_id
          WHERE e.order_id = $1 ORDER BY e.id`,
        [id]);
      return { events: rows };
    });
  });
}
