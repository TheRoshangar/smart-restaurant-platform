/**
 * Menu, and the AI import flow.
 *
 * The import is deliberately two-phase: POST /import proposes, POST /import/:id/apply
 * commits. Nothing the model produces reaches menu_items without a human pressing
 * the second button. That is the containment boundary for prompt injection, and
 * it is a product decision as much as a security one — a manager wants to see the
 * prices before they go live.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { inTenant, parse, requireCap, sessionOf } from '../app.js';
import { errors } from '../../lib/errors.js';
import { parseMenu, providerFromEnv } from '../../ai/menuImport.js';
import { logger } from '../../lib/log.js';

const Uuid = z.string().uuid();

export async function registerMenuRoutes(app: FastifyInstance): Promise<void> {

  /** The waiter's menu: grouped, branch-priced, availability-aware. */
  app.get('/', async (req) => {
    const q = parse(z.object({ branch_id: Uuid }), req.query);
    const s = sessionOf(req);

    return inTenant(req, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id AS category_id, c.name_fa AS category_name, c.sort_order AS category_order,
                i.id, i.name_fa, i.station, i.is_available, i.prep_minutes, i.sort_order,
                COALESCE(bp.price_irr, i.base_price_irr) AS price_irr
           FROM menu_categories c
           JOIN menu_items i ON i.category_id = c.id
           LEFT JOIN menu_item_branch_prices bp
                  ON bp.menu_item_id = i.id AND bp.branch_id = $1
          WHERE c.is_active
          ORDER BY c.sort_order, i.sort_order, i.name_fa`,
        [q.branch_id]);

      // The kitchen never receives prices. Not a UI choice — the field does not
      // leave the server, so it cannot leak through a screenshot or a devtools tab.
      const hidePrices = s.role === 'kitchen';

      const categories = new Map<string, { id: string; name_fa: string; items: unknown[] }>();
      for (const r of rows) {
        let cat = categories.get(r.category_id);
        if (!cat) {
          cat = { id: r.category_id, name_fa: r.category_name, items: [] };
          categories.set(r.category_id, cat);
        }
        cat.items.push({
          id: r.id, name_fa: r.name_fa, station: r.station,
          is_available: r.is_available, prep_minutes: r.prep_minutes,
          ...(hidePrices ? {} : { price_irr: Number(r.price_irr) }),
        });
      }
      return { categories: [...categories.values()] };
    });
  });

  app.get('/tables', async (req) => {
    const q = parse(z.object({ branch_id: Uuid }), req.query);
    return inTenant(req, async (client) => {
      const { rows } = await client.query(
        `SELECT t.id, t.label, t.area, t.seats,
                o.id AS open_order_id, o.opened_at
           FROM dining_tables t
           LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
          WHERE t.branch_id = $1 AND t.is_active
          ORDER BY t.area, t.label`,
        [q.branch_id]);
      return { tables: rows };
    });
  });

  /** 86 an item for tonight. The most-used menu write in a real café. */
  app.patch('/items/:id/availability', async (req) => {
    requireCap(req, 'menu.write');
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const body = parse(z.object({ is_available: z.boolean() }), req.body);

    return inTenant(req, async (client) => {
      const { rows, rowCount } = await client.query(
        `UPDATE menu_items SET is_available = $2, updated_at = now()
          WHERE id = $1 RETURNING id, name_fa, is_available`,
        [id, body.is_available]);
      if (!rowCount) throw errors.notFound('آیتم منو');
      return rows[0];
    });
  });

  /* ---------------------------------------------------------------- */
  /* AI import                                                         */
  /* ---------------------------------------------------------------- */

  const ImportBody = z.object({
    // Bounded because this is untrusted input headed for a paid provider. An
    // unbounded paste is both a cost and a prompt-injection surface.
    text: z.string().min(10).max(20_000),
  });

  /**
   * Phase 1: propose. Runs the deterministic parser first, sends only the
   * residue to a model if one is configured, writes nothing to the menu.
   */
  app.post('/import', async (req) => {
    requireCap(req, 'menu.import');
    const body = parse(ImportBody, req.body);
    const s = sessionOf(req);

    const result = await parseMenu(body.text);

    return inTenant(req, async (client) => {
      const { rows: [row] } = await client.query(
        `INSERT INTO menu_imports
           (restaurant_id, source, status, provider, model, latency_ms, parsed_by,
            proposed, created_by)
         VALUES ($1,'text','parsed',$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
        [s.restaurantId, result.provider, result.model, result.latencyMs,
         result.parsedBy, JSON.stringify({ items: result.items, unparsed: result.unparsed }),
         s.staffId]);

      logger.info({
        event: 'menu.import_proposed', restaurant_id: s.restaurantId,
        import_id: row.id, items: result.items.length,
        unparsed: result.unparsed.length, parsed_by: result.parsedBy,
        provider: result.provider, latency_ms: result.latencyMs,
      }, 'menu import proposed');

      return {
        import_id: row.id,
        parsed_by: result.parsedBy,
        provider: result.provider,
        latency_ms: result.latencyMs,
        // Surfaced so the manager knows whether the model was reachable. If it
        // was not, they still get the heuristic results and a list to type in.
        model_available: providerFromEnv() !== null,
        items: result.items,
        unparsed: result.unparsed,
      };
    });
  });

  /**
   * Phase 2: apply. The client sends back the rows the human approved — not the
   * import id alone — so an edit in the review table is what gets written, and
   * so a stale or tampered proposal cannot be applied wholesale.
   */
  const ApplyBody = z.object({
    category_name: z.string().min(1).max(60),
    items: z.array(z.object({
      name_fa: z.string().min(1).max(120),
      price_irr: z.number().int().min(1_000).max(1_000_000_000),
      station: z.enum(['kitchen', 'bar', 'none']).default('kitchen'),
    })).min(1).max(200),
  });

  app.post('/import/:id/apply', async (req) => {
    requireCap(req, 'menu.import');
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const body = parse(ApplyBody, req.body);
    const s = sessionOf(req);

    return inTenant(req, async (client) => {
      const { rowCount } = await client.query(
        `SELECT 1 FROM menu_imports WHERE id = $1 AND status = 'parsed'`, [id]);
      if (!rowCount) throw errors.notFound('درخواست ورود منو');

      const { rows: [cat] } = await client.query(
        `INSERT INTO menu_categories (restaurant_id, name_fa, sort_order)
         VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM menu_categories))
         RETURNING id`,
        [s.restaurantId, body.category_name]);

      let created = 0;
      for (const [i, item] of body.items.entries()) {
        await client.query(
          `INSERT INTO menu_items (restaurant_id, category_id, name_fa, base_price_irr,
                                   station, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [s.restaurantId, cat.id, item.name_fa, item.price_irr, item.station, i]);
        created++;
      }

      await client.query(
        `UPDATE menu_imports SET status='applied', applied_at=now() WHERE id=$1`, [id]);

      logger.info({
        event: 'menu.import_applied', restaurant_id: s.restaurantId,
        import_id: id, created, staff_id: s.staffId,
      }, 'menu import applied');

      return { created, category_id: cat.id };
    });
  });
}
