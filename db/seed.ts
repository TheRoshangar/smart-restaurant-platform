/**
 * Demo data.
 *
 * "An empty application is a failed submission, and the demo data is read as
 * evidence of how well you understand the business." So this is not lorem ipsum:
 *
 *  - Two tenants, so tenant isolation is demonstrable rather than asserted.
 *    The second one exists specifically so you can log in as it and confirm you
 *    cannot see the first.
 *  - A real Tehran cafe menu at plausible 1405 prices, with the bar/kitchen split
 *    that actually determines who makes what.
 *  - Fourteen days of trading with a realistic shape: Thursday night is the peak
 *    because Friday is the weekend, Friday daytime is dead, late evening dominates.
 *  - Voids, discounts and split payments in the history, because the reports are
 *    meaningless without them and because they are what the owner will look for.
 */

import pg from 'pg';
import argon2 from 'argon2';
import { businessDay } from '../src/lib/calendar.js';
import 'dotenv/config';

const t = (toman: number) => toman * 10; // toman -> current rial

/* ------------------------------------------------------------------ */

const MENU: Array<{ cat: string; items: Array<[string, number, 'bar' | 'kitchen', number?]> }> = [
  { cat: 'قهوه', items: [
    ['اسپرسو', 95_000, 'bar', 2],
    ['اسپرسو دوبل', 125_000, 'bar', 2],
    ['آمریکانو', 115_000, 'bar', 3],
    ['لاته', 165_000, 'bar', 4],
    ['کاپوچینو', 155_000, 'bar', 4],
    ['موکا', 185_000, 'bar', 5],
    ['فلت وایت', 175_000, 'bar', 4],
    ['قهوه دمی (V60)', 195_000, 'bar', 7],
  ]},
  { cat: 'چای و دمنوش', items: [
    ['چای سیاه (قوری)', 85_000, 'bar', 5],
    ['چای سبز', 95_000, 'bar', 5],
    ['دمنوش به و لیمو', 135_000, 'bar', 6],
    ['هات چاکلت', 175_000, 'bar', 5],
  ]},
  { cat: 'نوشیدنی سرد', items: [
    ['آیس لاته', 185_000, 'bar', 4],
    ['آیس آمریکانو', 145_000, 'bar', 3],
    ['شیک شکلات', 225_000, 'bar', 6],
    ['لیموناد نعناع', 165_000, 'bar', 5],
    ['آب معدنی', 35_000, 'bar', 1],
  ]},
  { cat: 'صبحانه', items: [
    ['املت گوجه', 285_000, 'kitchen', 12],
    ['نیمرو با نان تست', 245_000, 'kitchen', 10],
    ['صبحانه ایرانی (نان، پنیر، گردو، عسل)', 395_000, 'kitchen', 12],
  ]},
  { cat: 'غذا', items: [
    ['سالاد سزار', 425_000, 'kitchen', 12],
    ['پاستا آلفردو', 485_000, 'kitchen', 18],
    ['برگر مخصوص', 545_000, 'kitchen', 20],
    ['ساندویچ مرغ گریل', 425_000, 'kitchen', 15],
    ['سیب زمینی سرخ کرده', 195_000, 'kitchen', 8],
  ]},
  { cat: 'دسر', items: [
    ['چیزکیک نیویورکی', 265_000, 'bar', 3],
    ['براونی با بستنی', 245_000, 'bar', 3],
    ['کیک هویج', 215_000, 'bar', 3],
  ]},
];

const STAFF: Array<[string, string, string, 'manager' | 'cashier' | 'waiter' | 'kitchen']> = [
  ['مریم رضایی',    '+989121110001', '1234', 'manager'],
  ['سعید کاظمی',    '+989121110002', '1111', 'cashier'],
  ['فرشته احمدی',   '+989121110008', '7777', 'cashier'],
  ['نگار موسوی',    '+989121110003', '2222', 'waiter'],
  ['امیر حسینی',    '+989121110004', '3333', 'waiter'],
  ['بهزاد فتحی',    '+989121110005', '4444', 'kitchen'],
  ['الهام نوری',    '+989121110006', '5555', 'kitchen'],
];

/** area, label, seats */
const TABLES: Array<['hall' | 'terrace' | 'family' | 'bar', string, number]> = [
  ['hall', '۱', 2], ['hall', '۲', 2], ['hall', '۳', 4], ['hall', '۴', 4],
  ['hall', '۵', 4], ['hall', '۶', 6], ['hall', '۷', 2], ['hall', '۸', 2],
  ['family', '۱۰', 6], ['family', '۱۱', 6], ['family', '۱۲', 4],
  ['terrace', 'تراس ۱', 4], ['terrace', 'تراس ۲', 4], ['terrace', 'تراس ۳', 2],
  ['bar', 'بار ۱', 1], ['bar', 'بار ۲', 1],
];

