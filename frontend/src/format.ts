import type { Role, Unit } from './types'

const DIV: Record<Unit, number> = { rial: 1, toman: 10, new_rial: 10_000 }
const LABEL: Record<Unit, string> = { rial: 'ریال', toman: 'تومان', new_rial: 'ریال' }
const FA = '۰۱۲۳۴۵۶۷۸۹'

export const fa = (s: string | number) => String(s).replace(/\d/g, (d) => FA[Number(d)])

/** Persian / Arabic-Indic digits -> ASCII, so a waiter can type on a Persian keyboard. */
export const toLatin = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))

/** Stored amounts are rial; show them in the branch's chosen unit. */
export function money(rial: number | string, unit: Unit, withLabel = true): string {
  const n = Number(rial)
  const v = n / DIV[unit]
  const s = v.toLocaleString('en-US', { maximumFractionDigits: unit === 'new_rial' ? 2 : 1 })
  return fa(s) + (withLabel ? ' ' + LABEL[unit] : '')
}

/** What the user typed, in display units -> rial. Returns null if not a positive number. */
export function parseMoney(input: string, unit: Unit): number | null {
  const n = Number(toLatin(input).replace(/[,٬\s]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * DIV[unit])
}

export const roleLabel: Record<Role, string> = {
  manager: 'مدیر',
  cashier: 'صندوق',
  waiter: 'گارسون',
  kitchen: 'آشپزخانه',
}

export const methodLabel: Record<string, string> = {
  cash: 'نقد',
  pos_card: 'کارتخوان',
  card_to_card: 'کارت‌به‌کارت',
  online_psp: 'درگاه آنلاین',
  on_account: 'حساب مشتری',
}

export const statusLabel: Record<string, string> = {
  queued: 'در صف',
  preparing: 'در حال آماده‌سازی',
  ready: 'آماده',
  served: 'سرو شد',
  void: 'باطل',
}

export function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}

export function clock(iso: string): string {
  return fa(new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
}

/** crypto.randomUUID needs HTTPS; staff testing on a LAN address will not have it. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
