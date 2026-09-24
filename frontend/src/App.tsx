import { FormEvent, useState } from 'react'
import './App.css'

function App() {
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(event: FormEvent) {
    event.preventDefault()

    setLoading(true)
    setMessage('')

    try {
      const response = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone,
          pin,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setMessage(data.error?.message_fa || 'ورود ناموفق بود')
        return
      }

      localStorage.setItem('token', data.token)

      setMessage(`خوش آمدید ${data.staff.full_name}`)
    } catch {
      setMessage('ارتباط با سرور برقرار نشد')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <h1>میزبان</h1>
        <p className="subtitle">ورود به پنل مدیریت</p>

        <form onSubmit={handleLogin}>
          <label>
            شماره موبایل
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+989121110001"
              required
            />
          </label>

          <label>
            رمز ورود
            <input
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              placeholder="••••"
              maxLength={6}
              required
            />
          </label>

          <button type="submit" disabled={loading}>
            {loading ? 'در حال ورود...' : 'ورود'}
          </button>
        </form>

        {message && <p className="message">{message}</p>}
      </div>
    </main>
  )
}

export default App