const BASE = import.meta.env.VITE_API_URL ?? ''
const KEY = 'mizban_token'

let token: string | null = localStorage.getItem(KEY)
export const getToken = () => token
export function setToken(t: string | null) {
  token = t
  if (t) localStorage.setItem(KEY, t)
  else localStorage.removeItem(KEY)
}

export class ApiError extends Error {
  status: number
  code: string
  /** On a 409 the server sends the current state of the thing that conflicted. */
  current?: unknown
  constructor(status: number, code: string, message: string, current?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.current = current
  }
}

interface Opts {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

let onUnauthenticated: () => void = () => {}
export const setUnauthenticatedHandler = (fn: () => void) => (onUnauthenticated = fn)

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + '/api' + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'network', 'ارتباط با سرور برقرار نشد. اینترنت را بررسی کنید.')
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const e = data?.error
    if (res.status === 401 && path !== '/auth/login') onUnauthenticated()
    throw new ApiError(res.status, e?.code ?? 'unknown', e?.message_fa ?? 'خطای غیرمنتظره', e?.current)
  }
  return data as T
}

/**
 * Live updates. EventSource cannot send an Authorization header, so we read the
 * SSE response with fetch. Every event just means "something changed, reload":
 * the server always sends full state, so a missed event costs staleness, not
 * correctness.
 */
export function openStream(
  branchId: string,
  onEvent: () => void,
  onStatus: (connected: boolean) => void,
): () => void {
  const ctrl = new AbortController()
  let stopped = false

  async function run() {
    while (!stopped) {
      try {
        const res = await fetch(`${BASE}/api/stream?branch_id=${branchId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: ctrl.signal,
        })
        if (!res.ok || !res.body) throw new Error('stream refused')
        onStatus(true)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (chunk.includes('event:')) onEvent()
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      if (stopped) return
      onStatus(false)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  run()
  return () => {
    stopped = true
    ctrl.abort()
  }
}
