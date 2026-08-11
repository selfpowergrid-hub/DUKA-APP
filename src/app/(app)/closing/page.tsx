"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, META_KEYS } from "@/lib/db";
import { dayTotals, saveCashCount } from "@/lib/store";
import { Button, Input, Money, Notice, PaymentTag } from "@/components/ui";
import { RefundSheet } from "@/components/refund-sheet";
import Link from "next/link";
import { EXPENSE_CATEGORIES } from "@/lib/types";
import { formatClock, formatDay, money, todayInNairobi } from "@/lib/format";
import { useSession } from "@/components/session-provider";

export default function ClosingPage() {
  const [date, setDate] = useState(todayInNairobi());
  // `draft` carries the date it belongs to, so switching days falls back to the
  // stored count with no effect and no stale value from the previous day.
  const [draft, setDraft] = useState<{ date: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [showSales, setShowSales] = useState(false);
  const { session } = useSession();
  const isOwner = session?.role === "owner";

  const totals = useLiveQuery(() => dayTotals(date), [date]);
  // The day's sales, so a mis-key can be reversed from the screen where it is
  // actually noticed: the drawer disagrees and the owner comes looking here.
  const daySales = useLiveQuery(
    async () =>
      (await db.sales.where("business_date").equals(date).toArray()).sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    [date],
  );
  const refundedIds = useLiveQuery(
    async () => new Set((await db.refunds.toArray()).map((r) => r.sale_id)),
    [],
  );
  const skew = useLiveQuery(
    async () => (await db.meta.get(META_KEYS.clockSkewMs))?.value as number | undefined,
    [],
  );

  if (!totals) return <div className="p-4 text-muted">Loading…</div>;

  const stored = totals.cashCount;
  const counted =
    draft && draft.date === date ? draft.value : stored ? String(stored.counted_amount) : "";

  const countedNum = counted === "" ? null : Number(counted);
  const difference = countedNum === null ? null : countedNum - totals.expectedCash;
  const paidAtTill = totals.paidAtTillCash + totals.paidAtTillMpesa;
  const isToday = date === todayInNairobi();
  const saved = stored != null && countedNum === stored.counted_amount;

  async function save() {
    setError(null);
    try {
      if (countedNum === null || Number.isNaN(countedNum)) {
        throw new Error("Enter the cash you counted");
      }
      await saveCashCount(date, countedNum);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }

  function summaryText(): string {
    const lines = [
      `${session?.shop_name ?? "Duka"} — ${formatDay(date)}`,
      "",
      `Cash sales:   ${money(totals!.cash)}`,
      `M-Pesa sales: ${money(totals!.mpesa)}`,
      `TOTAL:        ${money(totals!.total)}`,
      `Transactions: ${totals!.count}`,
    ];
    if (totals!.creditSales > 0) {
      lines.push(`On credit:    ${money(totals!.creditSales)} (not money)`);
      if (paidAtTill > 0) {
        lines.push(
          `  paid at till ${money(paidAtTill)}`,
          `  still owed   ${money(totals!.creditOutstanding)}`,
        );
      }
    }
    if (totals!.refundedTotal > 0) {
      lines.push(
        "",
        `Refunds:      -${money(totals!.refundedTotal)} (${totals!.refunds.length})`,
      );
      if (totals!.refundedCash > 0) {
        lines.push(`  cash out    ${money(totals!.refundedCash)}`);
      }
    }
    if (totals!.spentFromTill > 0 || totals!.spentFromMpesa > 0) {
      lines.push("", "Paid out:");
      if (totals!.spentFromTill > 0) {
        lines.push(`  from till   ${money(totals!.spentFromTill)}`);
      }
      if (totals!.spentFromMpesa > 0) {
        lines.push(`  from M-Pesa ${money(totals!.spentFromMpesa)}`);
      }
    }
    if (totals!.repaidCash > 0 || totals!.repaidMpesa > 0) {
      lines.push(
        "",
        `Old debt repaid:`,
        `  cash   ${money(totals!.repaidCash)}`,
        `  M-Pesa ${money(totals!.repaidMpesa)}`,
      );
    }
    if (countedNum !== null && !Number.isNaN(countedNum)) {
      lines.push(
        "",
        `Cash expected: ${money(totals!.expectedCash)}`,
        `Cash counted:  ${money(countedNum)}`,
        `Difference:    ${money(difference ?? 0)}`,
      );
    }
    if (totals!.mpesaSales.length || totals!.mpesaRepayments.length) {
      lines.push("", "M-Pesa codes:");
      totals!.mpesaSales.forEach((s) =>
        lines.push(`  ${s.mpesa_code ?? "NO CODE"}  ${money(s.total)}  ${formatClock(s.created_at)}`),
      );
      totals!.mpesaRepayments.forEach((e) =>
        lines.push(
          `  ${e.mpesa_code ?? "NO CODE"}  ${money(e.amount)}  ${formatClock(e.created_at)}  (debt)`,
        ),
      );
    }
    if (totals!.mpesaWithoutCode > 0) {
      lines.push(
        "",
        `(${totals!.mpesaWithoutCode} M-Pesa item(s) have no code and cannot be ticked off)`,
      );
    }
    if (totals!.unsynced > 0) {
      lines.push("", `(${totals!.unsynced} sale(s) not yet synced from this device)`);
    }
    return lines.join("\n");
  }

  async function share() {
    const text = summaryText();
    try {
      if (navigator.share) {
        await navigator.share({ title: `Closing ${date}`, text });
        setShared(null);
      } else {
        await navigator.clipboard.writeText(text);
        setShared("Copied. Paste it into WhatsApp.");
      }
    } catch {
      setShared(null); // user dismissed the share sheet
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl p-4 lg:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-bold lg:text-3xl">Closing</h1>
        <div className="flex items-center gap-3">
          {!isToday && <span className="text-sm text-muted">past day</span>}
          <input
            type="date"
            value={date}
            max={todayInNairobi()}
            onChange={(e) => {
              setDate(e.target.value || todayInNairobi());
              setError(null);
            }}
            className="no-print min-h-12 rounded-xl border border-line bg-surface px-4 text-base"
          />
        </div>
      </div>

      {typeof skew === "number" && Math.abs(skew) > 5 * 60_000 && (
        <div className="mb-4">
          <Notice tone="warn">
            This phone&apos;s clock is off by about {Math.round(Math.abs(skew) / 60000)} minutes.
            Sales may be filed on the wrong day until it is corrected.
          </Notice>
        </div>
      )}

      {/*
        On a wide screen the day's figures and the drawer count sit on the left
        and the M-Pesa codes on the right, so the owner can tick codes off
        against the Safaricom statement without scrolling away from the total
        they are reconciling. Below lg it is one column, in reading order.
      */}
      <div className="print-stack flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
      <div className="flex flex-col gap-4">

      {/* The split. Cash and M-Pesa never appear as one number without it. */}
      <div className="print-plain grid grid-cols-2 gap-3">
        <div className="rounded-2xl border-2 border-cash/30 bg-cash-soft p-4">
          <p className="text-sm font-semibold text-cash-dark">Cash sales</p>
          <p className="tabular text-3xl font-bold text-cash-dark">{money(totals.cash)}</p>
        </div>
        <div className="rounded-2xl border-2 border-mpesa/30 bg-mpesa-soft p-4">
          <p className="text-sm font-semibold text-mpesa-dark">M-Pesa sales</p>
          <p className="tabular text-3xl font-bold text-mpesa-dark">{money(totals.mpesa)}</p>
          {totals.expectedMpesa > totals.mpesa && (
            <p className="mt-1 text-sm text-mpesa-dark">
              + {money(totals.repaidMpesa + totals.paidAtTillMpesa)} from debtors ={" "}
              <strong>{money(totals.expectedMpesa)}</strong> received
            </p>
          )}
        </div>
      </div>

      <div className="print-plain flex items-center justify-between rounded-2xl border border-line bg-surface p-4">
        <div>
          <p className="text-sm text-muted">Total sales</p>
          <p className="tabular text-3xl font-bold">{money(totals.total)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted">Transactions</p>
          <p className="tabular text-3xl font-bold">{totals.count}</p>
        </div>
      </div>

      {/* Credit is shown apart from cash and M-Pesa, and never coloured like
          them: goods left the shop, money did not. Folding it into either
          column is exactly the ambiguity this screen exists to remove. */}
      {totals.creditSales > 0 && (
        <div className="print-plain rounded-2xl border border-dashed border-muted p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-muted">Sold on credit</p>
              <p className="tabular text-2xl font-bold text-muted">
                {money(totals.creditSales)}
              </p>
            </div>
            <p className="text-sm text-muted">
              {totals.creditCount} {totals.creditCount === 1 ? "sale" : "sales"}
            </p>
          </div>
          {paidAtTill > 0 ? (
            <>
              <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
                <Row
                  label="Paid at the counter"
                  value={<Money value={paidAtTill} />}
                />
                <Row
                  label="Still owed on today's credit"
                  value={<Money value={totals.creditOutstanding} />}
                />
              </dl>
              <p className="mt-2 text-sm text-muted">
                The {money(paidAtTill)} taken at the counter IS money and is counted below.
                The rest is not in the drawer and not on a phone.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Not in the drawer and not on a phone. Included in total sales, excluded from
              everything below.
            </p>
          )}
        </div>
      )}

      {/* Repayments are the mirror image: money arriving on a day with no sale
          attached. Leaving them out makes the drawer read OVER. */}
      {(totals.repaidCash > 0 || totals.repaidMpesa > 0) && (
        <div className="print-plain rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Old debt repaid today</h2>
          <p className="mb-2 text-sm text-muted">
            Money for goods sold on an EARLIER day — a debtor coming back to settle up. Part
            payments taken at the till today are shown with the sale above, not here.
          </p>
          <dl className="flex flex-col gap-1">
            <Row label="In cash" value={<Money value={totals.repaidCash} />} />
            <Row label="By M-Pesa" value={<Money value={totals.repaidMpesa} />} />
          </dl>
        </div>
      )}

      {/* Refunds are their own line, never netted into sales. A single net
          figure would hide exactly what the owner most wants to see. */}
      {totals.refundedTotal > 0 && (
        <div className="print-plain rounded-2xl border-2 border-danger/30 bg-danger-soft p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-danger">Reversed today</p>
              <p className="tabular text-2xl font-bold text-danger">
                -{money(totals.refundedTotal)}
              </p>
            </div>
            <p className="text-sm text-danger">
              {totals.refunds.length} {totals.refunds.length === 1 ? "sale" : "sales"}
            </p>
          </div>
          <p className="mt-2 text-sm text-muted">
            {totals.refundedCash > 0
              ? `${money(totals.refundedCash)} handed back in cash, so the drawer should be ` +
                "lower by that much."
              : "No cash moved — a credit sale was reversed, so a debt dropped instead."}
          </p>
        </div>
      )}

      {/* Money that left the drawer for something other than a refund. Without
          this the count reads short by exactly this amount, and an owner who
          paid for transport out of the till looks like a thief — which is the
          single ambiguity this screen exists to remove. */}
      {(totals.spentFromTill > 0 || totals.spentFromMpesa > 0) && (
        <div className="print-plain rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Paid out today</h2>
          <p className="mb-2 text-sm text-muted">
            Expenses, not stock. Expected cash below already allows for these.
          </p>
          <dl className="flex flex-col gap-1">
            {totals.spentFromTill > 0 && (
              <Row label="From the till" value={<Money value={totals.spentFromTill} />} />
            )}
            {totals.spentFromMpesa > 0 && (
              <Row label="From shop M-Pesa" value={<Money value={totals.spentFromMpesa} />} />
            )}
          </dl>
          <ul className="mt-2 flex flex-col divide-y divide-line border-t border-line">
            {totals.expenses.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {EXPENSE_CATEGORIES.find((c) => c.key === e.category)?.label ?? e.category}
                  {e.note && <span className="text-muted"> · {e.note}</span>}
                </span>
                <span className="tabular shrink-0">{money(e.amount)}</span>
              </li>
            ))}
          </ul>
          {isOwner && (
            <Link href="/expenses" className="no-print mt-2 inline-block">
              <Button variant="ghost" className="min-h-12 px-0 text-sm">
                Record another
              </Button>
            </Link>
          )}
        </div>
      )}

      {/* The day's sales. Owner-only refunding, enforced by RLS as well as by
          this button not being rendered. */}
      {daySales && daySales.length > 0 && (
        <div className="no-print rounded-2xl border border-line bg-surface p-4">
          <button
            onClick={() => setShowSales((v) => !v)}
            className="flex min-h-12 w-full items-baseline justify-between text-left"
          >
            <span className="text-lg font-bold">
              Sales this day <span className="font-normal text-muted">({daySales.length})</span>
            </span>
            <span className="text-sm text-brand-dark underline">
              {showSales ? "Hide" : isOwner ? "Show / refund" : "Show"}
            </span>
          </button>

          {showSales && (
            <ul className="mt-2 flex flex-col divide-y divide-line">
              {daySales.map((sale) => {
                const done = refundedIds?.has(sale.id) ?? false;
                return (
                  <li key={sale.id} className="py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="tabular font-semibold">
                          {money(sale.total)}
                          {done && (
                            <span className="ml-2 text-sm font-normal text-danger">reversed</span>
                          )}
                        </p>
                        <p className="text-sm text-muted">
                          {formatClock(sale.created_at)}
                          {sale.mpesa_code && ` · ${sale.mpesa_code}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <PaymentTag method={sale.payment_method} />
                        {isOwner && !done && (
                          <Button
                            variant="neutral"
                            className="min-h-12 px-3 text-sm"
                            onClick={() =>
                              setRefunding(refunding === sale.id ? null : sale.id)
                            }
                          >
                            Refund
                          </Button>
                        )}
                      </div>
                    </div>
                    {refunding === sale.id && !done && (
                      <div className="mt-3">
                        <RefundSheet sale={sale} onClose={() => setRefunding(null)} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {showSales && !isOwner && (
            <p className="mt-2 text-sm text-muted">
              Only the owner can reverse a sale. If one of these is wrong, tell them which.
            </p>
          )}
        </div>
      )}

      {/* Cash count */}
      <div className="print-plain rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-bold">Count the drawer</h2>
        <p className="mb-3 text-sm text-muted">
          Only cash. M-Pesa money is not in the drawer.
          {totals.repaidCash > 0 &&
            ` Expected includes ${money(totals.repaidCash)} of old debt repaid in cash.`}
          {totals.paidAtTillCash > 0 &&
            ` It also includes ${money(totals.paidAtTillCash)} paid in cash at the counter on credit sales.`}
          {totals.refundedCash > 0 &&
            ` ${money(totals.refundedCash)} was handed back on a refund, so expected is lower by that much.`}
          {totals.spentFromTill > 0 &&
            ` ${money(totals.spentFromTill)} was paid out of the till for expenses, so expected is lower by that too.`}
        </p>

        <Input
          type="number"
          inputMode="numeric"
          step="1"
          min="0"
          placeholder="0"
          value={counted}
          onChange={(e) => setDraft({ date, value: e.target.value })}
          className="tabular h-16 text-3xl font-bold"
        />

        <dl className="mt-4 flex flex-col gap-2">
          <Row label="Expected in drawer" value={<Money value={totals.expectedCash} />} />
          <Row
            label="Counted"
            value={countedNum === null ? <span className="text-muted">—</span> : <Money value={countedNum} />}
          />
          <div
            className={`flex items-center justify-between rounded-xl px-3 py-3 ${
              difference === null
                ? "bg-canvas"
                : difference === 0
                  ? "bg-cash-soft"
                  : "bg-danger-soft"
            }`}
          >
            <dt className="font-semibold">Difference</dt>
            <dd
              className={`tabular text-2xl font-bold ${
                difference === null
                  ? "text-muted"
                  : difference === 0
                    ? "text-cash-dark"
                    : "text-danger"
              }`}
            >
              {difference === null ? "—" : money(difference)}
            </dd>
          </div>
        </dl>

        {difference !== null && difference !== 0 && (
          <p className="mt-2 text-sm text-danger">
            {difference < 0
              ? "Less cash than the sales say. Check for a keying error or a sale recorded as M-Pesa."
              : "More cash than the sales say. A sale may not have been recorded."}
          </p>
        )}

        {error && <div className="mt-3"><Notice>{error}</Notice></div>}
        {saved && <div className="mt-3"><Notice tone="cash">Cash count saved.</Notice></div>}

        <Button className="no-print mt-3 w-full" size="lg" onClick={save}>
          Save count
        </Button>
      </div>

      </div>
      {/* ------------------------------------- second column on desktop --- */}
      <div className="flex flex-col gap-4">

      {/* M-Pesa codes to tick off against the Safaricom statement */}
      <div className="print-plain rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-bold">
          M-Pesa codes{" "}
          <span className="text-base font-normal text-muted">
            ({totals.mpesaSales.length + totals.mpesaRepayments.length})
          </span>
        </h2>
        <p className="mb-2 text-sm text-muted">Tick these off against your Safaricom statement.</p>

        {/* Where the control went when the code stopped being compulsory.
            The money is still counted correctly either way — what is lost is
            the ability to VERIFY it, and that loss should be a number the
            owner sees rather than something they discover at the statement. */}
        {totals.mpesaWithoutCode > 0 && (
          <div className="mb-2">
            <Notice tone="warn">
              {totals.mpesaWithoutCode} of these{" "}
              {totals.mpesaWithoutCode === 1 ? "has" : "have"} no code, so{" "}
              {totals.mpesaWithoutCode === 1 ? "it" : "they"} cannot be matched to the statement.
              The amount is still counted — only the proof is missing.
            </Notice>
          </div>
        )}

        {totals.mpesaSales.length + totals.mpesaRepayments.length === 0 ? (
          <p className="py-4 text-center text-muted">No M-Pesa money on this day.</p>
        ) : (
          <ul className="print-scroll flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto">
            {totals.mpesaSales.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-3">
                {s.mpesa_code ? (
                  <span className="font-mono text-base font-semibold tracking-wide">
                    {s.mpesa_code}
                  </span>
                ) : (
                  <span className="text-base font-semibold text-warn">No code</span>
                )}
                <span className="flex items-center gap-3">
                  <span className="text-sm text-muted">{formatClock(s.created_at)}</span>
                  <Money value={s.total} className="font-bold" />
                </span>
              </li>
            ))}
            {totals.mpesaRepayments.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 py-3">
                <span className="min-w-0">
                  {e.mpesa_code ? (
                    <span className="block font-mono text-base font-semibold tracking-wide">
                      {e.mpesa_code}
                    </span>
                  ) : (
                    <span className="block text-base font-semibold text-warn">No code</span>
                  )}
                  <span className="text-sm text-muted">debt repaid</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-sm text-muted">{formatClock(e.created_at)}</span>
                  <Money value={e.amount} className="font-bold" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {totals.unsynced > 0 && (
        <Notice tone="warn">
          {totals.unsynced} sale{totals.unsynced === 1 ? "" : "s"} from this device{" "}
          {totals.unsynced === 1 ? "has" : "have"} not synced yet. These figures include them;
          another device will not see them until this phone is online.
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
    <div className="flex items-center justify-between px-3">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular text-lg font-semibold">{value}</dd>
    </div>
  );
}
