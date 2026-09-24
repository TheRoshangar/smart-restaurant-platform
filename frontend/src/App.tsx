import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, getToken, setToken, setUnauthenticatedHandler } from './api'
import { roleLabel, toLatin } from './format'
import { tabs } from './screens'
import type { Me, Role } from './types'

function Login({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const r = await api<{ token: string }>('/auth/login', {
        method: 'POST',
        body: { phone: toLatin(phone.trim()), pin: toLatin(pin.trim()) },
      })
      setToken(r.token)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ورود ناموفق بود')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1>میزبان</h1>
        <p className="muted">ورود کارکنان</p>
        <label>
          شماره موبایل
          <input
            type="tel"
            dir="ltr"
            inputMode="numeric"
            autoComplete="username"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121110001"
            required
          />
        </label>
        <label>
          رمز (پین)
          <input
            type="password"
            dir="ltr"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={loading}>
          {loading ? 'در حال ورود…' : 'ورود'}
        </button>
      </form>
    </main>
  )
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checking, setChecking] = useState(!!getToken())
  const [branchId, setBranchId] = useState<string>('')
  const [tabId, setTabId] = useState<string>('')

  const logout = useCallback(() => {
    setToken(null)
    setMe(null)
    setChecking(false)
  }, [])

  const loadMe = useCallback(async () => {
    setChecking(true)
    try {
      const m = await api<Me>('/auth/me')
      setMe(m)
      setBranchId((cur) => cur || m.staff.branch_id || m.branches[0]?.id || '')
    } catch {
      setToken(null)
      setMe(null)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    setUnauthenticatedHandler(logout)
    if (getToken()) loadMe()
  }, [loadMe, logout])

  if (checking) return <div className="center muted">در حال بارگذاری…</div>
  if (!me) return <Login onDone={loadMe} />

  const role: Role = me.staff.role
  const myTabs = tabs.filter((t) => t.roles.includes(role))
  const active = myTabs.find((t) => t.id === tabId) ?? myTabs[0]
  const branch = me.branches.find((b) => b.id === branchId) ?? me.branches[0]

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <strong>{me.restaurant.name}</strong>
          {me.branches.length > 1 ? (
            <select value={branch?.id} onChange={(e) => setBranchId(e.target.value)}>
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted"> · {branch?.name}</span>
          )}
        </div>
        <div className="who">
          <span>
            {me.staff.full_name} <span className="chip">{roleLabel[role]}</span>
          </span>
          <button onClick={logout}>خروج</button>
        </div>
      </header>

      {myTabs.length > 1 && (
        <nav className="tabs">
          {myTabs.map((t) => (
            <button
              key={t.id}
              className={t.id === active?.id ? 'tab active' : 'tab'}
              onClick={() => setTabId(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}

      <main className="content">
        {active && branch ? (
          <active.component key={active.id + branch.id} me={me} branch={branch} />
        ) : (
          <p className="muted center">
            ورود موفق بود ✔ — صفحه‌ی این نقش در مرحله‌های بعد اضافه می‌شود.
          </p>
        )}
      </main>
    </div>
  )
}
