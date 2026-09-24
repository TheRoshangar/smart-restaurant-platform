/**
 * HTTP layer.
 *
 * Two things are enforced here rather than left to each route:
 *
 *   1. Every authenticated request carries a Session, and every handler that
 *      touches data gets it through withTenant(). A route cannot accidentally
 *      query without a tenant context, because it never receives a raw client.
 *   2. The error handler fails closed. An error that is not an AppError becomes
 *      an opaque 500 with a request id, and the detail goes to the log. Driver
 *      messages, constraint names and stacks do not reach a client.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { AppError, errors, toErrorBody } from '../lib/errors.js';
import { logger } from '../lib/log.js';
import { verifyToken, type Session, type Capability, require_ } from '../lib/auth.js';
import { withTenant, type Client } from '../lib/db.js';
import { withIdempotency } from '../lib/idempotency.js';
import type { Actor } from '../domain/orders.js';

import { registerAuthRoutes } from './routes/auth.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerMenuRoutes } from './routes/menu.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerStreamRoutes } from './routes/stream.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
    requestId: string;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers shared by routes                                            */
/* ------------------------------------------------------------------ */

export function sessionOf(req: FastifyRequest): Session {
  if (!req.session) throw errors.unauthenticated();
  return req.session;
}

export function actorOf(req: FastifyRequest, branchId?: string | null): Actor {
  const s = sessionOf(req);
  return {
    staffId: s.staffId,
    role: s.role,
    restaurantId: s.restaurantId,
    branchId: branchId ?? s.branchId,
    requestId: req.requestId,
  };
}

/** Validate at the boundary. Anything past this point is typed and trusted. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.validation('اطلاعات ارسالی معتبر نیست.', result.error.flatten());
  }
  return result.data;
}

/** Run a handler inside a tenant-scoped transaction, with optional idempotency. */
export async function inTenant<T>(
  req: FastifyRequest,
  fn: (client: Client) => Promise<T>,
  idempotency?: { endpoint: string; body: unknown },
): Promise<T> {
  const s = sessionOf(req);
  return withTenant(
    { restaurantId: s.restaurantId, staffId: s.staffId, role: s.role, requestId: req.requestId },
    async (client) => {
      if (!idempotency) return fn(client);
      const key = req.headers['idempotency-key'];
      const { result } = await withIdempotency(
        client,
        {
          restaurantId: s.restaurantId,
          key: typeof key === 'string' ? key : undefined,
          endpoint: idempotency.endpoint,
          body: idempotency.body,
        },
        () => fn(client),
      );
      return result;
    },
  );
}

export function requireCap(req: FastifyRequest, capability: Capability): void {
  require_(sessionOf(req).role, capability);
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,           // we use our own pino instance with ticket context
    trustProxy: true,        // behind the PaaS TLS terminator
    bodyLimit: 1_000_000,
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
  });

  // PIN spaces are small (10^4). Login is rate limited hard, and separately from
  // everything else, because a shared-device product invites PIN guessing.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.ip,
  });

  app.addHook('onRequest', async (req, reply) => {
    req.requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    reply.header('x-request-id', req.requestId);
  });

  // Authentication. Public routes opt out via config.public.
  app.addHook('preHandler', async (req) => {
    // Only /api/* carries data. The web app's own files (and /health) are not
    // behind a token, because a browser must be able to load the login page.
    if (!req.url.startsWith('/api/')) return;

    const routeOptions = (req as { routeOptions?: { config?: { public?: boolean } } }).routeOptions;
    if (routeOptions?.config?.public) return;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw errors.unauthenticated();
    req.session = await verifyToken(header.slice(7));
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      // Expected, named failures. 4xx at info, 5xx at error.
      logger[err.status >= 500 ? 'error' : 'info']({
        event: 'http.error', code: err.code, status: err.status,
        request_id: req.requestId, path: req.url, method: req.method,
        restaurant_id: req.session?.restaurantId, staff_id: req.session?.staffId,
      }, err.messageFa);
      return reply.status(err.status).send(toErrorBody(err, req.requestId));
    }

    // Validation errors raised by Fastify's own schema layer.
    if ((err as { validation?: unknown }).validation) {
      const e = errors.validation();
      return reply.status(400).send(toErrorBody(e, req.requestId));
    }

    // Anything unrecognised: full detail to the log, nothing to the client.
    logger.error({
      event: 'http.unhandled', err, request_id: req.requestId,
      path: req.url, method: req.method,
      restaurant_id: req.session?.restaurantId, staff_id: req.session?.staffId,
    }, 'unhandled error');

    return reply.status(500).send(
      toErrorBody(new AppError('internal', 'خطای غیرمنتظره. لطفاً دوباره تلاش کنید.'), req.requestId));
  });

  // The built web app (frontend/dist), when present, is served by this same
  // process: one origin, no CORS, one thing to deploy. In development the Vite
  // dev server is used instead and this block is skipped.
  const webRoot = resolve(process.cwd(), 'frontend/dist');
  const serveWeb = existsSync(webRoot);
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    // Unknown /api paths stay a JSON 404. Any other GET is a client-side route,
    // so hand back the app shell and let the router decide.
    if (serveWeb && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    reply.status(404).send(toErrorBody(errors.notFound('مسیر'), req.requestId));
  });

  app.get('/health', { config: { public: true } }, async () => ({ ok: true }));

  await app.register(registerAuthRoutes, { prefix: '/api/auth' });
  await app.register(registerOrderRoutes, { prefix: '/api/orders' });
  await app.register(registerMenuRoutes, { prefix: '/api/menu' });
  await app.register(registerReportRoutes, { prefix: '/api/reports' });
  await app.register(registerStreamRoutes, { prefix: '/api/stream' });

  return app;
}
