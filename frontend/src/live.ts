import { useEffect, useRef, useState } from 'react'
import { openStream } from './api'

/**
 * Calls `reload` on mount, on every server event, and every 20s as a safety net
 * (a dead-but-open connection looks fine and is wrong). Returns whether the live
 * stream is connected, so the screen can say so honestly.
 */
export function useLive(branchId: string, reload: () => void): boolean {
  const [connected, setConnected] = useState(false)
  const fn = useRef(reload)
  fn.current = reload

  useEffect(() => {
    fn.current()
    const stop = openStream(branchId, () => fn.current(), setConnected)
    const poll = setInterval(() => fn.current(), 20_000)
    return () => {
      stop()
      clearInterval(poll)
    }
  }, [branchId])

  return connected
}
