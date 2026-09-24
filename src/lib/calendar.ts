/**
 * Calendar (SCOPE.md §2.4)
 *
 * Timestamps are stored as timestamptz (UTC). There is no Jalali column anywhere —
 * Jalali is a rendering concern. Iran abolished DST in 2022, so the offset is a
 * fixed +03:30 and this arithmetic needs no tz database.
 *
 * On the conversion itself: I first hand-rolled Borkowski's 2820-year arithmetic
 * cycle. It was subtly wrong — it disagreed with the official Iranian calendar on
 * Nowruz 1404 and treated 1403 as a 365-day year when it is in fact a leap year.
 * The arithmetic cycle is an approximation of what is really an observational
 * calendar. Calendars are a solved problem owned by people who have already found
 * these edge cases, so the conversion is delegated to jalaali-js and verified
 * against known anchors in tests/calendar.test.ts.
 *
 * What is genuinely ours, and genuinely domain-specific, is businessDay().
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const jalaali = require('jalaali-js') as {
  toJalaali(gy: number, gm: number, gd: number): { jy: number; jm: number; jd: number };
  toGregorian(jy: number, jm: number, jd: number): { gy: number; gm: number; gd: number };
  isLeapJalaaliYear(jy: number): boolean;
};

export const TEHRAN_OFFSET_MINUTES = 3 * 60 + 30; // +03:30, fixed since 2022

const MONTHS_FA = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];

// Index 0 = Saturday. The Iranian week starts Saturday; Friday is the weekend.
const WEEKDAYS_FA = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'];

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
const fa = (s: string | number) => String(s).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]!);

export interface JalaliDate { jy: number; jm: number; jd: number; }

/** Shift a UTC instant into Tehran wall-clock, represented as a UTC Date. */
function tehranWallClock(date: Date, offsetMinutes = TEHRAN_OFFSET_MINUTES): Date {
  return new Date(date.getTime() + offsetMinutes * 60_000);
}

export function toJalali(date: Date, offsetMinutes = TEHRAN_OFFSET_MINUTES): JalaliDate {
  const local = tehranWallClock(date, offsetMinutes);
  return jalaali.toJalaali(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate());
}

/** Convert a stored business_day (Gregorian ISO) to Jalali for display. */
export function isoToJalali(iso: string): JalaliDate {
  const [y, m, d] = iso.split('-').map(Number);
  return jalaali.toJalaali(y!, m!, d!);
}

/** e.g. "۲ مهر ۱۴۰۵" or "پنج‌شنبه، ۲ مهر ۱۴۰۵" */
export function formatJalali(date: Date, opts: { withWeekday?: boolean } = {}): string {
  const { jy, jm, jd } = toJalali(date);
  const base = `${fa(jd)} ${MONTHS_FA[jm - 1]} ${fa(jy)}`;
  return opts.withWeekday ? `${WEEKDAYS_FA[weekdayIndex(date)]}، ${base}` : base;
}

export function formatJalaliIso(iso: string): string {
  const { jy, jm, jd } = isoToJalali(iso);
  return `${fa(jd)} ${MONTHS_FA[jm - 1]} ${fa(jy)}`;
}

/** 0 = Saturday ... 6 = Friday. */
export function weekdayIndex(date: Date, offsetMinutes = TEHRAN_OFFSET_MINUTES): number {
  return (tehranWallClock(date, offsetMinutes).getUTCDay() + 1) % 7;
}

export function weekdayNameFa(date: Date): string {
  return WEEKDAYS_FA[weekdayIndex(date)]!;
}

/** Friday is the Iranian weekend. Thursday is commonly a short day, not a holiday. */
export function isWeekend(date: Date): boolean {
  return weekdayIndex(date) === 6;
}

/**
 * The business day an event belongs to.
 *
 * Returns a Gregorian ISO date (YYYY-MM-DD) because that is what the `date`
 * column holds; it is rendered Jalali on the way out. Anything before the
 * branch's cutoff hour belongs to the previous day: a 01:30 order on Saturday
 * morning is Friday night's trade, and the owner will tell you so the first time
 * a report disagrees with the till.
 */
export function businessDay(
  at: Date,
  cutoffHour: number,
  offsetMinutes = TEHRAN_OFFSET_MINUTES,
): string {
  const local = tehranWallClock(at, offsetMinutes);
  if (local.getUTCHours() < cutoffHour) {
    local.setUTCDate(local.getUTCDate() - 1);
  }
  return local.toISOString().slice(0, 10);
}

/** Saturday-anchored week start, for reporting. A Monday-start chart is unreadable here. */
export function weekStart(businessDayIso: string): string {
  const d = new Date(businessDayIso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
}

/** First and last day of the Jalali month containing `iso`. Owners report by Jalali month. */
export function jalaliMonthRange(iso: string): { start: string; end: string; label: string } {
  const { jy, jm } = isoToJalali(iso);
  const daysInMonth = jm <= 6 ? 31 : jm <= 11 ? 30 : jalaali.isLeapJalaaliYear(jy) ? 30 : 29;
  const g1 = jalaali.toGregorian(jy, jm, 1);
  const gN = jalaali.toGregorian(jy, jm, daysInMonth);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    start: `${g1.gy}-${pad(g1.gm)}-${pad(g1.gd)}`,
    end: `${gN.gy}-${pad(gN.gm)}-${pad(gN.gd)}`,
    label: `${MONTHS_FA[jm - 1]} ${fa(jy)}`,
  };
}
