"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import type { Category } from "@/lib/types";

export function useCategories(): Category[] {
  return (
    useLiveQuery(async () => {
      const rows = await db.categories.toArray();
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    }, []) ?? []
  );
}

/** Category id -> name, for labelling product rows without a second query. */
export function useCategoryNames(): Map<string, string> {
  const categories = useCategories();
  return new Map(categories.map((c) => [c.id, c.name]));
}
