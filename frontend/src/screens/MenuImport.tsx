import { useState } from 'react'
import { api, ApiError } from '../api'
import { fa, money, parseMoney } from '../format'
import type { ScreenProps } from '../types'

interface Proposed {
  name_fa: string
  price_irr: number
  station_hint: 'kitchen' | 'bar' | null
  confidence: 'high' | 'low'
}
interface Proposal {
  import_id: string
  parsed_by: string
  model_available: boolean
  items: Proposed[]
  unparsed: string[]
}
interface Row {
  keep: boolean
  name: string
  price: string
  station: 'kitchen' | 'bar' | 'none'
  low: boolean
}

/**
 * Two-phase on purpose: the AI proposes, a human approves every row, and only
 * then is anything written. Whatever the model says (or is tricked into saying)
 * cannot reach the live menu without this screen.
 */
export default function MenuImport({ branch }: ScreenProps) {
  const u = branch.money_display_unit
  const [text, setText] = useState('')
  const [category, setCategory] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function analyse() {
    setBusy(true)
    setMsg('')
    try {
      const p = await api<Proposal>('/menu/import', { method: 'POST', body: { text } })
      setProposal(p)
      setRows(
        p.items.map((i) => ({
          keep: true,
          name: i.name_fa,
          price: money(i.price_irr, u, false).replace(/[٬,]/g, ''),
          station: i.station_hint ?? 'kitchen',
          low: i.confidence === 'low',
        })),
      )
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!proposal) return
    const items = rows
      .filter((r) => r.keep)
      .map((r) => ({ name_fa: r.name.trim(), price_irr: parseMoney(r.price, u), station: r.station }))
    if (!category.trim()) return setMsg('نام دسته را وارد کنید.')
    if (items.some((i) => !i.name_fa || !i.price_irr)) return setMsg('نام و قیمت همه‌ی ردیف‌های انتخابی باید معتبر باشد.')
    setBusy(true)
    try {
      const r = await api<{ created: number }>(`/menu/import/${proposal.import_id}/apply`, {
        method: 'POST',
        body: { category_name: category.trim(), items },
      })
      setMsg(`${fa(r.created)} آیتم به منو اضافه شد ✔`)
      setProposal(null)
      setText('')
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    } finally {
      setBusy(false)
    }
  }

  const set = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <div className="grid">
      {msg && <div className="banner">{msg}</div>}
      {!proposal ? (
        <div className="card">
          <p className="muted">
            متن منوی خود را (مثلاً از اینستاگرام یا فایل) اینجا بچسبانید. سامانه آیتم‌ها و قیمت‌ها را
            پیشنهاد می‌دهد؛ هیچ‌چیز بدون تأیید شما ذخیره نمی‌شود.
          </p>
          <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'کاپوچینو ۱۲۵\nلاته ۱۳۵\nکیک شکلاتی ۱۸۵'} />
          <button className="primary" style={{ marginTop: 8 }} disabled={busy || text.trim().length < 10} onClick={analyse}>
            {busy ? 'در حال تحلیل…' : 'تحلیل منو'}
          </button>
        </div>
      ) : (
        <div className="card">
          {!proposal.model_available && (
            <p className="muted">سرویس هوشمند فعال نیست؛ فقط تحلیل ساده انجام شد.</p>
          )}
          <label>
            نام دسته‌ی جدید
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="مثلاً نوشیدنی گرم" />
          </label>
          {rows.map((r, i) => (
            <div className="row" key={i} style={{ marginBottom: 6, background: r.low ? '#fff4d6' : undefined }}>
              <input type="checkbox" style={{ width: 20 }} checked={r.keep} onChange={(e) => set(i, { keep: e.target.checked })} />
              <input style={{ flex: 3 }} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
              <input style={{ flex: 1 }} inputMode="numeric" value={r.price} onChange={(e) => set(i, { price: e.target.value })} />
              <select style={{ flex: 1 }} value={r.station} onChange={(e) => set(i, { station: e.target.value as Row['station'] })}>
                <option value="kitchen">آشپزخانه</option>
                <option value="bar">بار</option>
                <option value="none">بدون ایستگاه</option>
              </select>
            </div>
          ))}
          {proposal.unparsed.length > 0 && (
            <>
              <h4>خطوطی که فهمیده نشد (دستی وارد کنید)</h4>
              {proposal.unparsed.map((l, i) => <div key={i} className="muted">{l}</div>)}
            </>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy} onClick={apply}>تأیید و افزودن به منو</button>
            <button onClick={() => setProposal(null)}>انصراف</button>
          </div>
          <p className="muted">ردیف‌های زردرنگ اطمینان کمتری دارند؛ قبل از تأیید بررسی کنید.</p>
        </div>
      )}
    </div>
  )
}
