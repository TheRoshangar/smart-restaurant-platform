/**
 * Domain tests.
 *
 * These cover the three things that are (a) pure, (b) easy to get subtly wrong,
 * and (c) expensive to get wrong: money arithmetic, the tax/service stacking
 * order, and the calendar. Everything here would be caught by a human eventually
 * — but only after a month of bills being 1% off, or a report disagreeing with
 * the till.
 */

import { describe, it, expect } from 'vitest';
import { parseHumanPrice, format, formatDual, applyBps, toRial } from '../src/lib/money.js';
import { computeBill } from '../src/lib/totals.js';
import {
  businessDay, toJalali, formatJalaliIso, weekdayIndex, weekStart, jalaliMonthRange,
} from '../src/lib/calendar.js';
import { heuristicParse, validateModelOutput } from '../src/ai/menuImport.js';

describe('money', () => {
  it('parses the price forms that actually appear on Iranian menus', () => {
    // The shorthand case: a bare "۱۸۵" on a price list means 185,000 toman.
    expect(parseHumanPrice('۱۸۵')?.rial).toBe(1_850_000);
    expect(parseHumanPrice('۲۴۵,۰۰۰ تومان')?.rial).toBe(2_450_000);
    expect(parseHumanPrice('98000')?.rial).toBe(980_000);
    // An explicit rial suffix must NOT be scaled as toman.
    expect(parseHumanPrice('1,850,000 ریال')?.rial).toBe(1_850_000);
    expect(parseHumanPrice('')).toBeNull();
    expect(parseHumanPrice('بدون قیمت')).toBeNull();
  });

  it('renders the same stored amount in every unit the transition requires', () => {
    const amount = 2_450_000; // rial
    expect(format(amount, { unit: 'toman', persianDigits: false })).toBe('245,000');
    expect(format(amount, { unit: 'rial', persianDigits: false })).toBe('2,450,000');
    // New rial = 10,000 current rial under the redenomination law.
    expect(format(amount, { unit: 'new_rial', persianDigits: false })).toBe('245');
    expect(format(amount, { unit: 'toman' })).toBe('۲۴۵,۰۰۰');
  });

  it('shows both units during parallel circulation', () => {
    expect(formatDual(2_450_000, 'new_rial')).toContain('ریال');
    expect(formatDual(2_450_000, 'new_rial')).toContain('تومان');
  });

  it('refuses amounts that cannot be represented exactly', () => {
    expect(() => toRial(1.5)).toThrow();
    expect(() => toRial(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(toRial('2450000')).toBe(2_450_000);  // BIGINT arrives as a string
  });

  it('applies rates in basis points without floating point drift', () => {
    // 0.1 is not representable in binary floating point; bps arithmetic is.
    expect(applyBps(4_950_000, 1000)).toBe(495_000);
    expect(applyBps(333_333, 900)).toBe(30_000);
  });
});

describe('bill stacking', () => {
  const branch = { service_charge_bps: 1000, vat_bps: 1000, vat_applies_to_service: true };
  const lines = [
    { unit_price_irr: 1_250_000, qty: 2, status: 'served', is_vat_exempt: false },
    { unit_price_irr: 2_450_000, qty: 1, status: 'ready', is_vat_exempt: false },
  ];

  it('excludes voided lines from the subtotal', () => {
    const withVoid = [...lines, { unit_price_irr: 9_990_000, qty: 1, status: 'void', is_vat_exempt: false }];
    expect(computeBill(withVoid, [], branch, 'dine_in').subtotal_irr).toBe(4_950_000);
  });

  it('bills items that are still queued — the customer owes for food being cooked', () => {
    const queued = [{ unit_price_irr: 500_000, qty: 1, status: 'queued', is_vat_exempt: false }];
    expect(computeBill(queued, [], branch, 'dine_in').subtotal_irr).toBe(500_000);
  });

  it('applies service to the post-discount subtotal and VAT on top of service', () => {
    const bill = computeBill(lines, [], branch, 'dine_in');
    expect(bill.subtotal_irr).toBe(4_950_000);
    expect(bill.service_irr).toBe(495_000);          // 10% of 4,950,000
    expect(bill.vat_irr).toBe(544_500);              // 10% of (4,950,000 + 495,000)
    expect(bill.total_irr).toBe(5_989_500);
  });

  it('charges no VAT on takeaway, which is outside Iranian VAT', () => {
    const bill = computeBill(lines, [], branch, 'takeaway');
    expect(bill.vat_irr).toBe(0);
    expect(bill.total_irr).toBe(5_445_000);          // subtotal + service only
  });

  it('never lets discounts drive a bill negative', () => {
    const bill = computeBill(lines, [{ kind: 'amount', value: 999_999_999, voided_at: null }], branch, 'dine_in');
    expect(bill.discount_irr).toBe(4_950_000);
    expect(bill.total_irr).toBe(0);
  });

  it('ignores voided discounts', () => {
    const bill = computeBill(lines, [{ kind: 'percent', value: 5000, voided_at: new Date() }], branch, 'dine_in');
    expect(bill.discount_irr).toBe(0);
  });

  it('excludes exempt items from the taxable base pro rata', () => {
    const mixed = [
      { unit_price_irr: 1_000_000, qty: 1, status: 'served', is_vat_exempt: false },
      { unit_price_irr: 1_000_000, qty: 1, status: 'served', is_vat_exempt: true },
    ];
    const bill = computeBill(mixed, [], branch, 'dine_in');
    const allTaxable = computeBill(
      mixed.map((l) => ({ ...l, is_vat_exempt: false })), [], branch, 'dine_in');
    expect(bill.vat_irr).toBe(Math.round(allTaxable.vat_irr / 2));
  });
});

describe('calendar', () => {
  it('matches the official Iranian calendar at known anchors', () => {
    // Verified against published Nowruz dates. A hand-rolled 2820-year arithmetic
    // cycle failed exactly these cases, which is why the conversion is delegated.
    expect(toJalali(new Date('2026-03-21T09:00:00Z'))).toMatchObject({ jy: 1405, jm: 1, jd: 1 });
    expect(toJalali(new Date('2024-03-20T09:00:00Z'))).toMatchObject({ jy: 1403, jm: 1, jd: 1 });
    expect(formatJalaliIso('2026-09-23')).toBe('۱ مهر ۱۴۰۵');
  });

  it('treats 1403 as a leap year (30 Esfand exists)', () => {
    expect(toJalali(new Date('2025-03-20T09:00:00Z'))).toMatchObject({ jy: 1403, jm: 12, jd: 30 });
  });

  it('puts after-midnight trade on the previous business day', () => {
    // 01:30 Tehran on Saturday morning is Friday night's takings.
    expect(businessDay(new Date('2026-09-26T22:00:00Z'), 5)).toBe('2026-09-26');
    // 06:00 Tehran is the new day.
    expect(businessDay(new Date('2026-09-27T02:30:00Z'), 5)).toBe('2026-09-27');
  });

  it('starts the week on Saturday and puts Friday at the end', () => {
    expect(weekdayIndex(new Date('2026-09-26T12:00:00Z'))).toBe(0); // Saturday
    expect(weekdayIndex(new Date('2026-09-25T12:00:00Z'))).toBe(6); // Friday
    expect(weekStart('2026-09-24')).toBe('2026-09-19');
  });

  it('gives Jalali month ranges for reporting', () => {
    const mehr = jalaliMonthRange('2026-09-24');
    expect(mehr.start).toBe('2026-09-23');
    expect(mehr.end).toBe('2026-10-22');   // Mehr has 31 days... 23 Sep + 30 = 22 Oct
    expect(mehr.label).toBe('مهر ۱۴۰۵');
  });
});

describe('menu import', () => {
  it('parses a real-shaped menu without calling any model', () => {
    const { items } = heuristicParse([
      'قهوه',
      'اسپرسو ....................... ۹۸',
      'لاته   ۱۲۵',
      'کاپوچینو - ۱۱۵,۰۰۰ تومان',
      'دسر',
      'چیزکیک نیویورکی   ۲۴۵,۰۰۰',
    ].join('\n'));

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ name_fa: 'اسپرسو', price_irr: 980_000, station_hint: 'bar' });
    expect(items[3]).toMatchObject({ name_fa: 'چیزکیک نیویورکی', category_hint: 'دسر' });
  });

  it('collects lines it cannot parse rather than guessing', () => {
    const { unparsed } = heuristicParse('یک توضیح طولانی درباره کافه که اصلاً آیتم منو نیست و قیمتی ندارد');
    expect(unparsed).toHaveLength(1);
  });

  it('discards model output that fails the schema — the injection containment boundary', () => {
    // Whatever an injected instruction persuades the model to emit, only
    // well-formed items with sane prices survive validation.
    expect(validateModelOutput('not json at all')).toEqual([]);
    expect(validateModelOutput(JSON.stringify({ items: [{ name_fa: 'رایگان', price_toman: 0 }] }))).toEqual([]);
    expect(validateModelOutput(JSON.stringify({ items: [{ name_fa: 'x', price_toman: 50_000 }] }))).toEqual([]);
    expect(validateModelOutput(JSON.stringify({ items: [{ name_fa: 'لاته', price_toman: 165_000 }] })))
      .toHaveLength(1);
  });

  it('converts model prices from toman to stored rial', () => {
    const [item] = validateModelOutput(JSON.stringify({ items: [{ name_fa: 'لاته', price_toman: 165_000 }] }));
    expect(item!.price_irr).toBe(1_650_000);
  });
});
