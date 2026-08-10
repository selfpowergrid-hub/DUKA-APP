"use client";

import { db, META_KEYS, metaGet } from "./db";
import { businessDate } from "./format";
import type { MovementReason, Product, Sale, SaleItem, Session } from "./types";

/**
 * Reporting, computed entirely from IndexedDB.
 *
 * Reports are the screen most tempting to push onto the server — one SQL query
 * beats scanning thousands of local rows. It is also the screen an owner opens
 * at closing time, standing in a shop with one bar of signal. So it stays
 * local like everything else, and the sync window is sized to cover the
 * longest period the screen offers.
 */

export type PeriodKind = "day" | "week" | "month";

export interface Period {
  kind: PeriodKind;
  /** Inclusive business dates, oldest first. */
  dates: string[];
  from: string;
  to: string;
  label: string;
}

const DAY_MS = 86_400_000;

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return businessDate(new Date(Date.UTC(y, m - 1, d, 12) + days * DAY_MS));
}

function rangeOf(kind: PeriodKind, endDate: string): string[] {
  const span = kind === "day" ? 1 : kind === "week" ? 7 : 30;
  return Array.from({ length: span }, (_, i) => shiftDate(endDate, i - (span - 1)));
}

export function buildPeriod(kind: PeriodKind, endDate: string): Period {
  const dates = rangeOf(kind, endDate);
  return {
    kind,
    dates,
    from: dates[0],
    to: dates[dates.length - 1],
    label: kind === "day" ? "This day" : kind === "week" ? "Last 7 days" : "Last 30 days",
  };
}

/**
 * What to compare against.
 *
 * For a single day that is the SAME WEEKDAY last week, not yesterday — a duka's
 * Saturday looks nothing like its Tuesday, and comparing them manufactures
 * alarm. For longer periods it is the window immediately before, same length.
 */
export function previousPeriod(p: Period): Period {
  return p.kind === "day"
    ? buildPeriod("day", shiftDate(p.to, -7))
    : buildPeriod(p.kind, shiftDate(p.from, -1));
}

export function comparisonLabel(kind: PeriodKind): string {
  return kind === "day"
    ? "same day last week"
    : kind === "week"
      ? "previous 7 days"
      : "previous 30 days";
}

// ---------------------------------------------------------------------------

export interface SalesTotals {
  cash: number;
  mpesa: number;
  /** Goods sold on credit. Counted in `total`, but it is not money received. */
  credit: number;
  total: number;
  count: number;
  average: number;
}

export interface AttendantRow {
  user_id: string;
  name: string;
  total: number;
  cash: number;
  mpesa: number;
  /** Who is handing out the most credit is an accountability question too. */
  credit: number;
  count: number;
}

export interface ProductRow {
  product_id: string;
  name: string;
  quantity: number;
  revenue: number;
  /** Null when any contributing line has no recorded cost. */
  profit: number | null;
}

export interface VarianceRow {
  date: string;
  expectedCash: number;
  counted: number | null;
  difference: number | null;
}

export interface MovementRow {
  reason: MovementReason;
  quantity: number;
  /** Valued at the product's current buying price. */
  value: number;
}

export interface MarginSummary {
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  /** Lines whose cost was never recorded — reported, never counted as zero. */
  unknownLines: number;
  knownLines: number;
}

export interface StockValue {
  atCost: number;
  atRetail: number;
  items: number;
}

