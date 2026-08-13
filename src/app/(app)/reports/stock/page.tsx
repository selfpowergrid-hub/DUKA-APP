"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { buildPeriod, type PeriodKind } from "@/lib/reports";
import { productLines, stockCard } from "@/lib/report-detail";
import { Button, Input, Money } from "@/components/ui";
import { ReportHeader } from "@/components/report-header";
import { formatClock, formatDay, money, qty, todayInNairobi } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/types";

/**
 * The stock card: opening balance, every movement, closing balance.
 *
 * This is the screen that settles "the shelf says 14 and the app says 20". Not
 * with a total — with every event between the two, in order, with a running
 * balance, so the owner can point at the line where they diverged rather than
 * arguing with a number.
 *
 * Same reasoning as the customer ledger showing a running balance instead of
 * just what is owed: a figure you cannot take apart is a figure you cannot act
 * on.
 */
function StockLedger() {
  const params = useSearchParams();
  const kind = (params.get("period") as PeriodKind) ?? "week";
  const end = params.get("end") ?? todayInNairobi();
  const period = buildPeriod(kind, end);

  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(params.get("id"));

  const lines = useLiveQuery(async () => productLines(period), [kind, end]);
  const card = useLiveQuery(
    async () => (picked ? stockCard(picked, period) : null),
    [picked, kind, end],
  );

  if (!lines) return <div className="p-4 text-muted">Loading…</div>;

  const q = search.trim().toLowerCase();
  const matches = lines.filter((l) => !q || l.name.toLowerCase().includes(q));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 lg:p-6">
      {/* The back link sits ABOVE the letterhead rather than beside it: the
          letterhead has to span the page and survive printing, and this does
          not print at all. */}
      <div className="no-print">
        {/* inline-block on the anchor itself: an inline <a> collapses to the
            line height, so the tap target was 21px even though the button
            inside it was 48. It used to be stretched by a flex parent. */}
        <Link href="/reports" className="inline-block">
          <Button variant="ghost" className="min-h-12 px-0">
            ← Back to reports
          </Button>
        </Link>
      </div>

      <ReportHeader title="Stock ledger" period={period.label} />

      {!picked ? (
        <>
          <p className="text-sm text-muted">
            Pick a product to see everything that changed its count in this period, from opening
            to closing.
          </p>
          <Input
            placeholder="Search products"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            inputMode="search"
          />
          <ul className="flex flex-col gap-2">
            {matches.map((l) => (
              <li key={l.product_id}>
                <button
                  onClick={() => setPicked(l.product_id)}
                  className="flex min-h-16 w-full items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left lg:hover:border-brand"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{l.name}</span>
                    <span className="block text-sm text-muted">
                      {qty(l.opening)} → {qty(l.remaining)} {l.unit}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-sm text-muted">
                    {qty(l.sold)} sold
                    {l.lost > 0 && (
                      <span className="block text-danger">{qty(l.lost)} lost</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="rounded-2xl bg-panel px-4 py-6 text-center text-muted">
                Nothing matches that.
              </li>
            )}
          </ul>
        </>
      ) : !card ? (
        <div className="p-4 text-muted">Loading…</div>
      ) : (
        <>
          <div className="no-print">
            <Button variant="ghost" className="min-h-12" onClick={() => setPicked(null)}>
              ← Choose another product
            </Button>
          </div>

          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-lg font-bold">{card.product.name}</h2>
            <p className="text-sm text-muted">{period.label}</p>

            <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
              <span className="font-semibold">Opening balance</span>
              <span className="tabular text-lg font-bold">
                {qty(card.opening)} {card.product.unit}
              </span>
            </div>

            {card.entries.length === 0 ? (
              <p className="py-6 text-center text-muted">Nothing moved in this period.</p>
            ) : (
              <ul className="my-2 flex flex-col divide-y divide-line border-y border-line">
                {card.entries.map((e) => (
                  <li
                    key={e.movement.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">
                        {MOVEMENT_LABELS[e.movement.reason]}
                      </span>
                      <span className="block text-sm text-muted">
                        {formatDay(e.date)} · {formatClock(e.movement.created_at)}
                        {e.saleTotal != null && ` · sale ${money(e.saleTotal)}`}
                        {e.movement.note_ref && ` · ${e.movement.note_ref}`}
                        {e.movement.note && ` · ${e.movement.note}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span
                        className={`tabular block font-bold ${
                          e.movement.delta < 0 ? "text-danger" : "text-cash-dark"
                        }`}
                      >
                        {e.movement.delta > 0 ? "+" : ""}
                        {qty(e.movement.delta)}
                      </span>
                      <span className="tabular block text-sm text-muted">
                        balance {qty(e.balance)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="font-semibold">Closing balance</span>
              <span className="tabular text-2xl font-bold">
                {qty(card.closing)} {card.product.unit}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between text-sm text-muted">
              <span>Worth, at cost</span>
              <Money value={Math.max(0, card.closing) * card.product.buying_price} />
            </div>
          </div>

          <div className="no-print flex flex-col gap-2 sm:flex-row">
            <Button variant="neutral" onClick={() => window.print()} className="sm:w-40">
              Print
            </Button>
            <Link href={`/products/history?id=${card.product.id}`} className="sm:w-56">
              <Button variant="neutral" className="w-full">
                Full history, all time
              </Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

export default function StockLedgerPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <StockLedger />
    </Suspense>
  );
}
