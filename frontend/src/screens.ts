import type { ComponentType } from 'react'
import type { Role, ScreenProps } from './types'
import Orders from './screens/Orders'
export interface Tab {
  id: string
  label: string
  roles: Role[]
  component: ComponentType<ScreenProps>
}

/** One line per screen. Roles decide who sees the tab; the API decides who may act. */
export const tabs: Tab[] = [
  { id: 'orders', label: 'میزها و سفارش‌ها', roles: ['waiter', 'cashier', 'manager'], component: Orders },
]
