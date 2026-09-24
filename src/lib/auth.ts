/**
 * Authentication (SCOPE.md §4.2, §4.3)
 *
 * Identity in Iran is a phone number, not an email, and staff log in on shared
 * devices in a hot room. So: phone + short PIN, argon2id hashed, short-lived
 * access tokens.
 *
 * The login lookup is the ONE query in the system that runs without a tenant
 * context, because it must resolve a phone number to a tenant before a tenant is
 * known. It goes through app.lookup_staff_for_login(), a SECURITY DEFINER
 * function with a narrow signature that returns only what auth needs. Everything
 * else in the codebase goes through withTenant().
 */

import argon2 from 'argon2';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { withoutTenant } from './db.js';
import { errors } from './errors.js';
import { logger } from './log.js';

export type Role = 'manager' | 'cashier' | 'waiter' | 'kitchen';

export interface Session {
  staffId: string;
  restaurantId: string;
  branchId: string | null;
  role: Role;
  fullName: string;
}

const ACCESS_TTL = process.env.JWT_TTL ?? '12h'; // one shift, not one week

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  // Fail at startup, loudly, rather than signing tokens with a default.
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(s);
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

interface StaffRow {
  staff_id: string;
  restaurant_id: string;
  branch_id: string | null;
  role: Role;
  full_name: string;
  pin_hash: string;
}

/**
 * A dummy hash with the same parameters as a real one. Verifying against it when
 * the phone is unknown keeps the response time of "no such user" and "wrong PIN"
 * indistinguishable. Without it, an attacker can enumerate which phone numbers
 * belong to staff by timing alone.
 */
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  dummyHash ??= await argon2.hash('not-a-real-pin', { type: argon2.argon2id });
  return dummyHash;
}

export async function login(phone: string, pin: string): Promise<Session> {
  const normalised = normalisePhone(phone);

  const row = await withoutTenant(async (client) => {
    const res = await client.query<StaffRow>(
      `SELECT * FROM app.lookup_staff_for_login($1)`, [normalised]);
    return res.rows[0] ?? null;
  });

  const hash = row?.pin_hash ?? (await getDummyHash());
  let ok = false;
  try {
    ok = await argon2.verify(hash, pin);
  } catch {
    ok = false;
  }

  if (!row || !ok) {
    // Logged with the phone but never the PIN. Failed logins are the signal you
    // want at 3am when someone is walking a PIN space.
    logger.warn({ event: 'auth.login_failed', phone: normalised }, 'login failed');
    throw errors.unauthenticated();
  }

  logger.info({
    event: 'auth.login_ok', staff_id: row.staff_id,
    restaurant_id: row.restaurant_id, role: row.role,
  }, 'login succeeded');

  return {
    staffId: row.staff_id,
    restaurantId: row.restaurant_id,
    branchId: row.branch_id,
    role: row.role,
    fullName: row.full_name,
  };
}

/** Accepts 09xx, +989xx and 9xx; stores and compares E.164. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+98')) return digits;
  if (digits.startsWith('0098')) return '+98' + digits.slice(4);
  if (digits.startsWith('0')) return '+98' + digits.slice(1);
  if (digits.startsWith('98') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('9') && digits.length === 10) return '+98' + digits;
  return digits;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export async function issueToken(session: Session): Promise<string> {
  return new SignJWT({
    rid: session.restaurantId,
    bid: session.branchId,
    role: session.role,
    name: session.fullName,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.staffId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(secret());
}

export async function verifyToken(token: string): Promise<Session> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] }));
  } catch {
    throw errors.unauthenticated();
  }

  const rid = payload.rid;
  const role = payload.role;
  // The tenant id from the token is what gets written into the RLS session GUC.
  // If it is not a well-formed uuid the policy would compare against garbage, so
  // this validation is a security boundary, not input tidying.
  if (typeof rid !== 'string' || !UUID.test(rid)) throw errors.unauthenticated();
  if (typeof role !== 'string' || !ROLES.has(role)) throw errors.unauthenticated();
  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw errors.unauthenticated();

  return {
    staffId: payload.sub,
    restaurantId: rid,
    branchId: typeof payload.bid === 'string' ? payload.bid : null,
    role: role as Role,
    fullName: typeof payload.name === 'string' ? payload.name : '',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(['manager', 'cashier', 'waiter', 'kitchen']);

export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{4,6}$/.test(pin)) throw errors.validation('رمز باید ۴ تا ۶ رقم باشد.');
  return argon2.hash(pin, { type: argon2.argon2id });
}

/* ------------------------------------------------------------------ */
/* Authorisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Capability model rather than a role hierarchy. A manager is not "a cashier
 * with more"; these are named permissions and roles are bundles of them, so one
 * person legitimately holding manager+cashier is expressible.
 */
export const CAPABILITIES = {
  'order.open':        ['manager', 'cashier', 'waiter'],
  'order.add_line':    ['manager', 'cashier', 'waiter'],
  'order.serve':       ['manager', 'cashier', 'waiter'],
  'order.void_line':   ['manager', 'cashier'],
  'order.discount':    ['manager', 'cashier'],
  'order.settle':      ['manager', 'cashier'],
  'station.advance':   ['manager', 'kitchen'],
  'menu.read':         ['manager', 'cashier', 'waiter'],
  'menu.write':        ['manager'],
  'menu.import':       ['manager'],
  'report.read':       ['manager'],
  'staff.manage':      ['manager'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly string[]).includes(role);
}

export function require_(role: Role, capability: Capability): void {
  if (!can(role, capability)) throw errors.forbidden();
}
