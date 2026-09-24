/**
 * Reports.
 *
 * Small on purpose. These are the three questions an owner actually asks, and
 * they all key on business_day rather than opened_at::date, so the 01:30 trade
 * lands on the right night (SCOPE.md §2.4).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inTenant, parse, requireCap } from '../app.js';
import { businessDay, formatJalaliIso, jalaliMonthRange } from '../../lib/calendar.js';

const Uuid = z.string().uuid();

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {

  /** Today, or any single business day. The end-of-shift number. */
  app.get('/daily', async (req) => {
    requireCap(req, 'report.read');
    const q = parse(z.object({
      branch_id: Uuid,
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);

    const day = q.day ?? businessDay(new Date(), 5);

    return inTenant(req, async (client) => {
      const { rows: [totals] } = await client.query(
        `SELECT count(*)::int                       AS orders,
                COALESCE(sum(subtotal_irr),0)::bigint AS subtotal_irr,
                COALESCE(sum(discount_irr),0)::bigint AS discount_irr,
                COALESCE(sum(service_irr),0)::bigint  AS service_irr,
                COALESCE(sum(vat_irr),0)::bigint      AS vat_irr,
                COALESCE(sum(total_irr),0)::bigint    AS total_irr
           FROM orders
          WHERE branch_id = $1 AND business_day = $2 AND status = 'settled'`,
        [q.branch_id, day]);

      const { rows: byMethod } = await client.query(
        `SELECT p.method, count(*)::int AS n, sum(p.amount_irr)::bigint AS amount_irr
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE o.branch_id = $1 AND o.business_day = $2
          GROUP BY p.method ORDER BY amount_irr DESC`,
        [q.branch_id, day]);

      const { rows: topItems } = await client.query(
        `SELECT l.name_fa_snapshot AS name_fa, sum(l.qty)::int AS qty,
                sum(l.unit_price_irr * l.qty)::bigint AS revenue_irr
           FROM order_lines l JOIN orders o ON o.id = l.order_id
          WHERE o.branch_id = $1 AND o.business_day = $2 AND l.status <> 'void'
          GROUP BY l.name_fa_snapshot ORDER BY qty DESC LIMIT 10`,
        [q.branch_id, day]);

      return {
        business_day: day,
        business_day_fa: formatJalaliIso(day),
        totals,
        by_method: byMethod,
        top_items: topItems,
      };
    });
  });

  /**
   * The void report. This is the fraud control made visible: who voided what,
   * for how much, and with what reason. An owner who never looks at this has no
   * control over their own till.
   */
  app.get('/voids', async (req) => {
    requireCap(req, 'report.read');
    const q = parse(z.object({
      branch_id: Uuid,
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);

    const today = businessDay(new Date(), 5);
    const range = jalaliMonthRange(today);
    const from = q.from ?? range.start;
    const to = q.to ?? today;

    return inTenant(req, async (client) => {
      const { rows: byStaff } = await client.query(
        `SELECT s.full_name, s.role,
                count(*)::int AS voids,
                sum(l.unit_price_irr * l.qty)::bigint AS value_irr
           FROM order_lines l
           JOIN orders o ON o.id = l.order_id
           JOIN staff s  ON s.id = l.voided_by
          WHERE o.branch_id = $1 AND o.business_day BETWEEN $2 AND $3
            AND l.status = 'void'
          GROUP BY s.full_name, s.role ORDER BY value_irr DESC`,
        [q.branch_id, from, to]);

      const { rows: recent } = await client.query(
        `SELECT l.name_fa_snapshot AS name_fa, l.qty, l.unit_price_irr,
                l.void_reason, l.voided_at, s.full_name AS voided_by_name,
                o.business_day
           FROM order_lines l
           JOIN orders o ON o.id = l.order_id
           LEFT JOIN staff s ON s.id = l.voided_by
          WHERE o.branch_id = $1 AND o.business_day BETWEEN $2 AND $3
            AND l.status = 'void'
          ORDER BY l.voided_at DESC LIMIT 50`,
        [q.branch_id, from, to]);

      return { from, to, period_fa: range.label, by_staff: byStaff, recent };
    });
  });

  /** The station queue. Drives the kitchen and bar screens. */
  app.get('/station', async (req) => {
    const q = parse(z.object({
      branch_id: Uuid,
      station: z.enum(['kitchen', 'bar']),
    }), req.query);

    return inTenant(req, async (client) => {
      const { rows } = await client.query(
        `SELECT l.id, l.name_fa_snapshot AS name_fa, l.qty, l.status, l.note,
                l.added_at, l.started_at,
                o.id AS order_id, t.label AS table_label, t.area,
                o.order_type,
                EXTRACT(EPOCH FROM (now() - l.added_at))::int AS waiting_seconds
           FROM order_lines l
           JOIN orders o ON o.id = l.order_id
           LEFT JOIN dining_tables t ON t.id = o.table_id
          WHERE o.branch_id = $1 AND o.status = 'open'
            AND l.station = $2 AND l.status IN ('queued','preparing','ready')
          ORDER BY l.added_at`,
        [q.branch_id, q.station]);

      // No prices anywhere in this payload. The kitchen screen does not receive
      // money, so it cannot display it.
      return { station: q.station, lines: rows };
    });
  });
}
