"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { FALLBACK_UNITS, type ProductPortion, type Unit } from "@/lib/types";

export function useUnits(): Unit[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.units.toArray();
      if (rows.length) return rows.sort((a, b) => a.sort_order - b.sort_order);
      // Before the first sync, offer something rather than an empty picker.
      return FALLBACK_UNITS.map((code, i) => ({
        id: `fallback-${code}`,
        shop_id: "",
        code,
        label: code,
        is_fractional: code === "kg" || code === "litre",
        sort_order: i,
      }));
    }, []) ?? []
  );
}

export function usePortions(productId: string | undefined): ProductPortion[] {
  return (
    useLiveQuery(async () => {
      if (!productId) return [];
      const rows = await db.portions.where("product_id").equals(productId).toArray();
      return rows.sort((a, b) => a.sort_order - b.sort_order);
    }, [productId]) ?? []
  );
}

/** All portions, keyed by product — the Sell grid needs them in one read. */
export function usePortionsByProduct(): Map<string, ProductPortion[]> {
  const rows = useLiveQuery(async () => db.portions.toArray(), []) ?? [];
  const map = new Map<string, ProductPortion[]>();
  for (const p of rows) {
    const list = map.get(p.product_id) ?? [];
    list.push(p);
    map.set(p.product_id, list);
  }
  map.forEach((list) => list.sort((a, b) => a.sort_order - b.sort_order));
  return map;
}

/** Existing group names, for the datalist on the product form. */
export function useGroupNames(): string[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.products.toArray();
      return [...new Set(rows.map((p) => p.group_name).filter((g): g is string => Boolean(g)))].sort();
    }, []) ?? []
  );
}
