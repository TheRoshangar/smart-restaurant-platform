import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { login, issueToken } from '../../lib/auth.js';
import { inTenant, parse, sessionOf } from '../app.js';

const LoginBody = z.object({
  phone: z.string().min(9).max(20),
  pin: z.string().regex(/^\d{4,6}$/),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', {
    config: {
      public: true,
      // A 4-digit PIN is 10,000 guesses. Ten attempts per minute per IP turns a
      // 17-minute attack into a 16-hour one, and the failed-login log makes it
      // visible long before it succeeds.
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req) => {
    const body = parse(LoginBody, req.body);
    const session = await login(body.phone, body.pin);
    const token = await issueToken(session);

    return {
      token,
      staff: {
        id: session.staffId,
        full_name: session.fullName,
        role: session.role,
        branch_id: session.branchId,
      },
    };
  });

  /** Who am I, and what does my app need to render itself. */
  app.get('/me', async (req) => {
    const s = sessionOf(req);
    return inTenant(req, async (client) => {
      const { rows: branches } = await client.query(
        `SELECT id, name, service_charge_bps, vat_bps, money_display_unit,
                show_dual_currency, business_day_cutoff_hour
           FROM branches WHERE is_active ORDER BY name`);
      const { rows: [restaurant] } = await client.query(
        `SELECT id, name FROM restaurants LIMIT 1`);

      return {
        staff: { id: s.staffId, full_name: s.fullName, role: s.role, branch_id: s.branchId },
        restaurant,
        // A manager with branch_id NULL sees every branch; everyone else sees theirs.
        branches: s.branchId ? branches.filter((b) => b.id === s.branchId) : branches,
      };
    });
  });
}
