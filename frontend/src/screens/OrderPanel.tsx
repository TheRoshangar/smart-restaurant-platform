import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { can } from '../caps'
import { fa, money, statusLabel, uuid } from '../format'
import type { Branch, MenuCategory, Me, Order } from '../types'
import Bill from './Bill'

interface Props {
  orderId: string
  refreshKey: number
  me: Me
  branch: Branch
  menu: MenuCategory[]
  onChanged: () => void
}

export default function OrderPanel({ orderId, refreshKey, me, branch, menu, onChanged }: Props) {
  const [order, setOrder] = useState<Order | null>(null)
  const [msg, setMsg] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const role = me.staff.role
  const u = branch.money_display_unit

  const load = useCallback(async () => {
    try {
      setOrder(await api<Order>(`/orders/${orderId}`))
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
  }, [orderId])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  /** A 409 carries the fresh order: show it, tell the user, never leave a stale screen. */
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        const cur = e.current as Order | undefined
        if (cur && Array.isArray(cur.lines)) setOrder(cur)
        setMsg(e.message)
      } else setMsg('خطای غیرمنتظره')
      onChanged()
    },
    [onChanged],
  )

  async function run(fn: () => Promise<Order | unknown>) {
    setBusy(true)
    setMsg('')
    try {
      const r = await fn()
      if (r && typeof r === 'object' && 'lines' in r) setOrder(r as Order)
      else await load()
      onChanged()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const addItem = (itemId: string) =>
    run(() =>
      api<Order>(`/orders/${orderId}/lines`, {
        method: 'POST',
        headers: { 'Idempotency-Key': uuid() },
        body: { menu_item_id: itemId, qty: 1, note: note.trim() || null },
      }).then((r) => {
        setNote('')
        return r
      }),
    )

  const serve = (lineId: string) =>
    run(() => api(`/orders/lines/${lineId}/served`, { method: 'PATCH' }))

  function voidLine(lineId: string) {
    const reason = window.prompt('دلیل حذف این آیتم؟ (الزامی)')
    if (!reason || reason.trim().length < 3) return
    run(() =>
      api<Order>(`/orders/lines/${lineId}/void`, {
        method: 'POST',
        headers: { 'Idempotency-Key': uuid() },
        body: { reason: reason.trim() },
      }),
    )
  }

  if (!order) return <div className="card muted">{msg || 'در حال بارگذاری…'}</div>
  const open = order.status === 'open'

  return (
    <div className="grid">
      <div className="card">
        <div className="spread">
          <h3 style={{ margin: 0 }}>{order.table_label ? `میز ${order.table_label}` : 'بیرون‌بر'}</h3>
          <span className="chip">{open ? 'باز' : 'بسته شده'}</span>
        </div>
        {msg && <div className="banner">{msg}</div>}
        {order.lines.length === 0 && <p className="muted">هنوز آیتمی ثبت نشده.</p>}
        {order.lines.map((l) => (
          <div key={l.id} className={l.status === 'void' ? 'line void' : 'line'}>
            <div>
              {fa(l.qty)} × {l.name_fa}{' '}
              <span className={`badge ${l.status}`}>{statusLabel[l.status]}</span>
              {l.note && <div className="muted">📝 {l.note}</div>}
              <div className="muted" style={{ fontSize: 12 }}>{l.added_by_name}</div>
            </div>
            <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
              <span>{money(l.unit_price_irr * l.qty, u, false)}</span>
              {open && l.status === 'ready' && can(role, 'order.serve') && (
                <button className="small primary" disabled={busy} onClick={() => serve(l.id)}>
                  سرو شد
                </button>
              )}
              {open && l.status !== 'void' && can(role, 'order.void_line') && (
                <button className="small danger" disabled={busy} onClick={() => voidLine(l.id)}>
                  حذف
                </button>
              )}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 12 }}>
          <Bill
            order={order}
            branch={branch}
            role={role}
            onOrder={(o) => {
              setOrder(o)
              onChanged()
            }}
            onError={fail}
          />
        </div>
      </div>

      {open && can(role, 'order.add_line') && (
        <div className="card">
          <input
            placeholder="توضیح برای آیتم بعدی (مثلاً بدون پیاز)"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
          {menu.map((c) => (
            <div key={c.id}>
              <h4>{c.name_fa}</h4>
              <div className="grid menu-items">
                {c.items.map((i) => (
                  <button
                    key={i.id}
                    className={i.is_available ? 'menu-item' : 'menu-item off'}
                    disabled={!i.is_available || busy}
                    onClick={() => addItem(i.id)}
                  >
                    {i.name_fa}
                    <div className="muted">
                      {i.is_available ? money(i.price_irr ?? 0, u, false) : 'تمام شده'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
