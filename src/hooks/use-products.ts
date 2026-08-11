"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { applyDeltas, pendingDeltas } from "@/lib/store";
import type { Product } from "@/lib/types";

/**
 * Products with stock adjusted for anything still sitting in the outbox.
 * Live: any local write re-renders every screen showing stock, instantly.
 */
export function useProducts(opts: { activeOnly?: boolean } = {}): Product[] | undefined {
  const { activeOnly = true } = opts;

  return useLiveQuery(async () => {
    const rows = await db.products.toArray();
    const deltas = await pendingDeltas();
    const adjusted = applyDeltas(rows, deltas);
    // Sealed pack sizes of the same thing sit together — "Rina 1L / 5L / 10L"
    // scattered across the grid reads as three unrelated products.
    return adjusted
      .filter((p) => (activeOnly ? p.is_active : true))
      .sort(
        (a, b) =>
          (a.group_name ?? a.name).localeCompare(b.group_name ?? b.name) ||
          a.name.localeCompare(b.name),
      );
  }, [activeOnly]);
}

export function useProduct(id: string | undefined): Product | undefined {
  return useLiveQuery(async () => (id ? db.products.get(id) : undefined), [id]);
}

/**
 * Untracked products never count as low. Airtime has no shelf, so nagging that
 * it has "run out" is noise the attendant learns to ignore — and an alert
 * people ignore is worse than no alert.
 */
export function isLowStock(p: Product): boolean {
  if (p.track_stock === false) return false;
  return p.quantity <= p.low_stock_threshold;
}
