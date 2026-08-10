"use client";

import { db } from "./db";
import { businessDate } from "./format";
import type { ProductBatch, StockMovement } from "./types";

/**
 * Batches, expiry and FEFO dispensing.
 *
 * The same shape the rest of this app already uses twice: an append-only event
 * log plus an answer DERIVED from it, never stored. `stock_movements` →
 * `products.quantity` does it for total stock; `debt_entries` → balance does it
 * for what a customer owes. A batch's remaining quantity is the same thing
 * again, summed per batch.
 *
 * The only change from the debt version is the sort key. Debt allocates FIFO,
 * oldest charge first. Stock allocates **FEFO** — first expiry, first out —
 * because the risk being managed is not age but death date, and a carton
 * received later can easily expire sooner.
 */

/** How close to expiry before the shop should be doing something about it. */
export const EXPIRY_WARN_DAYS = 90;

export type ExpiryState = "expired" | "critical" | "soon" | "ok";

/**
 * Tuned for a chemist, not for general retail.
 *
 * A wholesaler will usually take stock back with 3 months of life on it, and
 * almost never with less than 1. So the bands mark the points where the owner's
 * available ACTION changes — return it, discount it, watch it — rather than
 * being decorative thresholds.
 */
export const EXPIRY_BANDS: Array<{ key: ExpiryState; label: string; action: string }> = [
  { key: "expired", label: "Expired", action: "Pull off the shelf now" },
  { key: "critical", label: "Under 30 days", action: "Too late to return — use or lose" },
  { key: "soon", label: "30–90 days", action: "Return to supplier or move it" },
  { key: "ok", label: "Over 90 days", action: "Normal" },
];

