import type { ComponentType } from 'react'
import type { Role, ScreenProps } from './types'
import Orders from './screens/Orders'
import Kitchen from './screens/Kitchen'
import Report from './screens/Report'
import MenuAdmin from './screens/MenuAdmin'
export interface Tab {
  id: string
  label: string
  roles: Role[]
  component: ComponentType<ScreenProps>
}

/** One line per screen. Roles decide who sees the tab; the API decides who may act. */
export const tabs: Tab[] = [
  { id: 'orders', label: 'میزها و سفارش‌ها', roles: ['waiter', 'cashier', 'manager'], component: Orders },
  { id: 'kitchen', label: 'آشپزخانه و بار', roles: ['kitchen', 'manager'], component: Kitchen },
  { id: 'report', label: 'گزارش', roles: ['manager'], component: Report },
  { id: 'menu', label: 'موجودی منو', roles: ['manager'], component: MenuAdmin },
]