export interface PeriodReport {
  period: Period;
  sales: SalesTotals;
  previous: SalesTotals;
  attendants: AttendantRow[];
  variance: VarianceRow[];
  varianceTotal: { expected: number; counted: number; difference: number; countedDays: number };
  topByValue: ProductRow[];
  topByQuantity: ProductRow[];
  slowMovers: Product[];
  margin: MarginSummary;
  movements: MovementRow[];
  stock: StockValue;
  unsynced: number;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function totalsOf(sales: Sale[]): SalesTotals {
  const by = (m: string) =>
    sales.filter((s) => s.payment_method === m).reduce((t, s) => t + s.total, 0);
  const cash = by("cash");
  const mpesa = by("mpesa");
  // Credit belongs in total trade — goods really did leave the shop — but it
  // is deliberately kept as its own figure so it can never be mistaken for
  // money received.
  const credit = by("credit");
  const total = cash + mpesa + credit;
  return {
    cash: round2(cash),
    mpesa: round2(mpesa),
    credit: round2(credit),
    total: round2(total),
    count: sales.length,
    average: sales.length ? round2(total / sales.length) : 0,
  };
}

/**
 * Cost of one line. Portioned sales price per portion but cost per base unit,
 * so "3 x half litre" costs unit_cost x 1.5, not x 3. Getting this wrong would
 * overstate the cost of every measured sale by the portion factor.
 */
function lineCost(item: SaleItem): number | null {
  if (item.unit_cost == null) return null;
  const base = item.base_quantity ?? item.quantity;
  return round2(item.unit_cost * base);
}

export async function buildReport(kind: PeriodKind, endDate: string): Promise<PeriodReport> {
  const period = buildPeriod(kind, endDate);
  const prev = previousPeriod(period);

  // Read by indexed date range rather than scanning every row ever recorded.
  // These used to be `.toArray()` on the whole table and then filtered in JS,
  // which is fine at a few thousand rows and steadily worse after that — on a
  // cheap Android phone with a year of trade it means tens of thousands of
  // rows into memory every time the period changes.
  const [sales, prevSales, products, counts, staff, session] = await Promise.all([
    db.sales.where("business_date").anyOf(period.dates).toArray(),
    db.sales.where("business_date").anyOf(prev.dates).toArray(),
    db.products.toArray(),
    db.cash_counts.where("business_date").anyOf(period.dates).toArray(),
    db.staff.toArray(),
    metaGet<Session>(META_KEYS.session),
  ]);

  const saleIds = sales.map((s) => s.id);
  const items = saleIds.length
    ? await db.sale_items.where("sale_id").anyOf(saleIds).toArray()
    : [];

  const productById = new Map(products.map((p) => [p.id, p]));
  // `staff` only ever has rows RLS allows this device to see — an attendant
  // sees only themselves, correctly, so the roster alone can never name every
  // seller. The signed-in session already carries this device's own name;
  // falling back to it means at least the current user is never "Unknown".
  const staffName = (id: string) => {
    const known = staff.find((u) => u.id === id)?.full_name?.trim();
    if (known) return known;
    if (session && id === session.user_id) return session.full_name?.trim() || session.email;
    return "Unknown";
  };

  // --- by attendant ---------------------------------------------------------
  const byUser = new Map<string, AttendantRow>();
  for (const s of sales) {
    const row =
      byUser.get(s.user_id) ??
      ({
        user_id: s.user_id,
        name: staffName(s.user_id),
        total: 0,
        cash: 0,
        mpesa: 0,
        credit: 0,
        count: 0,
      } as AttendantRow);
    row.total = round2(row.total + s.total);
    if (s.payment_method === "cash") row.cash = round2(row.cash + s.total);
    else if (s.payment_method === "mpesa") row.mpesa = round2(row.mpesa + s.total);
    else row.credit = round2(row.credit + s.total);
    row.count += 1;
    byUser.set(s.user_id, row);
  }

  // --- cash variance, day by day -------------------------------------------
  const variance: VarianceRow[] = period.dates.map((date) => {
    const expected = round2(
      sales
        .filter((s) => s.business_date === date && s.payment_method === "cash")
        .reduce((t, s) => t + s.total, 0),
    );
    const count = counts.find((c) => c.business_date === date);
    return {
      date,
      expectedCash: expected,
      counted: count ? count.counted_amount : null,
      difference: count ? round2(count.counted_amount - expected) : null,
    };
  });
  const countedRows = variance.filter((v) => v.counted != null);
  const varianceTotal = {
    expected: round2(countedRows.reduce((t, v) => t + v.expectedCash, 0)),
    counted: round2(countedRows.reduce((t, v) => t + (v.counted ?? 0), 0)),
    difference: round2(countedRows.reduce((t, v) => t + (v.difference ?? 0), 0)),
    countedDays: countedRows.length,
  };

  // --- products -------------------------------------------------------------
  const byProduct = new Map<string, ProductRow & { unknownCost: boolean }>();
  for (const i of items) {
    const row =
      byProduct.get(i.product_id) ??
      ({
        product_id: i.product_id,
        name: i.product_name,
        quantity: 0,
        revenue: 0,
        profit: 0,
        unknownCost: false,
      } as ProductRow & { unknownCost: boolean });
    row.quantity = round2(row.quantity + (i.base_quantity ?? i.quantity));
    row.revenue = round2(row.revenue + i.line_total);
    const cost = lineCost(i);
    if (cost == null) row.unknownCost = true;
    else row.profit = round2((row.profit ?? 0) + (i.line_total - cost));
    byProduct.set(i.product_id, row);
  }
  const productRows: ProductRow[] = [...byProduct.values()].map((r) => ({
    product_id: r.product_id,
    name: r.name,
    quantity: r.quantity,
    revenue: r.revenue,
    // One unpriced line makes the whole product's profit unknowable. Say so.
    profit: r.unknownCost ? null : r.profit,
  }));

  const sold = new Set(items.map((i) => i.product_id));
  const slowMovers = products
    .filter((p) => p.is_active && p.track_stock !== false && !sold.has(p.id))
    .sort((a, b) => b.quantity * b.buying_price - a.quantity * a.buying_price);

  // --- margin ---------------------------------------------------------------
  let revenue = 0;
  let cost = 0;
  let knownLines = 0;
  let unknownLines = 0;
  for (const i of items) {
    const c = lineCost(i);
    if (c == null) {
      unknownLines += 1;
      continue;
    }
    revenue = round2(revenue + i.line_total);
    cost = round2(cost + c);
    knownLines += 1;
  }
  const margin: MarginSummary = {
    revenue,
    cost,
    profit: round2(revenue - cost),
    marginPct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0,
    unknownLines,
    knownLines,
  };

  // --- stock movements in the period (the shrink report) --------------------
  // Indexed range rather than a full scan. `created_at` is a UTC ISO string,
  // so lexicographic ordering is chronological ordering.
  const fromIso = new Date(`${period.from}T00:00:00+03:00`).toISOString();
  const toIso = new Date(`${period.to}T23:59:59+03:00`).toISOString();
  const moves = await db.stock_movements
    .where("created_at")
    .between(fromIso, toIso, true, true)
    .toArray();
  const byReason = new Map<MovementReason, MovementRow>();
  for (const m of moves) {
    const row = byReason.get(m.reason) ?? { reason: m.reason, quantity: 0, value: 0 };
    const buy = productById.get(m.product_id)?.buying_price ?? 0;
    row.quantity = round2(row.quantity + m.delta);
    row.value = round2(row.value + m.delta * buy);
    byReason.set(m.reason, row);
  }

  // --- stock value now (a snapshot, not a period figure) --------------------
  const tracked = products.filter((p) => p.is_active && p.track_stock !== false);
  const stock: StockValue = {
    atCost: round2(tracked.reduce((t, p) => t + p.quantity * p.buying_price, 0)),
    atRetail: round2(tracked.reduce((t, p) => t + p.quantity * p.selling_price, 0)),
    items: tracked.length,
  };

  return {
    period,
    sales: totalsOf(sales),
    previous: totalsOf(prevSales),
    attendants: [...byUser.values()].sort((a, b) => b.total - a.total),
    variance,
    varianceTotal,
    topByValue: [...productRows].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    topByQuantity: [...productRows].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    slowMovers: slowMovers.slice(0, 10),
    margin,
    movements: [...byReason.values()].sort((a, b) => a.reason.localeCompare(b.reason)),
    stock,
    unsynced: sales.filter((s) => !s.synced_at).length,
  };
}