export function daysUntil(expiry: string, today = businessDate()): number {
  return Math.round(
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

export function expiryState(expiry: string, today = businessDate()): ExpiryState {
  const d = daysUntil(expiry, today);
  // A carton expiring TODAY is still sellable today: pharmaceutical expiry is
  // "use by the end of this date", and refusing it a day early would have the
  // shop destroying good stock.
  if (d < 0) return "expired";
  if (d < 30) return "critical";
  if (d <= EXPIRY_WARN_DAYS) return "soon";
  return "ok";
}

export interface BatchStock {
  batch: ProductBatch;
  /** Derived by summing this batch's movements. Never stored. */
  quantity: number;
  daysLeft: number;
  state: ExpiryState;
}

/** Deterministic FEFO order. Both devices must agree, so the tiebreak matters. */
export function sortFefo(rows: BatchStock[]): BatchStock[] {
  return [...rows].sort(
    (a, b) =>
      a.batch.expiry_date.localeCompare(b.batch.expiry_date) ||
      a.batch.created_at.localeCompare(b.batch.created_at) ||
      a.batch.id.localeCompare(b.batch.id),
  );
}

/**
 * What is actually on the shelf, per batch, nearest expiry first.
 *
 * `movements` is every movement for the product. Anything with no `batch_id`
 * is ignored here — it belongs to the product's untracked pool, which is how
 * stock recorded before batches existed continues to behave correctly rather
 * than being silently attributed to whichever batch came first.
 */
export function batchStock(
  batches: ProductBatch[],
  movements: StockMovement[],
  today = businessDate(),
): BatchStock[] {
  const byBatch = new Map<string, number>();
  for (const m of movements) {
    if (!m.batch_id) continue;
    byBatch.set(m.batch_id, (byBatch.get(m.batch_id) ?? 0) + m.delta);
  }

  return sortFefo(
    batches.map((batch) => {
      const quantity = Math.round((byBatch.get(batch.id) ?? 0) * 1000) / 1000;
      return {
        batch,
        quantity,
        daysLeft: daysUntil(batch.expiry_date, today),
        state: expiryState(batch.expiry_date, today),
      };
    }),
  );
}

export interface Allocation {
  /** Null means the untracked pool — stock that predates batch tracking. */
  batch_id: string | null;
  batch_no: string;
  expiry_date: string;
  quantity: number;
}

export interface AllocationResult {
  lines: Allocation[];
  /** How much could not be covered by unexpired stock. */
  short: number;
  /** Unexpired quantity available at the time of allocation. */
  available: number;
  /** How much of the allocation came from stock with no known expiry. */
  fromUnbatched: number;
}

/**
 * Take `wanted` units from the shelf, nearest expiry first.
 *
 * Expired batches are skipped entirely rather than being used last. Selling
 * expired medicine is not a lesser option to fall back on — and if the only
 * stock left is expired, the honest answer is "there is none", which is what
 * `short` reports. The till surfaces that rather than quietly dispensing it.
 *
 * `wanted` is in BASE units, so ten tablets out of a strip of thirty allocate
 * correctly: the portion has already been multiplied out by its factor before
 * this is called.
 */
export function allocateFefo(
  stock: BatchStock[],
  wanted: number,
  opts: { unbatched?: number; today?: string } = {},
): AllocationResult {
  const today = opts.today ?? businessDate();
  const unbatched = Math.max(0, opts.unbatched ?? 0);

  const usable = sortFefo(stock).filter(
    (b) => b.quantity > 0 && expiryState(b.batch.expiry_date, today) !== "expired",
  );
  const available =
    Math.round((usable.reduce((t, b) => t + b.quantity, 0) + unbatched) * 1000) / 1000;

  const lines: Allocation[] = [];
  let left = wanted;
  for (const b of usable) {
    if (left <= 0.0001) break;
    const take = Math.min(left, b.quantity);
    lines.push({
      batch_id: b.batch.id,
      batch_no: b.batch.batch_no,
      expiry_date: b.batch.expiry_date,
      quantity: Math.round(take * 1000) / 1000,
    });
    left = Math.round((left - take) * 1000) / 1000;
  }

  // Stock that predates batch tracking, used only after every known batch.
  //
  // Without this, turning batch tracking on for a product already sitting on
  // the shelf would make it unsellable, and the shop would simply turn the
  // feature back off — losing expiry tracking entirely, which is far worse
  // than trading down old stock whose expiry nobody recorded. It sorts LAST so
  // it drains only once the dated stock is gone, and it is recorded as a
  // movement with no batch, which is the honest description of it.
  let fromUnbatched = 0;
  if (left > 0.0001 && unbatched > 0) {
    fromUnbatched = Math.round(Math.min(left, unbatched) * 1000) / 1000;
    lines.push({
      batch_id: null,
      batch_no: "",
      expiry_date: "",
      quantity: fromUnbatched,
    });
    left = Math.round((left - fromUnbatched) * 1000) / 1000;
  }

  return { lines, short: Math.max(0, left), available, fromUnbatched };
}

/** Stock recorded before batch tracking was switched on for this product. */
export function unbatchedQuantity(movements: StockMovement[]): number {
  return (
    Math.round(
      movements.filter((m) => !m.batch_id).reduce((t, m) => t + m.delta, 0) * 1000,
    ) / 1000
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Batch position for one product. */
export async function stockOfProduct(
  productId: string,
  today = businessDate(),
): Promise<BatchStock[]> {
  const [batches, movements] = await Promise.all([
    db.product_batches.where("product_id").equals(productId).toArray(),
    db.stock_movements.where("product_id").equals(productId).toArray(),
  ]);
  return batchStock(batches, movements, today);
}

export interface ExpiringRow extends BatchStock {
  productName: string;
  productId: string;
}

/**
 * Everything still on the shelf that is expired or heading that way.
 *
 * Sorted by expiry, soonest first, because that is the order the owner should
 * work through it — and expired stock sorts to the very top, where it is a
 * standing instruction rather than a statistic.
 */
export async function expiringStock(
  withinDays = EXPIRY_WARN_DAYS,
  today = businessDate(),
): Promise<ExpiringRow[]> {
  const [batches, movements, products] = await Promise.all([
    db.product_batches.toArray(),
    db.stock_movements.toArray(),
    db.products.toArray(),
  ]);
  const names = new Map(products.map((p) => [p.id, p.name]));

  const byProduct = new Map<string, StockMovement[]>();
  for (const m of movements) {
    if (!m.batch_id) continue;
    const list = byProduct.get(m.product_id) ?? [];
    list.push(m);
    byProduct.set(m.product_id, list);
  }

  const rows: ExpiringRow[] = [];
  for (const [productId, group] of groupBatches(batches)) {
    for (const row of batchStock(group, byProduct.get(productId) ?? [], today)) {
      // Zero-quantity batches are history, not a problem to act on.
      if (row.quantity <= 0.0001) continue;
      if (row.daysLeft > withinDays) continue;
      rows.push({ ...row, productId, productName: names.get(productId) ?? "Unknown product" });
    }
  }

  return rows.sort(
    (a, b) => a.daysLeft - b.daysLeft || a.productName.localeCompare(b.productName),
  );
}

function groupBatches(batches: ProductBatch[]): Map<string, ProductBatch[]> {
  const map = new Map<string, ProductBatch[]>();
  for (const b of batches) {
    const list = map.get(b.product_id) ?? [];
    list.push(b);
    map.set(b.product_id, list);
  }
  return map;
}

/**
 * Which sales touched a batch — the recall question.
 *
 * Answered from the movement ledger rather than a stored link, so it is exact
 * for anything the device still holds and needs no extra bookkeeping at sale
 * time.
 */
export async function salesOfBatch(batchId: string): Promise<
  Array<{ sale_id: string; quantity: number; created_at: string }>
> {
  const movements = await db.stock_movements.toArray();
  return movements
    .filter((m) => m.batch_id === batchId && m.sale_id && m.delta < 0)
    .map((m) => ({ sale_id: m.sale_id!, quantity: -m.delta, created_at: m.created_at }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
