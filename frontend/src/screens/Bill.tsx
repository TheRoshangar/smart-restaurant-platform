import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { can } from '../caps'
import { fa, methodLabel, money, parseMoney, toLatin, uuid } from '../format'
import type { Branch, Order } from '../types'

export interface BillProps {
  order: Order
  branch: Branch
  role: string
  onOrder: (o: Order) => void
  onError: (e: unknown) => void
}

interface PayRow {
  method: string
  amount: string
}

export default function Bill({ order, branch, role, onOrder, onError }: BillProps) {
  const u = branch.money_display_unit
  const b = order.bill
  const open = order.status === 'open'
  const r = role as Parameters<typeof can>[0]

  const [discKind, setDiscKind] = useState<'percent' | 'amount'>('percent')
  const [discValue, setDiscValue] = useState('')
  const [discReason, setDiscReason] = useState('')
  const [showDisc, setShowDisc] = useState(false)
  const [pays, setPays] = useState<PayRow[]>([{ method: 'cash', amount: '' }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // One idempotency key per settle *attempt*. If the response is lost and the
  // cashier taps again, the same key makes the server return the first result
  // instead of taking payment twice. It changes only when the bill changes.
  const settleKey = useRef(uuid())
  useEffect(() => {
    settleKey.current = uuid()
  }, [order.version])

  const version = { 'If-Match': String(order.version) }

  async function applyDiscount() {
    setErr('')
    const raw = Number(toLatin(discValue).replace(/,/g, ''))
    const value = discKind === 'percent' ? Math.round(raw * 100) : parseMoney(discValue, u)
    if (!value || value <= 0 || (discKind === 'percent' && value > 10000)) {
      setErr('مقدار تخفیف معتبر نیست.')
      return
    }
    if (discReason.trim().length < 3) {
      setErr('دلیل تخفیف الزامی است.')
      return
    }
    setBusy(true)
    try {
      const o = await api<Order>(`/orders/${order.id}/discounts`, {
        method: 'POST',
        headers: { ...version, 'Idempotency-Key': uuid() },
        body: { kind: discKind, value, reason: discReason.trim() },
      })
      setShowDisc(false)
      setDiscValue('')
      setDiscReason('')
      onOrder(o)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  async function settle() {
    setErr('')
    const payments = pays.map((p) => ({
      method: p.method,
      // An empty amount on a single row means "the full bill".
      amount_irr: p.amount.trim() ? parseMoney(p.amount, u) : pays.length === 1 ? b.total_irr : null,
    }))
    if (payments.some((p) => !p.amount_irr)) {
      setErr('مبلغ هر پرداخت را وارد کنید.')
      return
    }
    setBusy(true)
    try {
      const o = await api<Order>(`/orders/${order.id}/settle`, {
        method: 'POST',
        headers: { ...version, 'Idempotency-Key': settleKey.current },
        body: { payments },
      })
      onOrder(o)
    } catch (e) {
      onError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="totals">
        <div><span>جمع اقلام</span><span>{money(b.subtotal_irr, u)}</span></div>
        {b.discount_irr > 0 && (
          <div><span>تخفیف</span><span>−{money(b.discount_irr, u)}</span></div>
        )}
        <div><span>سرویس</span><span>{money(b.service_irr, u)}</span></div>
        <div><span>مالیات</span><span>{money(b.vat_irr, u)}</span></div>
        <div className="grand"><span>قابل پرداخت</span><span>{money(b.total_irr, u)}</span></div>
      </div>

      {!open && order.status === 'settled' && (
        <div className="banner" style={{ background: '#e3f4e8', borderColor: '#a9d8b8', marginTop: 10 }}>
          ✔ تسویه شد — پرداخت‌شده: {money(order.paid_irr, u)}
        </div>
      )}

      {open && order.lines.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {can(r, 'order.discount') && (
            <>
              <button className="small" onClick={() => setShowDisc((v) => !v)}>
                {showDisc ? 'بستن تخفیف' : 'تخفیف'}
              </button>
              {showDisc && (
                <div className="card" style={{ marginTop: 8 }}>
                  <div className="row">
                    <select value={discKind} onChange={(e) => setDiscKind(e.target.value as 'percent' | 'amount')}>
                      <option value="percent">درصد</option>
                      <option value="amount">مبلغ ({u === 'toman' ? 'تومان' : 'ریال'})</option>
                    </select>
                    <input
                      inputMode="decimal"
                      placeholder={discKind === 'percent' ? 'مثلاً ۱۰' : 'مبلغ'}
                      value={discValue}
                      onChange={(e) => setDiscValue(e.target.value)}
                    />
                  </div>
                  <input
                    style={{ marginTop: 8 }}
                    placeholder="دلیل تخفیف (الزامی)"
                    value={discReason}
                    onChange={(e) => setDiscReason(e.target.value)}
                  />
                  <button className="primary" style={{ marginTop: 8 }} disabled={busy} onClick={applyDiscount}>
                    اعمال تخفیف
                  </button>
                </div>
              )}
            </>
          )}

          {can(r, 'order.settle') && (
            <div className="card" style={{ marginTop: 10 }}>
              <h4 style={{ marginTop: 0 }}>تسویه</h4>
              {pays.map((p, i) => (
                <div className="row" key={i} style={{ marginBottom: 6 }}>
                  <select
                    style={{ flex: 1 }}
                    value={p.method}
                    onChange={(e) =>
                      setPays(pays.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))
                    }
                  >
                    {Object.entries(methodLabel).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <input
                    style={{ flex: 1 }}
                    inputMode="numeric"
                    placeholder={pays.length === 1 ? `کل مبلغ (${fa(money(b.total_irr, u, false))})` : 'مبلغ'}
                    value={p.amount}
                    onChange={(e) =>
                      setPays(pays.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                    }
                  />
                  {pays.length > 1 && (
                    <button className="small" onClick={() => setPays(pays.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              <div className="row">
                {pays.length < 6 && (
                  <button className="small" onClick={() => setPays([...pays, { method: 'pos_card', amount: '' }])}>
                    + تقسیم پرداخت
                  </button>
                )}
                <button className="primary" disabled={busy} onClick={settle}>
                  {busy ? 'در حال ثبت…' : 'ثبت پرداخت و بستن فاکتور'}
                </button>
              </div>
            </div>
          )}
          {err && <p className="error">{err}</p>}
        </div>
      )}
    </div>
  )
}