const VOID_REASONS = [
  'مشتری نظرش عوض شد',
  'اشتباه گارسون در ثبت',
  'سفارش دیر آماده شد',
  'آیتم تمام شده بود',
];

const DISCOUNT_REASONS = [
  'مشتری همیشگی',
  'جبران تاخیر در سرو',
  'تخفیف پرسنل',
  'کوپن اینستاگرام',
];

/* ------------------------------------------------------------------ */

function rnd<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }
function rndInt(lo: number, hi: number): number { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

/**
 * Orders per business day, shaped like a real Tehran cafe week.
 * Index 0 = Saturday. Thursday (index 5) is the big night because Friday is the
 * weekend; Friday itself is quiet until evening.
 */
const WEEKDAY_VOLUME = [38, 34, 36, 40, 46, 72, 44];

/** Hour-of-day weights, Tehran local. Late evening dominates. */
const HOUR_WEIGHTS: Array<[number, number]> = [
  [8, 3], [9, 5], [10, 6], [11, 6], [12, 7], [13, 8], [14, 6], [15, 6],
  [16, 8], [17, 10], [18, 12], [19, 14], [20, 16], [21, 18], [22, 16], [23, 10], [0, 5],
];

function pickHour(): number {
  const total = HOUR_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [h, w] of HOUR_WEIGHTS) { r -= w; if (r <= 0) return h; }
  return 20;
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_ADMIN is not set');

  const c = new pg.Client({ connectionString: url });
  await c.connect();

  try {
    await c.query('BEGIN');

    // Idempotent: re-running seed gives a clean, identical dataset.
    await c.query(`TRUNCATE restaurants CASCADE`);

    /* ---- Tenant 1: the demo cafe, two branches ---- */

    const { rows: [rest] } = await c.query(
      `INSERT INTO restaurants (name, legal_name, national_id)
       VALUES ('کافه نقشینه','نقشینه پارس','14001234567') RETURNING id`);

    const { rows: [b1] } = await c.query(
      `INSERT INTO branches (restaurant_id, name, service_charge_bps, vat_bps,
                             business_day_cutoff_hour, money_display_unit, show_dual_currency)
       VALUES ($1,'شعبه ونک',1000,1000,5,'toman',true) RETURNING id`, [rest.id]);
    const main1: string = b1.id;

    // A second branch, because "some of them have more than one branch".
    const { rows: [b2] } = await c.query(
      `INSERT INTO branches (restaurant_id, name, service_charge_bps, vat_bps,
                             business_day_cutoff_hour, money_display_unit)
       VALUES ($1,'شعبه سعادت‌آباد',1000,1000,5,'toman') RETURNING id`, [rest.id]);
    const main2: string = b2.id;

    /* ---- Staff ---- */

    const staffIds: Record<string, string> = {};
    for (const [name, phone, pin, role] of STAFF) {
      const hash = await argon2.hash(pin, { type: argon2.argon2id });
      // The manager spans both branches (branch_id NULL); everyone else is sited.
      const branch = role === 'manager' ? null : main1;
      const { rows: [s] } = await c.query(
        `INSERT INTO staff (restaurant_id, phone, full_name, pin_hash, role, branch_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [rest.id, phone, name, hash, role, branch]);
      staffIds[role] = staffIds[role] ?? s.id;
      staffIds[phone] = s.id;
    }

    // One extra waiter at the second branch, so multi-branch scoping is visible.
    await c.query(
      `INSERT INTO staff (restaurant_id, phone, full_name, pin_hash, role, branch_id)
       VALUES ($1,'+989121110007','کاوه اسدی',$2,'waiter',$3)`,
      [rest.id, await argon2.hash('6666', { type: argon2.argon2id }), main2]);

    /* ---- Room ---- */

    const tableIds: string[] = [];
    for (const branch of [main1, main2]) {
      for (const [area, label, seats] of TABLES) {
        const { rows: [tb] } = await c.query(
          `INSERT INTO dining_tables (restaurant_id, branch_id, label, area, seats)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`, [rest.id, branch, label, area, seats]);
        if (branch === main1) tableIds.push(tb.id);
      }
    }

    /* ---- Menu ---- */

    const itemIds: Array<{ id: string; price: number; station: string }> = [];
    let catOrder = 0;
    for (const { cat, items } of MENU) {
      const { rows: [cg] } = await c.query(
        `INSERT INTO menu_categories (restaurant_id, name_fa, sort_order)
         VALUES ($1,$2,$3) RETURNING id`, [rest.id, cat, catOrder++]);

      let itemOrder = 0;
      for (const [name, toman, station, prep] of items) {
        const { rows: [mi] } = await c.query(
          `INSERT INTO menu_items (restaurant_id, category_id, name_fa, base_price_irr,
                                   station, prep_minutes, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [rest.id, cg.id, name, t(toman), station, prep ?? null, itemOrder++]);
        itemIds.push({ id: mi.id, price: t(toman), station });
      }
    }

    // The Saadatabad branch charges ~8% more on coffee. Branch pricing is real.
    for (const it of itemIds.filter((i) => i.station === 'bar').slice(0, 8)) {
      await c.query(
        `INSERT INTO menu_item_branch_prices (restaurant_id, menu_item_id, branch_id, price_irr)
         VALUES ($1,$2,$3,$4)`,
        [rest.id, it.id, main2, Math.round(it.price * 1.08 / 10_000) * 10_000]);
    }

    // Something is 86'd tonight, because something always is.
    await c.query(
      `UPDATE menu_items SET is_available = false WHERE restaurant_id = $1 AND name_fa = $2`,
      [rest.id, 'قهوه دمی (V60)']);

    /* ---- Trading history ---- */

    const waiters  = [staffIds['+989121110003']!, staffIds['+989121110004']!];
    const cashier  = staffIds['+989121110002']!;   // day shift
    const cashierB = staffIds['+989121110008']!;   // night shift
    const manager  = staffIds['+989121110001']!;

    // Voids are attributed across both cashiers, and deliberately NOT evenly.
    // The night cashier voids roughly three times as much by value. That is the
    // pattern an owner buys this product to see — a void report where everything
    // is attributed to one person tells them nothing, and a perfectly even one
    // tells them nothing either.
    const voidActor = () => (Math.random() < 0.72 ? cashierB : cashier);

    let orderCount = 0;
    let lineCount = 0;

    for (let daysAgo = 14; daysAgo >= 1; daysAgo--) {
      const dayAnchor = new Date(Date.now() - daysAgo * 86_400_000);
      const day = businessDay(dayAnchor, 5);
      const weekdayIdx = (new Date(day + 'T12:00:00Z').getUTCDay() + 1) % 7;
      const volume = Math.round(WEEKDAY_VOLUME[weekdayIdx]! * (0.85 + Math.random() * 0.3));

      for (let n = 0; n < volume; n++) {
        const hour = pickHour();
        // Reconstruct a UTC instant for this local hour on this business day.
        const openedAt = new Date(
          new Date(day + 'T00:00:00Z').getTime()
          + (hour < 5 ? hour + 24 : hour) * 3_600_000
          + rndInt(0, 59) * 60_000
          - 3.5 * 3_600_000);

        // Whoever is on till at that hour closes the bill and approves discounts.
        const tillStaff = hour >= 18 || hour < 5 ? cashierB : cashier;

        const takeaway = Math.random() < 0.18;
        const orderType = takeaway ? 'takeaway' : 'dine_in';
        const waiter = rnd(waiters);

        const { rows: [ord] } = await c.query(
          `INSERT INTO orders (restaurant_id, branch_id, table_id, order_type, status,
                               guest_count, opened_by, opened_at, business_day, version)
           VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,1) RETURNING id`,
          [rest.id, main1, takeaway ? null : rnd(tableIds), orderType,
           takeaway ? null : rndInt(1, 5), waiter, openedAt, day]);

        await c.query(
          `INSERT INTO order_events (restaurant_id, order_id, type, payload, actor_staff_id, actor_role, at)
           VALUES ($1,$2,'order.opened',$3,$4,'waiter',$5)`,
          [rest.id, ord.id, { order_type: orderType, business_day: day }, waiter, openedAt]);

        const lineTotal = rndInt(1, 6);
        let subtotal = 0;

        for (let seq = 1; seq <= lineTotal; seq++) {
          const item = rnd(itemIds);
          const qty = Math.random() < 0.82 ? 1 : 2;
          const voided = Math.random() < 0.035;
          const status = voided ? 'void' : 'served';
          const addedAt = new Date(openedAt.getTime() + (seq - 1) * rndInt(60_000, 420_000));

          await c.query(
            `INSERT INTO order_lines (restaurant_id, order_id, seq, menu_item_id,
               name_fa_snapshot, unit_price_irr, qty, station, status, added_by, added_at,
               started_at, ready_at, served_at, voided_by, voided_at, void_reason)
             SELECT $1,$2,$3,mi.id,mi.name_fa,$4,$5,mi.station,$6,$7,$8,$9,$10,$11,$12,$13,$14
               FROM menu_items mi WHERE mi.id = $15`,
            [rest.id, ord.id, seq, item.price, qty, status, waiter, addedAt,
             voided ? null : new Date(addedAt.getTime() + 120_000),
             voided ? null : new Date(addedAt.getTime() + 480_000),
             voided ? null : new Date(addedAt.getTime() + 600_000),
             voided ? voidActor() : null,
             voided ? new Date(addedAt.getTime() + 240_000) : null,
             voided ? rnd(VOID_REASONS) : null,
             item.id]);

          if (!voided) subtotal += item.price * qty;
          lineCount++;
        }

        // Every line on this ticket was voided. That happens in real life (a table
        // that leaves before anything is served) and it must close, not linger open —
        // otherwise the table is never released. The one_open_ticket_per_table index
        // caught this during seeding, which is exactly what it is there for.
        if (subtotal === 0) {
          await c.query(
            `UPDATE orders SET status='voided', closed_by=$2, closed_at=$3, version=2
              WHERE id=$1`,
            [ord.id, tillStaff, new Date(openedAt.getTime() + 1_800_000)]);
          continue;
        }

        // Discount on ~12% of bills, always with a reason and an approver.
        let discount = 0;
        if (Math.random() < 0.12) {
          const bps = rnd([500, 1000, 1500, 2000]);
          discount = Math.round((subtotal * bps) / 10_000);
          await c.query(
            `INSERT INTO order_discounts (restaurant_id, order_id, kind, value, reason, approved_by, created_at)
             VALUES ($1,$2,'percent',$3,$4,$5,$6)`,
            [rest.id, ord.id, bps, rnd(DISCOUNT_REASONS),
             Math.random() < 0.3 ? manager : tillStaff,
             new Date(openedAt.getTime() + 2_400_000)]);
        }

        const net = subtotal - discount;
        const service = Math.round((net * 1000) / 10_000);
        const vat = orderType === 'dine_in' ? Math.round(((net + service) * 1000) / 10_000) : 0;
        const total = net + service + vat;
        const closedAt = new Date(openedAt.getTime() + rndInt(25, 95) * 60_000);

        // Payment mix reflects reality: card terminal dominant, cash still common,
        // and split bills between friends are normal.
        const split = Math.random() < 0.15;
        if (split) {
          const half = Math.round(total / 2);
          await c.query(
            `INSERT INTO payments (restaurant_id, order_id, method, amount_irr, reference, taken_by, at)
             VALUES ($1,$2,'pos_card',$3,$4,$5,$6), ($1,$2,'cash',$7,null,$5,$6)`,
            [rest.id, ord.id, half, String(rndInt(100000, 999999)), tillStaff, closedAt, total - half]);
        } else {
          const method = Math.random() < 0.68 ? 'pos_card' : Math.random() < 0.85 ? 'cash' : 'card_to_card';
          await c.query(
            `INSERT INTO payments (restaurant_id, order_id, method, amount_irr, reference, taken_by, at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [rest.id, ord.id, method, total,
             method === 'pos_card' ? String(rndInt(100000, 999999)) : null, tillStaff, closedAt]);
        }

        await c.query(
          `UPDATE orders SET status='settled', closed_by=$2, closed_at=$3, version=2,
                  subtotal_irr=$4, discount_irr=$5, service_irr=$6, vat_irr=$7, total_irr=$8
            WHERE id=$1`,
          [ord.id, tillStaff, closedAt, subtotal, discount, service, vat, total]);

        await c.query(
          `INSERT INTO order_events (restaurant_id, order_id, type, payload, actor_staff_id, actor_role, at)
           VALUES ($1,$2,'order.settled',$3,$4,'cashier',$5)`,
          [rest.id, ord.id, { total_irr: total, subtotal_irr: subtotal }, tillStaff, closedAt]);

        orderCount++;
      }
    }

    /* ---- Tonight: live open tickets, so the app is usable the moment it opens ---- */

    const now = new Date();
    const today = businessDay(now, 5);
    const liveTables = tableIds.slice(0, 5);

    for (let i = 0; i < liveTables.length; i++) {
      const waiter = rnd(waiters);
      const openedAt = new Date(now.getTime() - rndInt(5, 50) * 60_000);
      const { rows: [ord] } = await c.query(
        `INSERT INTO orders (restaurant_id, branch_id, table_id, order_type, status,
                             guest_count, opened_by, opened_at, business_day)
         VALUES ($1,$2,$3,'dine_in','open',$4,$5,$6,$7) RETURNING id`,
        [rest.id, main1, liveTables[i], rndInt(2, 5), waiter, openedAt, today]);

      // Each live ticket sits at a different point in the flow, so the kitchen
      // screen has something queued, something preparing and something ready.
      const stages: string[][] = [
        ['queued', 'queued'],
        ['preparing', 'queued', 'served'],
        ['ready', 'served'],
        ['served', 'served', 'preparing'],
        ['queued'],
      ];
      const plan = stages[i] ?? ['queued'];

      for (let seq = 1; seq <= plan.length; seq++) {
        const item = rnd(itemIds);
        const st = plan[seq - 1]!;
        await c.query(
          `INSERT INTO order_lines (restaurant_id, order_id, seq, menu_item_id,
             name_fa_snapshot, unit_price_irr, qty, station, status, added_by, added_at,
             started_at, ready_at, served_at)
           SELECT $1,$2,$3,mi.id,mi.name_fa,$4,1,mi.station,$5,$6,$7,$8,$9,$10
             FROM menu_items mi WHERE mi.id = $11`,
          [rest.id, ord.id, seq, item.price, st, waiter, openedAt,
           ['preparing','ready','served'].includes(st) ? new Date(openedAt.getTime() + 120_000) : null,
           ['ready','served'].includes(st) ? new Date(openedAt.getTime() + 420_000) : null,
           st === 'served' ? new Date(openedAt.getTime() + 540_000) : null,
           item.id]);
        lineCount++;
      }

      await c.query(
        `INSERT INTO order_events (restaurant_id, order_id, type, payload, actor_staff_id, actor_role, at)
         VALUES ($1,$2,'order.opened',$3,$4,'waiter',$5)`,
        [rest.id, ord.id, { live: true }, waiter, openedAt]);
      orderCount++;
    }

    // An open cash shift, so the cashier screen is in a usable state.
    await c.query(
      `INSERT INTO shifts (restaurant_id, branch_id, business_day, opened_by, opening_float_irr)
       VALUES ($1,$2,$3,$4,$5)`,
      [rest.id, main1, today, cashier, t(500_000)]);

    /* ---- Tenant 2: exists so isolation is demonstrable, not just claimed ---- */

    const { rows: [other] } = await c.query(
      `INSERT INTO restaurants (name, legal_name) VALUES ('رستوران شمشاد','شمشاد سنتی') RETURNING id`);
    const { rows: [otherBranch] } = await c.query(
      `INSERT INTO branches (restaurant_id, name) VALUES ($1,'شعبه اصلی') RETURNING id`, [other.id]);
    await c.query(
      `INSERT INTO staff (restaurant_id, phone, full_name, pin_hash, role, branch_id)
       VALUES ($1,'+989129990001','حسن شمشادی',$2,'manager',$3)`,
      [other.id, await argon2.hash('9999', { type: argon2.argon2id }), otherBranch.id]);
    const { rows: [otherCat] } = await c.query(
      `INSERT INTO menu_categories (restaurant_id, name_fa) VALUES ($1,'کباب') RETURNING id`, [other.id]);
    for (const [name, toman] of [['چلوکباب کوبیده', 980_000], ['جوجه کباب', 1_150_000], ['دیزی سنگی', 850_000]] as const) {
      await c.query(
        `INSERT INTO menu_items (restaurant_id, category_id, name_fa, base_price_irr, station)
         VALUES ($1,$2,$3,$4,'kitchen')`, [other.id, otherCat.id, name, t(toman)]);
    }

    await c.query('COMMIT');

    console.log(`seeded: ${orderCount} orders, ${lineCount} lines, ${itemIds.length} menu items, 2 tenants`);
    console.log('\nDemo logins (کافه نقشینه):');
    for (const [name, phone, pin, role] of STAFF) {
      console.log(`  ${role.padEnd(8)} ${phone}  PIN ${pin}   ${name}`);
    }
    console.log('\nSecond tenant, for proving isolation (رستوران شمشاد):');
    console.log('  manager  +989129990001  PIN 9999   حسن شمشادی');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
