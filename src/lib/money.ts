/**
 * Money (SCOPE.md §2.1)
 *
 * Storage unit is the CURRENT RIAL, as a JS number constrained to safe-integer range
 * (BIGINT in Postgres). There are no floats anywhere in this file by design: a cafe
 * bill of 4,850,000 rial multiplied by a 1.10 float is how a POS loses a rial a time,
 * ten thousand times a month.
 *
 * Iran is mid-redenomination. The law promulgated in Azar 1404 removes four zeros:
 * new rial = 10,000 current rial, subdivided into 100 qeran, with both units in
 * parallel circulation for up to three years. So the storage unit and the display
 * unit are deliberately different concerns, and every price a human sees passes
 * through format() below.
 */

export type MoneyUnit = 'rial' | 'toman' | 'new_rial';

/** Current rial per display unit. */
const RIAL_PER_UNIT: Record<MoneyUnit, number> = {
  rial: 1,
  toman: 10,
  new_rial: 10_000,
};

const UNIT_LABEL_FA: Record<MoneyUnit, string> = {
  rial: 'ریال',
  toman: 'تومان',
  new_rial: 'ریال',
};

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Postgres returns BIGINT as a string to avoid precision loss. Convert once, at the edge. */
export function toRial(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`money: unsafe amount ${v}`);
  }
  return n;
}

/**
 * Apply a basis-point rate to an integer amount, rounding half-up, once.
 * Rates live in bps (1000 = 10%) because VAT moved 9% -> 10% and will move again,
 * and because 0.1 is not representable in binary floating point.
 */
export function applyBps(amountRial: number, bps: number): number {
  if (!Number.isSafeInteger(amountRial)) throw new Error('money: unsafe base');
  return Math.round((amountRial * bps) / 10_000);
}

export function toPersianDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]!);
}

export interface FormatOptions {
  unit: MoneyUnit;
  /** Render Persian numerals. On for UI, off for machine-readable output. */
  persianDigits?: boolean;
  withLabel?: boolean;
}

/**
 * The single place a stored amount becomes a string a human reads.
 *
 * Note that rial -> toman is a factor of 10, so amounts are not always whole in the
 * display unit; we keep up to two fractional places and trim. new_rial carries qeran
 * as its fractional part, which is exactly the 1/100 subdivision in the new law.
 */
export function format(amountRial: number, opts: FormatOptions): string {
  const divisor = RIAL_PER_UNIT[opts.unit];
  const whole = Math.trunc(amountRial / divisor);
  const remainder = Math.abs(amountRial % divisor);

  let out = whole.toLocaleString('en-US');

  if (remainder > 0) {
    const places = opts.unit === 'new_rial' ? 2 : 1;
    const frac = String(remainder).padStart(String(divisor).length - 1, '0').slice(0, places);
    const trimmed = frac.replace(/0+$/, '');
    if (trimmed) out += '.' + trimmed;
  }

  if (opts.persianDigits !== false) out = toPersianDigits(out);
  if (opts.withLabel) out += ' ' + UNIT_LABEL_FA[opts.unit];
  return out;
}

/**
 * Transition-period rendering: during parallel circulation a receipt that shows only
 * one unit is a customer dispute waiting to happen.
 */
export function formatDual(amountRial: number, primary: MoneyUnit): string {
  const secondary: MoneyUnit = primary === 'new_rial' ? 'toman' : 'new_rial';
  return (
    format(amountRial, { unit: primary, withLabel: true }) +
    ' (' +
    format(amountRial, { unit: secondary, withLabel: true }) +
    ')'
  );
}

/**
 * Parse a price written by a human on a menu, in any of the forms actually used.
 *
 * Handles: Persian/Arabic-Indic numerals, thousands separators (, and ٬),
 * a تومان/ريال suffix, and the ubiquitous menu shorthand where "۱۸۵" means
 * 185,000 toman rather than 185 toman. The shorthand rule is: a bare number
 * below the threshold with no separators is scaled by 1000.
 *
 * Used by the deterministic menu-import fallback, which is why it must be
 * predictable rather than clever.
 */
export function parseHumanPrice(raw: string): { rial: number; assumedUnit: MoneyUnit } | null {
  let s = raw.trim();
  if (!s) return null;

  // Normalise Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII.
  s = s.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
       .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));

  const isRial = /ری[اآ]ل|ريال/.test(s);
  const hadSeparator = /[,٬،]/.test(s);

  s = s.replace(/[,٬،\s]/g, '');
  const m = s.match(/(\d+)/);
  if (!m) return null;

  let value = Number(m[1]);
  if (!Number.isSafeInteger(value)) return null;

  const unit: MoneyUnit = isRial ? 'rial' : 'toman';

  // Menu shorthand: "۱۸۵" on a price list is 185,000 toman, not 185 toman.
  if (!hadSeparator && !isRial && value > 0 && value < 10_000) {
    value *= 1000;
  }

  return { rial: value * RIAL_PER_UNIT[unit], assumedUnit: unit };
}
