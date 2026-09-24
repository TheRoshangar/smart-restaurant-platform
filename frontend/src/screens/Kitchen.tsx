import { useCallback, useState } from 'react'
import { api, ApiError } from '../api'
import { can } from '../caps'
import { fa, minutesSince } from '../format'
import { useLive } from '../live'
import type { ScreenProps } from '../types'

interface StationLine {
  id: string
  name_fa: string
  qty: number
  status: 'queued' | 'preparing' | 'ready'
  note: string | null
  added_at: string
  table_label: string | null
  order_type: string
}

const NEXT = { queued: 'preparing', preparing: 'ready' } as const
const BUTTON = { queued: 'شروع کن', preparing: 'آماده شد' } as const
const COLS: { status: StationLine['status']; title: string }[] = [
  { status: 'queued', title: 'در صف' },
  { status: 'preparing', title: 'در حال آماده‌سازی' },
  { status: 'ready', title: 'آماده — منتظر گارسون' },
]

export default function Kitchen({ me, branch }: ScreenProps) {
  const [station, setStation] = useState<'kitchen' | 'bar'>('kitchen')
  const [lines, setLines] = useState<StationLine[]>([])
  const [msg, setMsg] = useState('')
  const canAdvance = can(me.staff.role, 'station.advance')

  const reload = useCallback(async () => {
    try {
      const r = await api<{ lines: StationLine[] }>(
        `/reports/station?branch_id=${branch.id}&station=${station}`,
      )
      setLines(r.lines)
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
  }, [branch.id, station])

  // Re-subscribes when the station toggles, which also reloads immediately.
  const connected = useLive(branch.id + station, reload)

  async function advance(l: StationLine) {
    if (l.status === 'ready') return
    setMsg('')
    try {
      await api(`/orders/lines/${l.id}/status`, {
        method: 'PATCH',
        body: { from: l.status, to: NEXT[l.status] },
      })
    } catch (e) {
      // 409 = someone else (or another screen) moved it first. Not an error worth
      // alarming a cook over: say so and show the truth.
      setMsg(
        e instanceof ApiError && e.status === 409
          ? 'این آیتم قبلاً توسط شخص دیگری تغییر کرد؛ صفحه به‌روز شد.'
          : e instanceof ApiError
            ? e.message
            : 'خطا',
      )
    }
    reload()
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="row">
          <button className={station === 'kitchen' ? 'tab active' : 'tab'} onClick={() => setStation('kitchen')}>
            آشپزخانه
          </button>
          <button className={station === 'bar' ? 'tab active' : 'tab'} onClick={() => setStation('bar')}>
            بار
          </button>
        </div>
        <span className="muted">{connected ? '● زنده' : '○ قطع (تازه‌سازی هر ۲۰ ثانیه)'}</span>
      </div>
      {msg && <div className="banner">{msg}</div>}

      <div className="board">
        {COLS.map((col) => {
          const items = lines.filter((l) => l.status === col.status)
          return (
            <div key={col.status}>
              <h3>
                {col.title} <span className="chip">{fa(items.length)}</span>
              </h3>
              {items.length === 0 && <p className="muted">—</p>}
              {items.map((l) => {
                const wait = minutesSince(l.added_at)
                const cls = 'card ticket' + (wait >= 20 ? ' late' : wait >= 10 ? ' slow' : '')
                return (
                  <div key={l.id} className={cls}>
                    <div className="spread">
                      <b>
                        {fa(l.qty)} × {l.name_fa}
                      </b>
                      <span className="muted">{fa(wait)} دقیقه</span>
                    </div>
                    <div className="muted">
                      {l.table_label ? `میز ${fa(l.table_label)}` : 'بیرون‌بر'}
                    </div>
                    {l.note && <div>📝 {l.note}</div>}
                    {canAdvance && l.status !== 'ready' && (
                      <button className="primary" style={{ marginTop: 8, width: '100%' }} onClick={() => advance(l)}>
                        {BUTTON[l.status]}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
