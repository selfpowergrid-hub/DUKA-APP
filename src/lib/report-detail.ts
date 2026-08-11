"use client";

import { db } from "./db";
import { pendingDeltas } from "./store";
import type { Period } from "./reports";
import type { MovementReason, Product, SaleItem, StockMovement } from "./types";

/**
 * The drill-down reports: the product table, the stock card, and the trading
 * account.
 *
 * All three answer questions the summary screen only gestures at — "which
 * products actually made money", "why does the count say 14 when it should say
 * 20", "did the shop make anything this week" — and all three are derived from
 * the same movement and sale ledgers, so nothing here is a second source of
 * truth that could drift from the summary.
 *
 * One idea does most of the work. `products.quantity` is the count RIGHT NOW,
 * but a report about last week needs the count as it was at the end of last
 * week. Both are recoverable exactly, because every change is a movement:
 *
 *     closing  = quantity now − everything that moved after the period ended
 *     opening  = closing      − everything that moved during the period
 *
 * No snapshots, no month-end close, nothing to run. A period from three months
 * ago reconstructs as precisely as today does, as long as the device still
 * holds the movements.
 *
 * "Quantity now" is the one subtlety. `products.quantity` is maintained by the
 * server trigger, so it reflects only what has SYNCED — on a phone that has
 * been selling offline all morning it is stale by exactly this morning's
 * trade. Every read here adds the unsynced movements back, the same way the
 * product list and the till already do. Without it the reports would quietly
 * disagree with the shelf whenever the shop was offline, which is most of the
 * time and precisely when they are most needed.
 */

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 1. Every product: opening, sold, remaining, profit
// ---------------------------------------------------------------------------

export interface ProductLine {
  product_id: string;
  name: string;
  unit: string;
  /** On the shelf when the period began. */
  opening: number;
  /** Came IN during the period — restock, opening stock, returns. */
  received: number;
  /** Sold during the period, in the product's own unit. */
  sold: number;
  /** Left the shop without being sold — damage, loss, recounts down. */
  lost: number;
  /** On the shelf when the period ended. */
  remaining: number;
  revenue: number;
  cost: number | null;
  /** Null when ANY contributing line has no recorded cost. Never guessed. */
  profit: number | null;
  marginPct: number | null;
  /** Stock on hand at the end, valued at the product's cost. */
  remainingValue: number;
  /** True when the arithmetic does not close — see `balanced` below. */
  discrepancy: number;
}

/**
 * The identity every row must satisfy:
 *
 *     opening + received − sold − lost = remaining
 *
 * `discrepancy` is what is left over when it does not. It should always be
 * zero, and if it is not, something wrote to `products.quantity` outside the
 * movement ledger — which is exactly the bug this shape exists to make
 * impossible. Reporting it beats silently balancing the row.
 */
