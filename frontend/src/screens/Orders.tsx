import { useCallback, useState } from 'react'
import { api, ApiError } from '../api'
import { can } from '../caps'
import { fa, uuid } from '../format'
import { useLive } from '../live'
import type { MenuCategory, Order, ScreenProps, TableRow } from '../types'
import OrderPanel from './OrderPanel'

interface OpenOrderRow {
  id: string
  table_id: string | null
  table_label: string | null
}

export default function Orders({ me, branch }: ScreenProps) {
  const [tables, setTables] = useState<TableRow[]>([])
  const [openOrders, setOpenOrders] = useState<OpenOrderRow[]>([])
  const [menu, setMenu] = useState<MenuCategory[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [msg, setMsg] = useState('')
  const role = me.staff.role

  const reload = useCallback(async () => {
    try {
      const [t, o, m] = await Promise.all([
        api<{ tables: TableRow[] }>(`/menu/tables?branch_id=${branch.id}`),
        api<{ orders: OpenOrderRow[] }>(`/orders?branch_id=${branch.id}`),
        api<{ categories: MenuCategory[] }>(`/menu?branch_id=${branch.id}`),
      ])
      setTables(t.tables)
      setOpenOrders(o.orders)
      setMenu(m.categories)
      setTick((n) => n + 1)
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
  }, [branch.id])

  const connected = useLive(branch.id, reload)

  async function openFor(tableId: string | null) {
    setMsg('')
    try {
      const o = await api<Order>('/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': uuid() },
        body: {
          branch_id: branch.id,
          table_id: tableId,
          order_type: tableId ? 'dine_in' : 'takeaway',
        },
      })
      setSelected(o.id)
      reload()
    } catch (e) {
      // Two waiters tapped the same table: the loser is simply taken to the winner's ticket.
      if (e instanceof ApiError && e.code === 'table_occupied') {
        const id = (e.current as { order_id?: string } | undefined)?.order_id
        if (id) setSelected(id)
        setMsg('این میز همین الان توسط شخص دیگری باز شد؛ به فاکتور او منتقل شدید.')
        reload()
      } else setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
  }

  const takeaways = openOrders.filter((o) => !o.table_id)

  return (
    <div className="two-col">
      <div className="grid" style={{ alignContent: 'start' }}>
        {!connected && <div className="banner">به‌روزرسانی زنده قطع است؛ هر ۲۰ ثانیه تازه‌سازی می‌شود.</div>}
        {msg && <div className="banner">{msg}</div>}
        <div className="card">
          <div className="spread">
            <h3 style={{ margin: 0 }}>میزها</h3>
            {can(role, 'order.open') && (
              <button className="small" onClick={() => openFor(null)}>+ بیرون‌بر</button>
            )}
          </div>
          <div className="grid tables" style={{ marginTop: 10 }}>
            {tables.map((t) => (
              <button
                key={t.id}
                className={
                  'table-btn' +
                  (t.open_order_id ? ' busy' : '') +
                  (t.open_order_id && t.open_order_id === selected ? ' selected' : '')
                }
                onClick={() => (t.open_order_id ? setSelected(t.open_order_id) : openFor(t.id))}
              >
                <b>{fa(t.label)}</b>
                <span className="muted" style={{ fontSize: 12 }}>
                  {t.open_order_id ? 'باز' : t.area ?? ''}
                </span>
              </button>
            ))}
          </div>
          {takeaways.length > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              {takeaways.map((o, i) => (
                <button key={o.id} className="small" onClick={() => setSelected(o.id)}>
                  بیرون‌بر {fa(i + 1)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        {selected ? (
          <OrderPanel
            key={selected}
            orderId={selected}
            refreshKey={tick}
            me={me}
            branch={branch}
            menu={menu}
            onChanged={reload}
          />
        ) : (
          <div className="card muted center">یک میز را انتخاب کنید.</div>
        )}
      </div>
    </div>
  )
}
