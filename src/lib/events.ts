/**
 * Live updates (SCOPE.md §4.1, "where it breaks")
 *
 * A restaurant is a room where several screens must agree. When a waiter sends a
 * drink, the bar screen should show it without a refresh.
 *
 * This is an IN-PROCESS fan-out over Server-Sent Events. That is a deliberate,
 * documented limitation, not an oversight:
 *
 *   - SSE over WebSockets because it is one-directional (we only push), it
 *     reconnects by itself, and it survives the proxies and captive portals that
 *     café wifi is made of. Writes go over normal POSTs, which are already
 *     idempotent and therefore already retry-safe.
 *   - In-process because at two app instances a waiter connected to instance A
 *     stops seeing events from instance B. The fix is Postgres LISTEN/NOTIFY or
 *     Redis pub/sub and is roughly an hour of work. One instance serves far more
 *     than the first customers need, and I would rather spend that hour on
 *     correctness than on scale nobody has yet.
 *
 * Nothing in the system depends on an event arriving. Screens poll-on-reconnect
 * and every read returns full state, so a missed event costs a few seconds of
 * staleness, never a lost order.
 */

import { EventEmitter } from 'node:events';
import { logger } from './log.js';

export interface LiveEvent {
  type: string;
  order_id?: string;
  line_id?: string;
  station?: string;
  at: string;
  [key: string]: unknown;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Channel per branch. Tenant id is included so a bug in branch id cannot cross tenants. */
function channel(restaurantId: string, branchId: string): string {
  return `${restaurantId}:${branchId}`;
}

export function publish(
  restaurantId: string,
  branchId: string,
  event: { type: string } & Record<string, unknown>,
): void {
  const payload: LiveEvent = { ...event, type: event.type, at: new Date().toISOString() };
  bus.emit(channel(restaurantId, branchId), payload);
}

export function subscribe(
  restaurantId: string,
  branchId: string,
  onEvent: (e: LiveEvent) => void,
): () => void {
  const ch = channel(restaurantId, branchId);
  bus.on(ch, onEvent);
  logger.debug({ event: 'sse.subscribed', restaurant_id: restaurantId, branch_id: branchId },
    'client subscribed');
  return () => {
    bus.off(ch, onEvent);
    logger.debug({ event: 'sse.unsubscribed', restaurant_id: restaurantId, branch_id: branchId },
      'client unsubscribed');
  };
}

export function subscriberCount(restaurantId: string, branchId: string): number {
  return bus.listenerCount(channel(restaurantId, branchId));
}
