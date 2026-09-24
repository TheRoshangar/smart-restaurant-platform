/**
 * Logging (Part C: "logging you'd actually use at 3am")
 *
 * The 3am question is never "what happened in the process". It is "what happened
 * to table 12's bill". So every log line that touches a ticket carries
 * restaurant_id, branch_id, order_id, staff_id and request_id, and the things
 * worth waking up for get their own event names:
 *
 *   conflict.*      every 409, with both versions — this is how you answer
 *                   "the waiter says he added it and it isn't on the bill"
 *   idempotency.replayed   proves a duplicate was absorbed rather than applied twice
 *   money.*         discount applied, order settled, payment recorded
 *   ai.call         provider, latency, outcome — a provider we cannot always reach
 *
 * Redaction is explicit rather than a denylist: PINs, tokens and Authorization
 * headers are never assembled into a log object in the first place.
 */

import pino from 'pino';

const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'pin',
    '*.pin',
    'pin_hash',
    '*.pin_hash',
    'password',
    'token',
    '*.token',
  ],
  censor: '[redacted]',
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact,
  base: { service: 'mizban', env: process.env.NODE_ENV ?? 'development' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty output locally; JSON in production so it is greppable and parseable.
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

export interface TicketLogContext {
  request_id?: string;
  restaurant_id?: string;
  branch_id?: string;
  order_id?: string;
  line_id?: string;
  staff_id?: string;
  role?: string;
}

/** Bind the ticket context once per request so no call site has to remember it. */
export function ticketLogger(ctx: TicketLogContext) {
  return logger.child(ctx);
}
