"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { customerDebt, remindersFor, sortLedger, AGE_BUCKETS } from "@/lib/debt";
import { recordDebtEntry, saveCustomer } from "@/lib/store";
import { CHANNELS, displayPhone, normalisePhone, shareText, statementText } from "@/lib/remind";
import { RemindSheet } from "@/components/remind-sheet";
import { useSession } from "@/components/session-provider";
import { Button, Field, Input, Notice } from "@/components/ui";
import { formatDay, money } from "@/lib/format";
import type { RepaymentMethod } from "@/lib/types";

/**
 * One customer's ledger, and the two actions that matter: take money, or give
 * up on it.
 *
 * The running balance shown against each row is computed forwards through the
 * ledger, so the list explains itself — an owner can point at the line where
 * a debt started rather than being handed a single total to trust.
 */
function CustomerDebtScreen() {
  const id = useSearchParams().get("id") ?? undefined;
  const { session } = useSession();
  const isOwner = session?.role === "owner";

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<RepaymentMethod>("cash");
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [writingOff, setWritingOff] = useState(false);
  const [editing, setEditing] = useState(false);
  const [limitDraft, setLimitDraft] = useState("");
  const [phoneDraft, setPhoneDraft] = useState("");
  const [chasing, setChasing] = useState(false);

  const debt = useLiveQuery(async () => (id ? customerDebt(id) : null), [id]);
  const reminders = useLiveQuery(async () => (id ? remindersFor(id) : []), [id]);
  const ledger = useLiveQuery(async () => {
    if (!id) return [];
    const entries = await db.debt_entries.where("customer_id").equals(id).toArray();
    let running = 0;
    return sortLedger(entries)
      .map((e) => {
        running =
          Math.round((running + (e.kind === "charge" ? e.amount : -e.amount)) * 100) / 100;
        return { entry: e, balance: running };
      })
      .reverse();
  }, [id]);

  if (!id) return <div className="p-4 text-muted">No customer selected.</div>;
  if (debt === undefined || ledger === undefined)
    return <div className="p-4 text-muted">Loading…</div>;
  if (debt === null) return <div className="p-4 text-muted">Customer not found.</div>;

  const hasPhone = normalisePhone(debt.customer.phone) != null;

  async function share() {
    setError(null);
    try {
      const text = statementText(
        debt!,
        ledger!.map((l) => l.entry),
        session?.shop_name ?? "Duka",
        formatDay,
      );
      const outcome = await shareText(`${debt!.customer.name} — statement`, text);
      if (outcome === "copied") setDone("Statement copied — paste it into WhatsApp.");
    } catch {
      setError("Could not share the statement.");
    }
  }

  const bucket = AGE_BUCKETS.find((b) => b.key === debt.bucket);
  const amountNum = Number(amount) || 0;

  async function submitPayment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await recordDebtEntry({
        customer_id: id!,
        kind: "payment",
        amount: amountNum,
        payment_method: method,
        mpesa_code: method === "mpesa" ? code : null,
        note: note || null,
      });
      setDone(`Recorded ${money(amountNum)} from ${debt!.customer.name}`);
      setAmount("");
      setCode("");
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record");
    } finally {
      setBusy(false);
    }
  }

  async function writeOff() {
    setBusy(true);
    setError(null);
    try {
      await recordDebtEntry({
        customer_id: id!,
        kind: "writeoff",
        amount: debt!.balance,
        note: note || "Written off",
      });
      setDone(`Wrote off ${money(debt!.balance)}`);
      setWritingOff(false);
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not write off");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold lg:text-3xl">{debt.customer.name}</h1>
        {hasPhone ? (
          <a
            href={`tel:+${normalisePhone(debt.customer.phone)}`}
            className="mt-1 inline-flex min-h-12 items-center text-base text-brand-dark underline"
          >
            {displayPhone(debt.customer.phone)}
          </a>
        ) : (
          // A debt with no phone number is a debt that can only be collected if
          // the person happens to walk past. Worth interrupting for.
          <div className="mt-2 flex flex-col gap-2 rounded-xl bg-warn-soft p-3 sm:flex-row">
            <Input
              placeholder="Phone number"
              inputMode="tel"
              value={phoneDraft}
              onChange={(e) => setPhoneDraft(e.target.value)}
              className="sm:flex-1"
            />
            <Button
              variant="neutral"
              disabled={!phoneDraft.trim()}
              onClick={async () => {
                setError(null);
                try {
                  await saveCustomer({
                    id: debt.customer.id,
                    name: debt.customer.name,
                    phone: phoneDraft.trim(),
                    credit_limit: debt.customer.credit_limit,
                  });
                  setPhoneDraft("");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not save");
                }
              }}
            >
              Save number
            </Button>
          </div>
        )}
      </div>

      <div
        className={`rounded-2xl border p-4 ${
          debt.balance > 0 ? "border-line bg-surface" : "border-cash/30 bg-cash-soft"
        }`}
      >
        <p className="text-sm text-muted">{debt.balance < 0 ? "Paid ahead by" : "Owes"}</p>
        <p className="tabular text-4xl font-bold">{money(Math.abs(debt.balance))}</p>
        {debt.oldestDays > 0 && (
          <p className="mt-1 text-sm text-muted">
            Oldest unpaid: {debt.oldestDays} days · {bucket?.action}
          </p>
        )}
        {debt.overLimit && (
          <div className="mt-3">
            <Notice tone="warn">
              At or over their {money(debt.customer.credit_limit ?? 0)} limit.
            </Notice>
          </div>
        )}
        <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Taken on credit, all time</dt>
            <dd className="tabular">{money(debt.totalCharged)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Paid back</dt>
            <dd className="tabular">{money(debt.totalPaid)}</dd>
          </div>
          {debt.totalWrittenOff > 0 && (
            <div className="flex justify-between">
              <dt className="text-muted">Written off</dt>
              <dd className="tabular text-danger">{money(debt.totalWrittenOff)}</dd>
            </div>
          )}
        </dl>
      </div>

      {debt.balance > 0 &&
        (chasing ? (
          <RemindSheet debt={debt} onClose={() => setChasing(false)} />
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="sm:flex-1" onClick={() => setChasing(true)}>
              Chase this debt
            </Button>
            <Button variant="neutral" className="sm:flex-1" onClick={share}>
              Send statement
            </Button>
          </div>
        ))}

      {done && <Notice tone="cash">{done}</Notice>}
      {error && <Notice>{error}</Notice>}

      {/* Take money */}
      {debt.balance > 0 && (
        <form onSubmit={submitPayment} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Record a payment</h2>

          <Field label="Amount">
            <Input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular h-16 text-3xl font-bold"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={method === "cash" ? "cash" : "neutral"}
              onClick={() => setMethod("cash")}
            >
              Cash
            </Button>
            <Button
              type="button"
              variant={method === "mpesa" ? "mpesa" : "neutral"}
              onClick={() => setMethod("mpesa")}
            >
              M-Pesa
            </Button>
          </div>

          {method === "mpesa" && (
            <Input
              placeholder="M-Pesa code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          )}

          {amountNum > 0 && (
            <p className="rounded-xl bg-brand-soft px-4 py-3 text-base text-brand-dark">
              Leaves <strong>{money(Math.max(0, debt.balance - amountNum))}</strong> owing
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy || amountNum <= 0}>
            Record payment
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-10 text-sm"
            onClick={() => setAmount(String(debt.balance))}
          >
            Paying it all off ({money(debt.balance)})
          </Button>
        </form>
      )}

      {/* Ledger */}
      <div className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-bold">History</h2>
        {ledger.length === 0 ? (
          <p className="py-6 text-center text-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {ledger.map(({ entry, balance }) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {entry.kind === "charge"
                      ? "Took goods on credit"
                      : entry.kind === "payment"
                        ? `Paid ${entry.payment_method === "mpesa" ? "by M-Pesa" : "cash"}`
                        : "Written off"}
                  </p>
                  <p className="text-sm text-muted">
                    {formatDay(entry.business_date)}
                    {entry.mpesa_code && ` · ${entry.mpesa_code}`}
                    {entry.note && ` · ${entry.note}`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`tabular font-bold ${
                      entry.kind === "charge" ? "text-ink" : "text-cash-dark"
                    }`}
                  >
                    {entry.kind === "charge" ? "+" : "−"}
                    {money(entry.amount)}
                  </p>
                  <p className="tabular text-xs text-muted">{money(balance)} owing</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* What has already been said. Without this the owner chases the same
          person twice on Tuesday and nobody on Wednesday — and cannot answer
          "have we even asked them?", which is the question that decides
          whether the next step is a call or a write-off. */}
      {reminders && reminders.length > 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Chase history</h2>
          <ul className="flex flex-col divide-y divide-line">
            {reminders.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {CHANNELS.find((c) => c.key === r.channel)?.label ?? r.channel}
                    {r.promised_date && (
                      <span className="ml-2 font-normal text-brand-dark">
                        promised {formatDay(r.promised_date)}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted">
                    {formatDay(r.created_at.slice(0, 10))}
                    {r.note && ` · ${r.note}`}
                  </p>
                </div>
                <p className="tabular shrink-0 text-sm text-muted">
                  owed {money(r.balance_at_time)}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            This records that the message was opened, not that it was delivered or read.
          </p>
        </div>
      )}

      {/* Owner-only: limits and writing off */}
      {isOwner && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Owner actions</h2>

          {editing ? (
            <div className="flex flex-col gap-2">
              <Field label="Credit limit" hint="Leave empty for no limit. A warning, not a block.">
                <Input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  value={limitDraft}
                  onChange={(e) => setLimitDraft(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="neutral"
                  onClick={async () => {
                    setError(null);
                    try {
                      await saveCustomer({
                        id: debt.customer.id,
                        name: debt.customer.name,
                        phone: debt.customer.phone,
                        credit_limit: limitDraft === "" ? null : Number(limitDraft),
                      });
                      setEditing(false);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Could not save");
                    }
                  }}
                >
                  Save limit
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="neutral"
              className="self-start"
              onClick={() => {
                setLimitDraft(debt.customer.credit_limit?.toString() ?? "");
                setEditing(true);
              }}
            >
              {debt.customer.credit_limit != null
                ? `Credit limit: ${money(debt.customer.credit_limit)}`
                : "Set a credit limit"}
            </Button>
          )}

          {debt.balance > 0 &&
            (writingOff ? (
              <div className="flex flex-col gap-2 rounded-xl bg-danger-soft p-3">
                <p className="text-sm text-danger">
                  This forgives {money(debt.balance)}. It stays in the history as a write-off —
                  nothing is deleted.
                </p>
                <Input
                  placeholder="Why? (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button variant="danger" disabled={busy} onClick={writeOff}>
                    Write off {money(debt.balance)}
                  </Button>
                  <Button variant="ghost" onClick={() => setWritingOff(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" className="self-start" onClick={() => setWritingOff(true)}>
                Write off this debt
              </Button>
            ))}
        </div>
      )}

      <Link href="/debts">
        <Button variant="ghost" className="w-full sm:w-48">
          Back to debts
        </Button>
      </Link>
    </div>
  );
}

export default function CustomerDebtPage() {
  return (
    <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
      <CustomerDebtScreen />
    </Suspense>
  );
}
