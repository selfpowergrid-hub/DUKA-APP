"use client";

import { useState } from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { useLiveQuery } from "dexie-react-hooks";
import { buildReport, comparisonLabel, type PeriodKind } from "@/lib/reports";
import { chaseList, debtTotals, AGE_BUCKETS } from "@/lib/debt";
import { REFUND_REASONS } from "@/lib/types";
import { Button, Money, Notice } from "@/components/ui";
import { ReportHeader } from "@/components/report-header";
import { formatDay, money, qty, todayInNairobi } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/types";
import { useSession } from "@/components/session-provider";

/**
 * One screen, three periods, the same blocks throughout.
 *
 * Deliberately not a menu of twelve reports. The operator guidance is blunt
 * that "reports nobody owns are reports nobody reads", and the recommended
 * rhythm is five minutes daily, thirty weekly, an hour monthly. A shopkeeper
 * learns one layout and reads it at three zoom levels.
 *
 * No charts: the brief puts charts and dashboards out of scope.
 */

const PERIODS: Array<{ key: PeriodKind; label: string }> = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

export default function ReportsPage() {
  const [kind, setKind] = useState<PeriodKind>("week");
  const [endDate, setEndDate] = useState(todayInNairobi());
  const [shared, setShared] = useState<string | null>(null);
  const { session } = useSession();

  const report = useLiveQuery(() => buildReport(kind, endDate), [kind, endDate]);
  // The chase queue is deliberately NOT scoped to the report period: "who do
  // I ring this week" is a question about now, not about the last 30 days.
  const chase = useLiveQuery(async () => chaseList(), []);
  const dispensedCount = useLiveQuery(async () => db.dispensing_records.count(), []);
  const debt = useLiveQuery(
    async () => (report ? debtTotals(report.period.dates) : null),
    [report?.period.from, report?.period.to],
  );

  if (session && session.role !== "owner") {
    return (
      <div className="mx-auto w-full max-w-2xl p-4 lg:p-6">
        <h1 className="text-2xl font-bold">Reports</h1>
        <div className="mt-4">
          <Notice tone="warn">
            Only the shop owner can view trading reports, profit & loss, and margins. Cashiers are restricted to making sales and collecting payments.
          </Notice>
        </div>
      </div>
    );
  }

  if (!report) return <div className="p-4 text-muted">Loading…</div>;

  const { sales, previous, margin, varianceTotal } = report;
  const delta = sales.total - previous.total;
  const deltaPct = previous.total > 0 ? Math.round((delta / previous.total) * 100) : null;

  function summaryText(): string {
    const r = report!;
    const lines = [
      `${session?.shop_name ?? "Duka"} — ${r.period.label}`,
      r.period.kind === "day"
        ? formatDay(r.period.to)
        : `${formatDay(r.period.from)} to ${formatDay(r.period.to)}`,
      "",
      `Cash sales:   ${money(r.sales.cash)}`,
      `M-Pesa sales: ${money(r.sales.mpesa)}`,
      `On credit:    ${money(r.sales.credit)}`,
      `TOTAL SOLD:   ${money(r.sales.total)}`,
      "",
      `Money in:     ${money(r.received.total)}`,
      `Sales:        ${r.sales.count}  (average ${money(r.sales.average)})`,
      "",
      `vs ${comparisonLabel(r.period.kind)}: ${delta >= 0 ? "+" : ""}${money(delta)}`,
    ];
    if (r.varianceTotal.countedDays > 0) {
      lines.push(
        "",
        `Cash counted on ${r.varianceTotal.countedDays} day(s)`,
        `Expected ${money(r.varianceTotal.expected)}, counted ${money(r.varianceTotal.counted)}`,
        `Difference: ${money(r.varianceTotal.difference)}`,
      );
    }
    if (r.margin.knownLines > 0) {
      lines.push("", `Gross profit: ${money(r.margin.profit)} (${r.margin.marginPct}%)`);
      if (r.margin.unknownLines > 0) {
        lines.push(`(${r.margin.unknownLines} line(s) have no recorded cost)`);
      }
    }
    if (r.topByValue.length) {
      lines.push("", "Top sellers:");
      r.topByValue.slice(0, 5).forEach((p, i) =>
        lines.push(`  ${i + 1}. ${p.name}  ${money(p.revenue)}`),
      );
    }
    return lines.join("\n");
  }

  async function share() {
    const text = summaryText();
    try {
      if (navigator.share) {
        await navigator.share({ title: `Report ${report!.period.to}`, text });
        setShared(null);
      } else {
        await navigator.clipboard.writeText(text);
        setShared("Copied. Paste it into WhatsApp.");
      }
    } catch {
      setShared(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4 lg:p-6">
      <ReportHeader
        title="Reports"
        period={
          report.period.kind === "day"
            ? formatDay(report.period.to)
            : `${report.period.label} · ${formatDay(report.period.from)} to ${formatDay(report.period.to)}`
        }
      />

      <div className="no-print mb-4 flex flex-wrap items-baseline justify-end gap-3">
        <input
          type="date"
          value={endDate}
          max={todayInNairobi()}
          onChange={(e) => setEndDate(e.target.value || todayInNairobi())}
          className="no-print min-h-12 rounded-xl border border-line bg-surface px-4 text-base"
        />
      </div>

      <div className="no-print mb-4 grid grid-cols-3 gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setKind(p.key)}
            className={`min-h-12 rounded-xl border text-base font-semibold ${
              kind === p.key
                ? "border-brand bg-brand text-white"
                : "border-line bg-surface text-muted"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Navigation, so it sits where navigation belongs: above the summary
          rather than beneath a screenful of it. These are the only useful
          thing on the page for a shop with no trade yet, and they used to be
          the last thing you reached. Compact on purpose — enough to choose
          between, not a second summary. The chosen period travels with each
          link, so a drill-down never silently reports a different week from
          the one on screen. */}
      <div className="no-print mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <DetailLink
          href={`/reports/products?period=${kind}&end=${endDate}`}
          title="Products"
          hint="Sold, left, earned"
        />
        <DetailLink
          href={`/reports/stock?period=${kind}&end=${endDate}`}
          title="Stock ledger"
          hint="Opening to closing"
        />
        <DetailLink
          href={`/reports/trading?period=${kind}&end=${endDate}`}
          title="Profit & loss"
          hint="Down to net profit"
        />
        <DetailLink href="/expenses" title="Expenses" hint="Rent, wages, transport" />
        {/* Only for a shop that actually dispenses. A duka would never open
            this, and a permanent link to an empty register teaches people to
            ignore links. */}
        {dispensedCount !== undefined && dispensedCount > 0 && (
          <DetailLink
            href={`/reports/dispensing?period=${kind}&end=${endDate}`}
            title="Dispensing"
            hint="Prescriptions given"
          />
        )}
      </div>

      <div className="print-stack flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
        <div className="flex flex-col gap-4">
          {/* ------------------------------------------------------ sales --- */}
          {/* Three cards, not two. With credit missing, cash + M-Pesa visibly
              failed to reach the total below and the owner was left to work
              out where the rest went. Credit is styled flat and dashed on
              purpose: goods left, money did not, and it must never read like
              a third place money lives. */}
          <div className="print-plain grid grid-cols-2 gap-3 lg:grid-cols-3">
            <div className="rounded-2xl border-2 border-cash/30 bg-cash-soft p-4">
              <p className="text-sm font-semibold text-cash-dark">Cash sales</p>
              <p className="tabular text-2xl font-bold text-cash-dark lg:text-3xl">
                {money(sales.cash)}
              </p>
            </div>
            <div className="rounded-2xl border-2 border-mpesa/30 bg-mpesa-soft p-4">
              <p className="text-sm font-semibold text-mpesa-dark">M-Pesa sales</p>
              <p className="tabular text-2xl font-bold text-mpesa-dark lg:text-3xl">
                {money(sales.mpesa)}
              </p>
            </div>
            <div className="col-span-2 rounded-2xl border-2 border-dashed border-muted p-4 lg:col-span-1">
              <p className="text-sm font-semibold text-muted">On credit</p>
              <p className="tabular text-2xl font-bold text-muted lg:text-3xl">
                {money(sales.credit)}
              </p>
              <p className="mt-1 text-sm text-muted">
                {sales.credit > 0 ? "Goods gone, money not here yet." : "Nothing sold on credit."}
              </p>
            </div>
          </div>

          {/* The question the three cards above cannot answer: how much money
              actually arrived. A part-payment at the till and a debtor clearing
              an old book are both real money in the drawer, and neither is a
              sale in this period — so they belong here rather than being folded
              into "cash sales", which would stop that column meaning what it
              says. */}
          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-bold">Money actually received</h2>
              <span className="tabular text-2xl font-bold">{money(report.received.total)}</span>
            </div>
            <dl className="mt-2 flex flex-col gap-1 border-t border-line pt-2 text-sm">
              <Row label="Sales paid at the time" value={money(sales.cash + sales.mpesa)} />
              {report.received.fromDebtors > 0 && (
                <Row
                  label={
                    report.received.atTill > 0
                      ? `From debtors (${money(report.received.atTill)} of it at the till)`
                      : "From debtors"
                  }
                  value={money(report.received.fromDebtors)}
                />
              )}
              {report.received.refunded > 0 && (
                <Row label="less Refunds handed back" value={`-${money(report.received.refunded)}`} />
              )}
            </dl>
            <p className="mt-2 text-sm text-muted">
              Different from total sales, and both are right: sales counts goods that left,
              this counts money that arrived.
            </p>
          </div>

          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-sm text-muted">Total sales</p>
                <p className="tabular text-3xl font-bold">{money(sales.total)}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-muted">Sales</p>
                <p className="tabular text-3xl font-bold">{sales.count}</p>
              </div>
            </div>
            <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-base">
              <Row label="Average sale" value={<Money value={sales.average} />} />
              <Row
                label={`vs ${comparisonLabel(report.period.kind)}`}
                value={
                  previous.count === 0 ? (
                    <span className="text-muted">no data</span>
                  ) : (
                    <span
                      className={
                        delta > 0 ? "text-cash-dark" : delta < 0 ? "text-danger" : "text-muted"
                      }
                    >
                      {delta >= 0 ? "+" : ""}
                      {money(delta)}
                      {deltaPct !== null && ` (${delta >= 0 ? "+" : ""}${deltaPct}%)`}
                    </span>
                  )
                }
              />
              <Row label={`Was`} value={<Money value={previous.total} />} />
            </dl>
          </div>

          {/* --------------------------------------------------- variance --- */}
          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-lg font-bold">Cash variance</h2>
            <p className="mb-3 text-sm text-muted">
              Cash the sales say you should have, against what was counted. A single short day
              is noise; the same person short every week is not.
            </p>

            {varianceTotal.countedDays === 0 ? (
              <p className="py-4 text-center text-muted">
                No cash counts recorded in this period.
              </p>
            ) : (
              <>
                <div
                  className={`mb-3 flex items-center justify-between rounded-xl px-3 py-3 ${
                    varianceTotal.difference === 0
                      ? "bg-cash-soft"
                      : "bg-danger-soft"
                  }`}
                >
                  <span className="font-semibold">
                    Over {varianceTotal.countedDays} counted day
                    {varianceTotal.countedDays === 1 ? "" : "s"}
                  </span>
                  <span
                    className={`tabular text-2xl font-bold ${
                      varianceTotal.difference === 0 ? "text-cash-dark" : "text-danger"
                    }`}
                  >
                    {money(varianceTotal.difference)}
                  </span>
                </div>

                <ul className="flex flex-col divide-y divide-line">
                  {report.variance
                    .filter((v) => v.counted != null || v.expectedCash > 0)
                    .map((v) => (
                      <li key={v.date} className="flex items-center justify-between gap-2 py-2">
                        <span className="text-sm">{formatDay(v.date)}</span>
                        <span className="flex items-center gap-3 text-sm">
                          <span className="tabular text-muted">{money(v.expectedCash)}</span>
                          <span
                            className={`tabular w-24 text-right font-bold ${
                              v.difference == null
                                ? "text-muted"
                                : v.difference === 0
                                  ? "text-cash-dark"
                                  : "text-danger"
                            }`}
                          >
                            {v.difference == null ? "not counted" : money(v.difference)}
                          </span>
                        </span>
                      </li>
                    ))}
                </ul>
              </>
            )}
          </div>

          {/* ------------------------------------------------- attendants --- */}
          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-lg font-bold">By attendant</h2>
            <p className="mb-3 text-sm text-muted">
              Who rang up what. The drawer is counted once a day, not per person, so this shows
              who was selling — not who is responsible for a shortfall.
            </p>
            {report.attendants.length === 0 ? (
              <p className="py-4 text-center text-muted">No sales in this period.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {report.attendants.map((a) => (
                  <li key={a.user_id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{a.name}</span>
                      <span className="text-sm text-muted">
                        {a.count} sale{a.count === 1 ? "" : "s"} · cash{" "}
                        <Money value={a.cash} />
                      </span>
                    </span>
                    <Money value={a.total} className="shrink-0 font-bold" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ------------------------------------------ second column (lg) --- */}
        <div className="flex flex-col gap-4">
          {/* ----------------------------------------------------- margin --- */}
          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-lg font-bold">Gross profit</h2>
            {margin.knownLines === 0 ? (
              <p className="py-4 text-center text-muted">
                No sales with a recorded cost in this period.
              </p>
            ) : (
              <>
                <p className="tabular mt-1 text-3xl font-bold">{money(margin.profit)}</p>
                <p className="text-sm text-muted">
                  {money(margin.revenue)} {margin.unknownLines > 0 ? "of priced sales" : "sold"} −{" "}
                  {money(margin.cost)} cost · <strong>{margin.marginPct}% margin</strong>
                </p>
              </>
            )}
            {margin.unknownLines > 0 && (
              <div className="mt-3">
                <Notice tone="warn">
                  {margin.unknownLines === 1
                    ? "1 sale line in this period has"
                    : `${margin.unknownLines} sale lines in this period have`}{" "}
                  no recorded cost, and {margin.unknownLines === 1 ? "is" : "are"} left out of the
                  figures above. Cost is only captured on sales made from now on — it cannot be
                  worked out for older ones.
                </Notice>
              </div>
            )}
          </div>

          {/* ------------------------------------------------ top sellers --- */}
          {report.period.kind !== "day" && (
            <div className="print-plain rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-lg font-bold">Top sellers</h2>
              <p className="mb-2 text-sm text-muted">By money taken.</p>
              {report.topByValue.length === 0 ? (
                <p className="py-4 text-center text-muted">Nothing sold in this period.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {report.topByValue.map((p, i) => (
                    <li key={p.product_id} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">
                          {i + 1}. {p.name}
                        </span>
                        <span className="tabular text-sm text-muted">
                          {qty(p.quantity)} sold
                          {p.profit != null && (
                            <>
                              {" · "}
                              profit <Money value={p.profit} />
                            </>
                          )}
                        </span>
                      </span>
                      <Money value={p.revenue} className="shrink-0 font-bold" />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ------------------------------------------------ slow movers --- */}
          {report.period.kind !== "day" && (
            <div className="print-plain rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-lg font-bold">Not sold at all</h2>
              <p className="mb-2 text-sm text-muted">
                Stock that did not move in this period — money sitting on the shelf.
              </p>
              {report.slowMovers.length === 0 ? (
                <p className="py-4 text-center text-cash-dark">Everything sold at least once.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {report.slowMovers.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 truncate">{p.name}</span>
                      <span className="tabular shrink-0 text-sm text-muted">
                        {qty(p.quantity)} {p.unit} ·{" "}
                        <Money value={p.quantity * p.buying_price} className="font-semibold" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* -------------------------------------------- stock movement --- */}
          {report.period.kind !== "day" && (
            <div className="print-plain rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-lg font-bold">Stock movement</h2>
              <p className="mb-2 text-sm text-muted">
                Everything that changed the count, and what it was worth at cost.
              </p>
              {report.movements.length === 0 ? (
                <p className="py-4 text-center text-muted">No stock moved in this period.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {report.movements.map((m) => (
                    <li key={m.reason} className="flex items-center justify-between gap-2 py-2">
                      <span>{MOVEMENT_LABELS[m.reason]}</span>
                      <span className="flex items-center gap-3">
                        <span className="tabular text-sm text-muted">
                          {m.quantity > 0 ? "+" : ""}
                          {qty(m.quantity)}
                        </span>
                        <span
                          className={`tabular w-24 text-right font-semibold ${
                            m.value < 0 ? "text-danger" : "text-ink"
                          }`}
                        >
                          {money(m.value)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ------------------------------------------------ stock value --- */}
          {report.period.kind === "month" && (
            <div className="print-plain rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-lg font-bold">Stock on hand today</h2>
              <p className="mb-2 text-sm text-muted">
                A snapshot of right now, not of the period.
              </p>
              <dl className="flex flex-col gap-1">
                <Row label="Value at cost" value={<Money value={report.stock.atCost} />} />
                <Row label="Value at selling price" value={<Money value={report.stock.atRetail} />} />
                <Row label="Products stocked" value={<span>{report.stock.items}</span>} />
              </dl>
            </div>
          )}

          {/* Debt: exposure first, then the flow for this period. */}
          {debt && (debt.outstanding > 0 || debt.chargedInPeriod > 0) && (
            <div className="print-plain rounded-2xl border border-line bg-surface p-4">
              <h2 className="text-lg font-bold">Money owed to the shop</h2>
              <p className="tabular mt-1 text-3xl font-bold">{money(debt.outstanding)}</p>
              <p className="text-sm text-muted">
                across {debt.customers} {debt.customers === 1 ? "person" : "people"}
              </p>

              <ul className="mt-3 flex flex-col divide-y divide-line border-t border-line">
                {AGE_BUCKETS.map((b) => {
                  const row = debt.byBucket[b.key];
                  if (row.amount <= 0) return null;
                  return (
                    <li key={b.key} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{b.label}</span>
                        <span className="text-sm text-muted">{b.action}</span>
                      </span>
                      <span
                        className={`tabular shrink-0 font-bold ${
                          b.key === "at_risk" || b.key === "chase" ? "text-danger" : "text-ink"
                        }`}
                      >
                        {money(row.amount)}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">New credit given this period</dt>
                  <dd className="tabular">{money(debt.chargedInPeriod)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Repaid in cash</dt>
                  <dd className="tabular text-cash-dark">{money(debt.repaidCash)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted">Repaid by M-Pesa</dt>
                  <dd className="tabular text-mpesa-dark">{money(debt.repaidMpesa)}</dd>
                </div>
                {debt.writtenOff > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted">Written off</dt>
                    <dd className="tabular text-danger">{money(debt.writtenOff)}</dd>
                  </div>
                )}
              </dl>

              {/* A report that only shows totals leaves the owner knowing they
                  have a problem and not what to do on Monday. These are the
                  names, in the order to work through them — a broken promise
                  first, because it is the strongest signal there is that this
                  debt is going bad and the moment to stop adding to it. */}
              {chase && chase.due.length > 0 && (
                <div className="mt-4 border-t border-line pt-3">
                  <h3 className="font-bold">Chase these first</h3>
                  <p className="mb-2 text-sm text-muted">
                    {chase.due.length} of {chase.due.length + chase.later.length}{" "}
                    {chase.due.length + chase.later.length === 1 ? "debtor" : "debtors"} need
                    something from you now.
                  </p>
                  <ul className="flex flex-col divide-y divide-line border-t border-line">
                    {chase.due.slice(0, 8).map((d) => (
                      <li
                        key={d.customer.id}
                        className="flex items-center justify-between gap-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">
                            {d.customer.name}
                          </span>
                          <span
                            className={`block text-sm ${
                              d.chase.promiseBroken ? "font-semibold text-danger" : "text-muted"
                            }`}
                          >
                            {d.chase.reason}
                          </span>
                        </span>
                        <span className="tabular shrink-0 font-bold">{money(d.balance)}</span>
                      </li>
                    ))}
                  </ul>
                  {chase.due.length > 8 && (
                    <p className="mt-2 text-sm text-muted">
                      …and {chase.due.length - 8} more on the Debts screen.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* The exception report the app could not produce until sales became
              reversible. Shown whenever there is anything to show, including a
              clean zero after the first refund of the period — a refund rate
              you never look at is a refund rate nobody is controlling. */}
          {report.refunds.count > 0 && (
            <div className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-bold">Refunds</h2>
                <span className="tabular text-sm text-muted">
                  {report.refunds.pctOfSales}% of sales
                </span>
              </div>
              <p className="tabular mt-1 text-3xl font-bold text-danger">
                -{money(report.refunds.total)}
              </p>
              <p className="text-sm text-muted">
                {report.refunds.count} {report.refunds.count === 1 ? "sale" : "sales"} reversed
                {report.refunds.cash > 0 && ` · ${money(report.refunds.cash)} handed back in cash`}
              </p>

              <ul className="mt-3 flex flex-col divide-y divide-line border-t border-line">
                {report.refunds.byReason.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">
                        {REFUND_REASONS.find((x) => x.key === r.reason)?.label ?? r.reason}
                      </span>
                      <span className="text-sm text-muted">
                        {r.count} {r.count === 1 ? "time" : "times"}
                      </span>
                    </span>
                    <span className="tabular shrink-0 font-bold">{money(r.amount)}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-sm text-muted">
                Only the owner can reverse a sale, so every one of these carries your name. What
                is worth watching is the shape over time: a climbing count on one reason is a
                pattern, and a single refund is not.
              </p>
            </div>
          )}

          {report.unsynced > 0 && (
            <Notice tone="warn">
              {report.unsynced} sale{report.unsynced === 1 ? "" : "s"} in this period have not
              synced from this device yet. These figures include them; another device will not
              see them until this phone is online.
            </Notice>
          )}

          {shared && <Notice tone="cash">{shared}</Notice>}

          <div className="no-print grid grid-cols-2 gap-3">
            <Button variant="neutral" onClick={() => window.print()}>
              Print
            </Button>
            <Button onClick={share}>Share summary</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular font-semibold">{value}</dd>
    </div>
  );
}

/**
 * One report link.
 *
 * Sized to be chosen between at a glance rather than read: the title carries
 * the meaning and the hint is a reminder, not a description. Five of these have
 * to fit above the summary without becoming a screenful of their own.
 */
function DetailLink({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-16 flex-col justify-center rounded-xl border border-line bg-panel px-3 py-2 transition-colors lg:hover:border-brand lg:hover:bg-brand-soft"
    >
      <span className="flex items-center justify-between gap-1">
        <span className="truncate font-semibold">{title}</span>
        <span className="shrink-0 text-brand-dark">›</span>
      </span>
      <span className="block truncate text-sm text-muted">{hint}</span>
    </Link>
  );
}
