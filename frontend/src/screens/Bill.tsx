import { money } from '../format'
import type { Branch, Order } from '../types'

export interface BillProps {
  order: Order
  branch: Branch
  role: string
  onOrder: (o: Order) => void
  onError: (e: unknown) => void
}

/** Step 2: read-only totals. Step 4 replaces this file with discount + settle. */
export default function Bill({ order, branch }: BillProps) {
  const u = branch.money_display_unit
  const b = order.bill
  return (
    <div className="totals">
      <div><span>جمع اقلام</span><span>{money(b.subtotal_irr, u)}</span></div>
      {b.discount_irr > 0 && <div><span>تخفیف</span><span>−{money(b.discount_irr, u)}</span></div>}
      <div><span>سرویس</span><span>{money(b.service_irr, u)}</span></div>
      <div><span>مالیات</span><span>{money(b.vat_irr, u)}</span></div>
      <div className="grand"><span>قابل پرداخت</span><span>{money(b.total_irr, u)}</span></div>
    </div>
  )
}
