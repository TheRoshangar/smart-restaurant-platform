/**
 * Live updates over SSE.
 *
 * The heartbeat is not optional: café wifi, mobile NAT and PaaS proxies all
 * silently drop idle connections, and a dead-but-open stream is worse than no
 * stream because the screen looks fine and is wrong. Fifteen seconds is short
 * enough to keep intermediaries awake and cheap enough to ignore.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, sessionOf } from '../app.js';
import { subscribe } from '../../lib/events.js';
import { errors } from '../../lib/errors.js';

const HEARTBEAT_MS = 15_000;

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const q = parse(z.object({ branch_id: z.string().uuid() }), req.query);
    const s = sessionOf(req);

    // A staff member sited at one branch cannot subscribe to another. Branch is
    // not a tenant boundary — RLS already handled that — but it is a privacy and
    // noise boundary within a restaurant.
    if (s.branchId && s.branchId !== q.branch_id) throw errors.forbidden();

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and several Iranian PaaS proxies buffer by default, which breaks SSE.
      'x-accel-buffering': 'no',
    });

    // Tell the client how long to wait before reconnecting after a drop.
    reply.raw.write('retry: 3000\n\n');

    const unsubscribe = subscribe(s.restaurantId, q.branch_id, (event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // Returning would end the response; SSE stays open until the client leaves.
    return reply;
  });
}
