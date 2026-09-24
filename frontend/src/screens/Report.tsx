import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { fa, methodLabel, money } from '../format'
import type { ScreenProps } from '../types'

interface Daily {
  business_day_fa: string
  totals: Record<'orders' | 'subtotal_irr' | 'discount_irr' | 'service_irr' | 'vat_irr' | 'total_irr', number | string>
  by_method: { method: string; n: number; amount_irr: string }[]
  top_items: { name_fa: string; qty: number; revenue_irr: string }[]
}
interface Voids {
  period_fa: string
  by_staff: { full_name: string; role: string; voids: number; value_irr: string }[]
  recent: { name_fa: string; qty: number; void_reason: string; voided_by_name: string; business_day: string }[]
}

export default function Report({ branch }: ScreenProps) {
  const [daily, setDaily] = useState<Daily | null>(null)
  const [voids, setVoids] = useState<Voids | null>(null)
  const [msg, setMsg] = useState('')
  const u = branch.money_display_unit

  const load = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        api<Daily>(`/reports/daily?branch_id=${branch.id}`),
        api<Voids>(`/reports/voids?branch_id=${branch.id}`),
      ])
      setDaily(d)
      setVoids(v)
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
  }, [branch.id])

  useEffect(() => {
    load()
  }, [load])

  if (!daily || !voids) return <p className="muted">{msg || 'در حال بارگذاری…'}</p>
  const t = daily.totals

  return (
    <div className="grid">
      <div className="spread">
        <h3 style={{ margin: 0 }}>فروش امروز — {daily.business_day_fa}</h3>
        <button className="small" onClick={load}>تازه‌سازی</button>
      </div>

      <div className="grid kpis">
        <div className="card kpi"><span className="muted">فاکتور تسویه‌شده</span><b>{fa(t.orders)}</b></div>
        <div className="card kpi"><span className="muted">فروش کل</span><b>{money(t.total_irr, u)}</b></div>
        <div className="card kpi"><span className="muted">تخفیف‌ها</span><b>{money(t.discount_irr, u)}</b></div>
        <div className="card kpi"><span className="muted">مالیات</span><b>{money(t.vat_irr, u)}</b></div>
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>روش پرداخت</h4>
        <table className="simple">
          <tbody>
            {daily.by_method.map((m) => (
              <tr key={m.method}>
                <td>{methodLabel[m.method] ?? m.method}</td>
                <td>{fa(m.n)} بار</td>
                <td>{money(m.amount_irr, u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>پرفروش‌ترین‌ها</h4>
        <table className="simple">
          <tbody>
            {daily.top_items.map((i) => (
              <tr key={i.name_fa}>
                <td>{i.name_fa}</td>
                <td>{fa(i.qty)} عدد</td>
                <td>{money(i.revenue_irr, u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>حذف آیتم‌ها به تفکیک کارمند — {voids.period_fa}</h4>
        <p className="muted">اگر یک نفر بیش از بقیه حذف می‌کند، همین‌جا دیده می‌شود.</p>
        <table className="simple">
          <tbody>
            {voids.by_staff.map((s) => (
              <tr key={s.full_name}>
                <td>{s.full_name}</td>
                <td>{fa(s.voids)} مورد</td>
                <td>{money(s.value_irr, u)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>آخرین موارد</h4>
        {voids.recent.slice(0, 10).map((v, i) => (
          <div key={i} className="line">
            <span>{fa(v.qty)} × {v.name_fa} — «{v.void_reason}»</span>
            <span className="muted">{v.voided_by_name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
