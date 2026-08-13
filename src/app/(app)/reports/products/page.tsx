"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { buildPeriod, type PeriodKind } from "@/lib/reports";
import { productLines } from "@/lib/report-detail";
import { stockCard } from "@/lib/report-detail";
import { Button, Money, Notice } from "@/components/ui";
import { ReportHeader } from "@/components/report-header";
import { formatDay, money, qty, todayInNairobi } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/types";

/**
 * Every product: what was there, what sold, what is left, what it made.
 *
 * The summary screen shows a top ten, which answers "what sells" and not "did
 * this product earn its shelf space". This is the whole catalogue, and each row
 * opens into the movements behind it — so a number the owner disbelieves can be
 * taken apart rather than argued with.
 */
function ProductsReport() {
  const params = useSearchParams();
  const kind = (params.get("period") as PeriodKind) ?? "week";
  const end = params.get("end") ?? todayInNairobi();
  const period = buildPeriod(kind, end);

  const [open, setOpen] = useState<string | null>(null);
  const rows = useLiveQuery(async () => productLines(period), [kind, end]);

  if (!rows) return <div className="p-4 text-muted">Loading…</div>;

  const sold = rows.filter((r) => r.sold > 0 || r.revenue > 0);
  const idle = rows.filter((r) => r.sold <= 0 && r.revenue <= 0);
  const totals = {
    revenue: rows.reduce((t, r) => t + r.revenue, 0),
    profit: rows.reduce((t, r) => t + (r.profit ?? 0), 0),
    unknown: rows.some((r) => r.revenue > 0 && r.profit == null),
    stock: rows.reduce((t, r) => t + r.remainingValue, 0),
  };
  const broken = rows.filter((r) => Math.abs(r.discrepancy) > 0.001);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 lg:p-6">
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

      <ReportHeader title="Products" period={period.label} />

      <div className="print-plain grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card label="Sales" value={money(totals.revenue)} />
        <Card
          label="Profit"
          value={money(totals.profit)}
          hint={totals.unknown ? "some costs unknown" : undefined}
        />
        <Card label="Stock left, at cost" value={money(totals.stock)} />
      </div>

      {/* Should never fire. If it does, something wrote to products.quantity
          outside the movement ledger, and saying so beats quietly balancing. */}
      {broken.length > 0 && (
        <Notice tone="warn">
          {broken.length} product{broken.length === 1 ? "" : "s"} do not balance —
          opening plus received less sold and lost does not equal what is left. Tap the row to
          see the movements.
        </Notice>
      )}

      <Section
        title="Sold in this period"
        rows={sold}
        open={open}
        setOpen={setOpen}
        period={period}
      />
      {idle.length > 0 && (
        <Section
          title="Not sold"
          hint="Money sitting on the shelf."
          rows={idle}
          open={open}
          setOpen={setOpen}
          period={period}
        />
      )}

      <div className="no-print">
        <Button variant="neutral" onClick={() => window.print()} className="sm:w-40">
          Print
        </Button>
      </div>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="tabular text-2xl font-bold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Section({
  title,
  hint,
  rows,
  open,
  setOpen,
  period,
}: {
  title: string;
  hint?: string;
  rows: Awaited<ReturnType<typeof productLines>>;
  open: string | null;
  setOpen: (v: string | null) => void;
  period: ReturnType<typeof buildPeriod>;
}) {
  if (!rows.length) return null;
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-lg font-bold">{title}</h2>
      {hint && <p className="mb-2 text-sm text-muted">{hint}</p>}

      <ul className="flex flex-col divide-y divide-line border-t border-line">
        {rows.map((r) => (
          <li key={r.product_id}>
            <button
              onClick={() => setOpen(open === r.product_id ? null : r.product_id)}
              className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left"
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{r.name}</span>
                <span className="block text-sm text-muted">
                  {qty(r.opening)} at start · {qty(r.sold)} sold ·{" "}
                  <strong className="font-semibold text-ink">{qty(r.remaining)} left</strong>
                  {r.lost > 0 && <span className="text-danger"> · {qty(r.lost)} lost</span>}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <Money value={r.revenue} className="block font-bold" />
                <span className="block text-sm text-muted">
                  {r.profit == null ? (
                    "profit unknown"
                  ) : (
                    <>
                      {money(r.profit)} profit
                      {r.marginPct != null && ` · ${r.marginPct}%`}
                    </>
                  )}
                </span>
              </span>
            </button>

            {open === r.product_id && (
              <div className="pb-3">
                <Drill productId={r.product_id} period={period} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The movements behind one row — the drill-down. */
function Drill({
  productId,
  period,
}: {
  productId: string;
  period: ReturnType<typeof buildPeriod>;
}) {
  const card = useLiveQuery(async () => stockCard(productId, period), [productId, period.dates[0]]);
  if (!card) return <p className="px-1 text-sm text-muted">Loading…</p>;

  return (
    <div className="rounded-xl bg-panel p-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted">Opening</span>
        <span className="tabular font-semibold">{qty(card.opening)}</span>
      </div>

      {card.entries.length === 0 ? (
        <p className="py-2 text-sm text-muted">Nothing moved in this period.</p>
      ) : (
        <ul className="my-2 flex flex-col divide-y divide-line border-y border-line">
          {card.entries.map((e) => (
            <li key={e.movement.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0">
                <span className="block font-medium">{MOVEMENT_LABELS[e.movement.reason]}</span>
                <span className="block text-muted">
                  {formatDay(e.date)}
                  {e.saleTotal != null && ` · sale ${money(e.saleTotal)}`}
                  {e.movement.note && ` · ${e.movement.note}`}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={`tabular block font-semibold ${
                    e.movement.delta < 0 ? "text-danger" : "text-cash-dark"
                  }`}
                >
                  {e.movement.delta > 0 ? "+" : ""}
                  {qty(e.movement.delta)}
                </span>
                <span className="tabular block text-muted">{qty(e.balance)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted">Closing</span>
        <span className="tabular font-bold">{qty(card.closing)}</span>
      </div>

      <Link
        href={`/products/history?id=${productId}`}
        className="mt-2 inline-block text-sm text-brand-dark underline"
      >
        Full history for this product
      </Link>
    </div>
  );
}

export default function ProductsReportPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <ProductsReport />
    </Suspense>
  );
}
