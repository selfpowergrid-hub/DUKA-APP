"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { buildPeriod, type PeriodKind } from "@/lib/reports";
import { productLines, tradingAccount } from "@/lib/report-detail";
import { Button, Notice } from "@/components/ui";
import { money, qty, todayInNairobi } from "@/lib/format";

/**
 * The trading account.
 *
 * Deliberately not titled "profit and loss". A P&L ends in net profit after
 * rent, salaries, electricity and licences — none of which this app records.
 * Inventing them would be worse than omitting them, and a bottom line the owner
 * half-trusts is more dangerous than one they know the limits of. Every figure
 * below is measured from records the shop already keeps.
 *
 * Each line opens into what it is made of, because a total nobody can take
 * apart is a total nobody acts on.
 */
function TradingReport() {
  const params = useSearchParams();
  const kind = (params.get("period") as PeriodKind) ?? "week";
  const end = params.get("end") ?? todayInNairobi();
  const period = buildPeriod(kind, end);

  const [open, setOpen] = useState<string | null>(null);
  const acc = useLiveQuery(async () => tradingAccount(period), [kind, end]);
  const lines = useLiveQuery(async () => productLines(period), [kind, end]);

  if (!acc || !lines) return <div className="p-4 text-muted">Loading…</div>;

  const contributors = lines
    .filter((l) => l.revenue > 0)
    .sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));
  const losers = lines.filter((l) => l.lost > 0);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div className="no-print flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold lg:text-3xl">Trading account</h1>
          <p className="text-sm text-muted">{period.label}</p>
        </div>
        <Link href="/reports">
          <Button variant="ghost" className="min-h-12">
            Back to reports
          </Button>
        </Link>
      </div>

      <div className="print-plain rounded-2xl border border-line bg-surface p-4">
        <Row label="Sales" value={acc.sales} />
        {acc.refunds > 0 && <Row label="less Refunds" value={-acc.refunds} muted />}
        <Row label="Net sales" value={acc.netSales} rule />

        <Row
          label="less Cost of goods sold"
          value={-acc.costOfGoods}
          muted
          onClick={() => setOpen(open === "cogs" ? null : "cogs")}
          expanded={open === "cogs"}
        />
        {open === "cogs" && (
          <Detail>
            <p className="mb-2 text-sm text-muted">
              What the goods sold in this period cost the shop, taken from the price recorded at
              the moment of each sale — not today&apos;s price.
            </p>
            <ul className="flex flex-col divide-y divide-line">
              {contributors.map((l) => (
                <li key={l.product_id} className="flex justify-between gap-2 py-1.5 text-sm">
                  <span className="min-w-0 truncate">{l.name}</span>
                  <span className="tabular shrink-0">
                    {l.cost == null ? (
                      <span className="text-warn">not recorded</span>
                    ) : (
                      money(l.cost)
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Detail>
        )}

        <Row label="GROSS PROFIT" value={acc.grossProfit} strong rule
             suffix={`${acc.grossMarginPct}%`} />

        <div className="mt-2">
          <Row
            label="less Damaged / lost stock"
            value={-acc.stockLosses}
            muted
            onClick={() => setOpen(open === "loss" ? null : "loss")}
            expanded={open === "loss"}
          />
          {open === "loss" && (
            <Detail>
              <p className="mb-2 text-sm text-muted">
                Valued at what the shop paid, not at what it would have sold for. Marking a loss up
                to retail overstates it — the shop is out its cost.
              </p>
              {losers.length === 0 ? (
                <p className="text-sm text-muted">Nothing lost in this period.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {losers.map((l) => (
                    <li key={l.product_id} className="flex justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 truncate">{l.name}</span>
                      <span className="tabular shrink-0">
                        {qty(l.lost)} {l.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Detail>
          )}

          <Row label="less Bad debts written off" value={-acc.badDebt} muted />
        </div>

        <Row label="TRADING PROFIT" value={acc.tradingProfit} strong rule big />
      </div>

      {/* The honesty that makes the number usable rather than misleading. */}
      <Notice tone="warn">
        This is not a full profit and loss account. Rent, salaries, electricity, licences and
        other running costs are not recorded anywhere in this app, so they are not in the figure
        above. What it does show is measured, not estimated.
      </Notice>

      {acc.unpricedLines > 0 && (
        <Notice tone="warn">
          {acc.unpricedLines} product{acc.unpricedLines === 1 ? " has" : "s have"} sales with no
          recorded cost, so their profit is left out rather than counted as free. Cost is captured
          from the moment a buying price is recorded — it cannot be worked out backwards.
        </Notice>
      )}

      <div className="rounded-2xl border border-line bg-panel p-4">
        <div className="flex items-baseline justify-between">
          <span className="font-semibold">Stock on hand at the end</span>
          <span className="tabular text-lg font-bold">{money(acc.closingStockValue)}</span>
        </div>
        <p className="mt-1 text-sm text-muted">
          At cost. This is not profit — it is money the shop is holding as goods rather than cash.
        </p>
      </div>

      <div className="no-print flex flex-col gap-2 sm:flex-row">
        <Button variant="neutral" onClick={() => window.print()} className="sm:w-40">
          Print
        </Button>
        <Link href={`/reports/products?period=${kind}&end=${end}`} className="sm:w-56">
          <Button variant="neutral" className="w-full">
            See it product by product
          </Button>
        </Link>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
  rule,
  big,
  suffix,
  onClick,
  expanded,
}: {
  label: string;
  value: number;
  strong?: boolean;
  muted?: boolean;
  rule?: boolean;
  big?: boolean;
  suffix?: string;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const body = (
    <>
      <span className={`min-w-0 ${muted ? "text-muted" : ""}`}>
        {label}
        {onClick && (
          <span className="ml-1 text-xs text-brand-dark">{expanded ? "▲" : "▼"}</span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span
          className={`tabular ${big ? "text-2xl" : ""} ${strong ? "font-bold" : ""} ${
            value < 0 ? "text-danger" : ""
          }`}
        >
          {money(value)}
        </span>
        {suffix && <span className="ml-2 text-sm text-muted">{suffix}</span>}
      </span>
    </>
  );

  const cls = `flex items-baseline justify-between gap-3 py-2 ${
    rule ? "border-t border-line" : ""
  } ${strong ? "font-bold" : ""}`;

  return onClick ? (
    <button onClick={onClick} className={`${cls} min-h-12 w-full text-left`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Detail({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 rounded-xl bg-panel p-3">{children}</div>;
}

export default function TradingReportPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <TradingReport />
    </Suspense>
  );
}
