"use client";

import Link from "next/link";
import { useProducts, isLowStock } from "@/hooks/use-products";
import { Button, Money } from "@/components/ui";
import { qty } from "@/lib/format";

export default function LowStockPage() {
  const products = useProducts();
  const low = (products ?? []).filter(isLowStock).sort((a, b) => a.quantity - b.quantity);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-2xl font-bold lg:text-3xl">Low stock</h1>

      {low.length === 0 ? (
        <p className="rounded-2xl bg-cash-soft px-4 py-6 text-center font-semibold text-cash-dark">
          Everything is above its threshold.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {low.map((p) => (
            <li
              key={p.id}
              className="flex min-h-16 items-center justify-between rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate font-semibold">{p.name}</div>
                <div className="text-sm text-muted">
                  alert at {qty(p.low_stock_threshold)} · <Money value={p.selling_price} />
                </div>
              </div>
              <div className="tabular shrink-0 text-xl font-bold text-danger">
                {qty(p.quantity)}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Link href="/products/restock" className="sm:w-48">
          <Button size="lg" className="w-full">
            Restock now
          </Button>
        </Link>
        <Link href="/products" className="sm:w-48">
          <Button variant="ghost" className="w-full">
            Back to products
          </Button>
        </Link>
      </div>
    </div>
  );
}
