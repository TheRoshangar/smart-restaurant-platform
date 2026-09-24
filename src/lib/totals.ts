/**
 * Bill computation (SCOPE.md §2.2, §2.3)
 *
 * This is computed server-side from the stored lines on every read and every
 * settlement. A total supplied by a client is never trusted, and the settlement
 * snapshot on `orders` is written from here, inside the settling transaction.
 *
 * Stacking order is the Iranian convention and it is not arbitrary:
 *   service charge applies to the post-discount subtotal,
 *   VAT applies to subtotal + service charge.
 * Reverse those two and every bill is ~1% wrong in a direction nobody notices
 * until an audit.
 */

import { applyBps } from './money.js';

export interface BillLine {
  unit_price_irr: number;
  qty: number;
  status: string;
  is_vat_exempt: boolean;
}

export interface BillDiscount {
  kind: 'percent' | 'amount';
  value: number;      // bps when percent, rial when amount
  voided_at: Date | string | null;
}

export interface BranchTaxConfig {
  service_charge_bps: number;
  vat_bps: number;
  vat_applies_to_service: boolean;
}

export interface Bill {
  subtotal_irr: number;
  discount_irr: number;
  service_irr: number;
  vat_irr: number;
  total_irr: number;
}

const BILLABLE = new Set(['queued', 'preparing', 'ready', 'served']);

export function computeBill(
  lines: BillLine[],
  discounts: BillDiscount[],
  branch: BranchTaxConfig,
  orderType: 'dine_in' | 'takeaway' | 'delivery',
): Bill {
  const billable = lines.filter((l) => BILLABLE.has(l.status));

  const subtotal = billable.reduce((sum, l) => sum + l.unit_price_irr * l.qty, 0);

  // Discounts apply in insertion order; percent discounts compound on the
  // running remainder, which is what a cashier applying two of them expects.
  let discountTotal = 0;
  let remaining = subtotal;
  for (const d of discounts) {
    if (d.voided_at) continue;
    const amount = d.kind === 'percent' ? applyBps(remaining, d.value) : d.value;
    const capped = Math.min(amount, remaining);
    discountTotal += capped;
    remaining -= capped;
  }

  const netSubtotal = subtotal - discountTotal;
  const service = applyBps(netSubtotal, branch.service_charge_bps);

  // Takeaway-only service is outside Iranian VAT; dine-in is not. This is why
  // order_type is a tax field rather than a label.
  let vat = 0;
  if (orderType === 'dine_in' && netSubtotal > 0) {
    // Exempt items are excluded from the taxable base pro rata.
    const exemptGross = billable
      .filter((l) => l.is_vat_exempt)
      .reduce((s, l) => s + l.unit_price_irr * l.qty, 0);

    const taxableShareBps =
      subtotal === 0 ? 0 : Math.round(((subtotal - exemptGross) * 10_000) / subtotal);

    const base = branch.vat_applies_to_service ? netSubtotal + service : netSubtotal;
    vat = applyBps(applyBps(base, taxableShareBps), branch.vat_bps);
  }

  return {
    subtotal_irr: subtotal,
    discount_irr: discountTotal,
    service_irr: service,
    vat_irr: vat,
    total_irr: netSubtotal + service + vat,
  };
}

export function amountPaid(payments: { amount_irr: number }[]): number {
  return payments.reduce((s, p) => s + p.amount_irr, 0);
}
