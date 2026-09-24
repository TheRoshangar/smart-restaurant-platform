import type { Role } from './types'

/**
 * Mirror of CAPABILITIES in src/lib/auth.ts. This only decides which buttons to
 * SHOW. The server checks every action again, so a wrong entry here is a
 * cosmetic bug, never a security hole.
 */
const CAPS = {
  'order.open': ['manager', 'cashier', 'waiter'],
  'order.add_line': ['manager', 'cashier', 'waiter'],
  'order.serve': ['manager', 'cashier', 'waiter'],
  'order.void_line': ['manager', 'cashier'],
  'order.discount': ['manager', 'cashier'],
  'order.settle': ['manager', 'cashier'],
  'station.advance': ['manager', 'kitchen'],
  'menu.write': ['manager'],
  'menu.import': ['manager'],
  'report.read': ['manager'],
} as const satisfies Record<string, readonly Role[]>

export type Cap = keyof typeof CAPS
export const can = (role: Role, cap: Cap) => (CAPS[cap] as readonly string[]).includes(role)