export async function productLines(period: Period): Promise<ProductLine[]> {
  const [products, movements, items, sales, pending] = await Promise.all([
    db.products.toArray(),
    db.stock_movements.toArray(),
    db.sale_items.toArray(),
    db.sales.toArray(),
    pendingDeltas(),
  ]);

  const end = period.dates[period.dates.length - 1];

  // Sales are dated by business date; movements by timestamp. Mapping each
  // movement through its sale where it has one keeps the two consistent — a
  // sale rung up at 23:50 must land in the same period on both sides.
  const saleDate = new Map(sales.map((s) => [s.id, s.business_date]));
  const dateOf = (m: StockMovement) =>
    (m.sale_id ? saleDate.get(m.sale_id) : undefined) ?? m.created_at.slice(0, 10);

  const inPeriod = new Set(period.dates);
  const byProduct = new Map<
    string,
    { during: StockMovement[]; after: StockMovement[] }
  >();
  for (const m of movements) {
    const d = dateOf(m);
    const bucket = byProduct.get(m.product_id) ?? { during: [], after: [] };
    if (inPeriod.has(d)) bucket.during.push(m);
    else if (d > end) bucket.after.push(m);
    byProduct.set(m.product_id, bucket);
  }

  const soldByProduct = new Map<string, { revenue: number; cost: number; unknown: boolean }>();
  const itemDate = (i: SaleItem) => saleDate.get(i.sale_id);
  for (const i of items) {
    const d = itemDate(i);
    if (!d || !inPeriod.has(d)) continue;
    const row = soldByProduct.get(i.product_id) ?? { revenue: 0, cost: 0, unknown: false };
    row.revenue = round2(row.revenue + i.line_total);
    if (i.unit_cost == null) row.unknown = true;
    else row.cost = round2(row.cost + i.unit_cost * (i.base_quantity ?? i.quantity));
    soldByProduct.set(i.product_id, row);
  }

  const lines: ProductLine[] = products.map((p) => {
    const bucket = byProduct.get(p.id) ?? { during: [], after: [] };
    const afterDelta = bucket.after.reduce((t, m) => t + m.delta, 0);
    const duringDelta = bucket.during.reduce((t, m) => t + m.delta, 0);

    const remaining = round3(p.quantity + (pending.get(p.id) ?? 0) - afterDelta);
    const opening = round3(remaining - duringDelta);

    const sumWhere = (fn: (r: MovementReason) => boolean) =>
      round3(bucket.during.filter((m) => fn(m.reason)).reduce((t, m) => t + m.delta, 0));

    const received = sumWhere((r) => r === "restock" || r === "opening" || r === "return");
    const soldQty = -sumWhere((r) => r === "sale");
    // Recounts can go either way; a downward one is a loss like any other.
    const lost = -sumWhere((r) => r === "damage" || r === "loss" || r === "adjustment");

    const money = soldByProduct.get(p.id);
    const cost = money && !money.unknown ? money.cost : null;
    const revenue = money?.revenue ?? 0;
    const profit = cost == null ? null : round2(revenue - cost);

    return {
      product_id: p.id,
      name: p.name,
      unit: p.unit,
      opening,
      received,
      sold: round3(soldQty),
      lost: round3(lost),
      remaining,
      revenue,
      cost,
      profit,
      marginPct: profit == null || revenue <= 0 ? null : round2((profit / revenue) * 100),
      remainingValue: round2(Math.max(0, remaining) * p.buying_price),
      discrepancy: round3(opening + received - soldQty - lost - remaining),
    };
  });

  // Movers first — a report opening on thirty untouched products buries the
  // three that matter.
  return lines.sort(
    (a, b) => b.revenue - a.revenue || b.sold - a.sold || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// 2. The stock card: opening → every movement → closing
// ---------------------------------------------------------------------------

export interface StockCardEntry {
  movement: StockMovement;
  /** Running balance AFTER this movement. */
  balance: number;
  date: string;
  /** Filled for a sale, so a line can be traced to the transaction. */
  saleTotal: number | null;
}

export interface StockCard {
  product: Product;
  opening: number;
  closing: number;
  entries: StockCardEntry[];
}

/**
 * One product's movement, in order, with a running balance.
 *
 * This is the screen that answers "the shelf says 14 and the app says 20" —
 * not with a total, but by showing every event between the two so the owner
 * can point at the line where they diverged. It is the same reasoning as the
 * customer ledger showing a running balance rather than just what is owed.
 */
export async function stockCard(productId: string, period: Period): Promise<StockCard | null> {
  const product = await db.products.get(productId);
  if (!product) return null;

  const [movements, sales, pending] = await Promise.all([
    db.stock_movements.where("product_id").equals(productId).toArray(),
    db.sales.toArray(),
    pendingDeltas(),
  ]);

  const saleDate = new Map(sales.map((s) => [s.id, s.business_date]));
  const saleTotal = new Map(sales.map((s) => [s.id, s.total]));
  const dateOf = (m: StockMovement) =>
    (m.sale_id ? saleDate.get(m.sale_id) : undefined) ?? m.created_at.slice(0, 10);

  const end = period.dates[period.dates.length - 1];
  const inPeriod = new Set(period.dates);

  const during = movements
    .filter((m) => inPeriod.has(dateOf(m)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const afterDelta = movements
    .filter((m) => dateOf(m) > end)
    .reduce((t, m) => t + m.delta, 0);

  const closing = round3(product.quantity + (pending.get(productId) ?? 0) - afterDelta);
  const opening = round3(closing - during.reduce((t, m) => t + m.delta, 0));

  let running = opening;
  const entries: StockCardEntry[] = during.map((m) => {
    running = round3(running + m.delta);
    return {
      movement: m,
      balance: running,
      date: dateOf(m),
      saleTotal: m.sale_id ? (saleTotal.get(m.sale_id) ?? null) : null,
    };
  });

  return { product, opening, closing, entries };
}

// ---------------------------------------------------------------------------
// 3. The trading account
// ---------------------------------------------------------------------------

export interface TradingAccount {
  sales: number;
  refunds: number;
  netSales: number;
  costOfGoods: number;
  grossProfit: number;
  grossMarginPct: number;
  /** Damage, loss and downward recounts, valued at cost. */
  stockLosses: number;
  /** Debt the owner forgave. A reversal is NOT a loss and is excluded. */
  badDebt: number;
  tradingProfit: number;
  /** Sale lines with no recorded cost — excluded rather than counted as free. */
  unpricedLines: number;
  /** Stock on hand at the end of the period, at cost. Not profit; capital. */
  closingStockValue: number;
}

/**
 * Sales less what the goods cost, less what was lost.
 *
 * Deliberately NOT called a profit and loss account. A P&L ends in net profit
 * after rent, salaries, electricity and licences — none of which this app
 * records, and inventing them would be worse than omitting them. What this can
 * state honestly is the trading position: everything below it is a real
 * measurement rather than an estimate.
 */
export async function tradingAccount(period: Period): Promise<TradingAccount> {
  const [lines, refundRows, debtEntries, products, movements, sales] = await Promise.all([
    productLines(period),
    db.refunds.where("business_date").anyOf(period.dates).toArray(),
    db.debt_entries.where("business_date").anyOf(period.dates).toArray(),
    db.products.toArray(),
    db.stock_movements.toArray(),
    db.sales.where("business_date").anyOf(period.dates).toArray(),
  ]);

  const costOf = new Map(products.map((p) => [p.id, p.buying_price]));
  const saleDate = new Map(
    (await db.sales.toArray()).map((s) => [s.id, s.business_date]),
  );
  const inPeriod = new Set(period.dates);

  // Losses are valued at cost, not at retail. Marking a loss up to the price
  // it might have fetched inflates it — the shop is out what it paid.
  const stockLosses = round2(
    movements
      .filter((m) => {
        const d = (m.sale_id ? saleDate.get(m.sale_id) : undefined) ?? m.created_at.slice(0, 10);
        return (
          inPeriod.has(d) &&
          m.delta < 0 &&
          (m.reason === "damage" || m.reason === "loss" || m.reason === "adjustment")
        );
      })
      .reduce((t, m) => t + -m.delta * (costOf.get(m.product_id) ?? 0), 0),
  );

  const salesTotal = round2(sales.reduce((t, s) => t + s.total, 0));
  const refunds = round2(refundRows.reduce((t, r) => t + r.amount, 0));
  const costOfGoods = round2(
    lines.reduce((t, l) => t + (l.cost ?? 0), 0),
  );
  const netSales = round2(salesTotal - refunds);
  const grossProfit = round2(netSales - costOfGoods);

  // A write-off is money the owner chose to give up. A reversal is goods
  // coming back and is NOT a loss — counting it here would overstate bad debt
  // on the very figure the Debts screen exists to keep honest.
  const badDebt = round2(
    debtEntries.filter((e) => e.kind === "writeoff").reduce((t, e) => t + e.amount, 0),
  );

  return {
    sales: salesTotal,
    refunds,
    netSales,
    costOfGoods,
    grossProfit,
    grossMarginPct: netSales > 0 ? round2((grossProfit / netSales) * 100) : 0,
    stockLosses,
    badDebt,
    tradingProfit: round2(grossProfit - stockLosses - badDebt),
    unpricedLines: lines.filter((l) => l.revenue > 0 && l.cost == null).length,
    closingStockValue: round2(lines.reduce((t, l) => t + l.remainingValue, 0)),
  };
}
