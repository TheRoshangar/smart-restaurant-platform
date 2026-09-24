export type Role = 'manager' | 'cashier' | 'waiter' | 'kitchen'
export type Unit = 'rial' | 'toman' | 'new_rial'

export interface Branch {
  id: string
  name: string
  money_display_unit: Unit
  show_dual_currency: boolean
}

export interface Me {
  staff: { id: string; full_name: string; role: Role; branch_id: string | null }
  restaurant: { id: string; name: string }
  branches: Branch[]
}

/** What every screen receives. */
export interface ScreenProps {
  me: Me
  branch: Branch
}

export interface Line {
  id: string
  seq: number
  name_fa: string
  qty: number
  unit_price_irr: number
  station: string
  status: 'queued' | 'preparing' | 'ready' | 'served' | 'void'
  note: string | null
  added_by_name: string
}

export interface Order {
  id: string
  branch_id: string
  table_id: string | null
  table_label: string | null
  status: 'open' | 'settled' | 'voided'
  version: number
  lines: Line[]
  bill: {
    subtotal_irr: number
    discount_irr: number
    service_irr: number
    vat_irr: number
    total_irr: number
  }
  paid_irr: number
}

export interface TableRow {
  id: string
  label: string
  area: string | null
  seats: number | null
  open_order_id: string | null
}

export interface MenuItem {
  id: string
  name_fa: string
  station: string
  is_available: boolean
  price_irr?: number
}
export interface MenuCategory {
  id: string
  name_fa: string
  items: MenuItem[]
}
