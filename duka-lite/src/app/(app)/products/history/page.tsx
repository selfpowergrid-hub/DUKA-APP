"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { useProduct } from "@/hooks/use-products";
import { Button, Money } from "@/components/ui";
import { formatDay, formatClock, money, qty } from "@/lib/format";
import { MOVEMENT_LABELS, type MovementReason } from "@/lib/types";

/**
 * Why is this number what it is?
 *
 * Every sale, restock and adjustment has always written to `stock_movements`,
 * and until now nothing ever showed it. An owner looking at "14 in stock" and
 * believing it should be 20 had no way to find out what happened — the data
 * was right there and simply never rendered.
 *
 * This also makes the adjustment feature trustworthy: a recount stops being a
 * number that silently changed and becomes an entry with a person, a time and
 * a reason attached to it.
 *
 * Static route with a query string, not `/products/[id]/history`, for the same
 * reason the edit screen is: a dynamic segment cannot be precached, so it
 * would fail with no internet.
 */

const REASON_TONE: Record<MovementReason, string> = {
  opening: "text-muted",
  restock: "text-cash-dark",
  sale: "text-ink",
  adjustment: "text-brand-dark",
  damage: "text-danger",
  loss: "text-danger",
};

function StockHistory() {
  const id = useSearchParams().get("id") ?? undefined;
  const product = useProduct(id);

  const rows = useLiveQuery(async () => {
    if (!id) return [];
    const [moves, staff] = await Promise.all([
      db.stock_movements.where("product_id").equals(id).toArray(),
      db.staff.toArray(),
    ]);
    // Newest first for reading, but the running balance has to be accumulated
    // oldest-first — so compute forwards, then reverse.
    const oldestFirst = [...moves].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
    let running = 0;
    const withBalance = oldestFirst.map((m) => {
      running = Math.round((running + m.delta) * 1000) / 1000;
      return {
        ...m,
        balance: running,
        who: staff.find((u) => u.id === m.user_id)?.full_name?.trim() ?? null,
      };
    });
    return withBalance.reverse();
  }, [id]);

  if (!id) return <div className="p-4 text-muted">No product selected.</div>;
  if (product === undefined || rows === undefined)
    return <div className="p-4 text-muted">Loading…</div>;
  if (product === null) return <div className="p-4 text-muted">Product not found.</div>;

  // The ledger's own total, computed independently of products.quantity. If
  // the two disagree it is because this device has not pulled every movement
  // (only the last 62 days are kept locally), not because stock is wrong.
  const ledgerTotal = rows.length ? rows[0].balance : 0;
  const matchesLedger = Math.abs(ledgerTotal - product.quantity) < 0.001;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold lg:text-3xl">{product.name}</h1>
        <p className="mt-1 text-sm text-muted">Stock history</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <p className="text-sm text-muted">In stock now</p>
          <p className="tabular text-3xl font-bold">
            {qty(product.quantity)} <span className="text-lg font-normal">{product.unit}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted">Average cost</p>
          <p className="tabular text-xl font-semibold">
            <Money value={product.buying_price} />
          </p>
          <p className="text-xs text-muted">
            worth <Money value={product.quantity * product.buying_price} />
          </p>
        </div>
      </div>

      {!matchesLedger && rows.length > 0 && (
        <p className="rounded-xl bg-panel px-4 py-3 text-sm text-muted">
          This device holds the last 62 days of movements, so the running total below starts
          part-way through. The figure above is the shop&apos;s true count.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="py-10 text-center text-muted">
          No stock movements recorded on this device yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface px-4">
          {rows.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className={`font-semibold ${REASON_TONE[m.reason]}`}>
                  {MOVEMENT_LABELS[m.reason]}
                </p>
                <p className="text-sm text-muted">
                  {formatDay(m.created_at.slice(0, 10))} · {formatClock(m.created_at)}
                  {m.who && ` · ${m.who}`}
                </p>
                {(m.note || m.note_ref) && (
                  <p className="truncate text-sm text-muted">
                    {[m.note, m.note_ref].filter(Boolean).join(" · ")}
                  </p>
                )}
                {m.reason === "restock" && m.buying_price != null && (
                  <p className="text-sm text-muted">
                    paid {money(m.buying_price)} / {product.unit}
                    {m.total_cost != null && ` · ${money(m.total_cost)} total`}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={`tabular text-lg font-bold ${
                    m.delta > 0 ? "text-cash-dark" : "text-danger"
                  }`}
                >
                  {m.delta > 0 ? "+" : ""}
                  {qty(m.delta)}
                </p>
                <p className="tabular text-xs text-muted">{qty(m.balance)} after</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href={`/products/adjust`} className="sm:w-48">
          <Button variant="neutral" className="w-full">
            Adjust stock
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

export default function StockHistoryPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <StockHistory />
    </Suspense>
  );
}
