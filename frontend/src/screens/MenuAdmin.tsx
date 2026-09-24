import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import { money } from '../format'
import type { MenuCategory, ScreenProps } from '../types'

/** "86" an item: the most-used menu write in a real café. One tap, effective at once. */
export default function MenuAdmin({ branch }: ScreenProps) {
  const [menu, setMenu] = useState<MenuCategory[]>([])
  const [msg, setMsg] = useState('')
  const u = branch.money_display_unit

  const load = useCallback(async () => {
    try {
      setMenu((await api<{ categories: MenuCategory[] }>(`/menu?branch_id=${branch.id}`)).categories)
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
  }, [branch.id])

  useEffect(() => {
    load()
  }, [load])

  async function toggle(id: string, is_available: boolean) {
    setMsg('')
    try {
      await api(`/menu/items/${id}/availability`, { method: 'PATCH', body: { is_available } })
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'خطا')
    }
    load()
  }

  return (
    <div className="grid">
      <p className="muted">با یک لمس، آیتمی که تمام شده را از منوی گارسون‌ها خارج کنید.</p>
      {msg && <div className="banner">{msg}</div>}
      {menu.map((c) => (
        <div className="card" key={c.id}>
          <h4 style={{ marginTop: 0 }}>{c.name_fa}</h4>
          {c.items.map((i) => (
            <div className="line" key={i.id}>
              <span>
                {i.name_fa} <span className="muted">{money(i.price_irr ?? 0, u, false)}</span>
              </span>
              <button
                className={i.is_available ? 'small' : 'small danger'}
                onClick={() => toggle(i.id, !i.is_available)}
              >
                {i.is_available ? 'موجود ✔' : 'تمام شد ✕'}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
