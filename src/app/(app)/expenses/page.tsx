"use client";

import { useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { saveExpense, voidExpense } from "@/lib/store";
import { useSession } from "@/components/session-provider";
import { Button, Field, Input, Money, Notice } from "@/components/ui";
import { formatDay, money, todayInNairobi } from "@/lib/format";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_SOURCES,
  type ExpenseCategory,
  type ExpenseSource,
} from "@/lib/types";

/**
 * What the shop spends that is not stock.
 *
 * Two jobs, and the second is the one that earns its place in a till app:
 *
 *   1. It completes the profit and loss account. Sales less cost of goods was
 *      only ever half the picture.
 *   2. It keeps the drawer honest. Taking 2,000 out of the till for transport
 *      leaves the count 2,000 short, and a shortfall nobody can explain is
 *      indistinguishable from theft — the exact ambiguity this app exists to
 *      remove. Recorded here, Closing expects the lower figure and the count
 *      balances.
 *
 * Buying stock is deliberately absent from the categories: that already flows
 * through restock into cost of goods sold, and recording it again would count
 * the same shilling twice.
 */
export default function ExpensesPage() {
  const { session } = useSession();
  const isOwner = session?.role === "owner";

  const [category, setCategory] = useState<ExpenseCategory | null>(null);
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<ExpenseSource>("till_cash");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayInNairobi());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);

  // The last 60 days is plenty: anything older belongs in Reports, and an
  // unbounded list on a phone that has been trading a year is a scroll nobody
  // finishes.
  const recent = useLiveQuery(
    async () => (await db.expenses.orderBy("business_date").reverse().limit(60).toArray()),
    [],
  );

  const amountNum = Number(amount) || 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (!category) throw new Error("Choose what it was for");
      await saveExpense({
        category,
        amount: amountNum,
        paid_from: source,
        note: note || null,
        business_date: date,
      });
      setDone(`Recorded ${money(amountNum)}.`);
      setAmount("");
      setNote("");
      setCategory(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record it");
    } finally {
      setBusy(false);
    }
  }

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4 lg:p-6">
        <h1 className="text-2xl font-bold">Expenses</h1>
        <div className="mt-4">
          <Notice tone="warn">
            Only the owner can record expenses. Money leaving with no goods coming in is the
            hardest thing in the shop to check afterwards, so it is kept to one pair of hands.
          </Notice>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold lg:text-3xl">Expenses</h1>
        <p className="mt-1 text-sm text-muted">
          What the shop spends that is not stock. Buying stock is recorded as a restock instead,
          so it is not double counted.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4">
        <Field label="What was it for?">
          <div className="grid grid-cols-2 gap-2">
            {EXPENSE_CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                className={`min-h-14 rounded-xl border-2 px-3 py-2 text-left ${
                  category === c.key ? "border-brand bg-brand-soft" : "border-line bg-surface"
                }`}
              >
                <span className="block text-sm font-semibold">{c.label}</span>
                <span className="block text-xs text-muted">{c.hint}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="How much">
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

        {/* The field that decides whether the drawer should be lighter. */}
        <Field label="Where did the money come from?">
          <div className="flex flex-col gap-2">
            {EXPENSE_SOURCES.map((sc) => (
              <button
                key={sc.key}
                type="button"
                onClick={() => setSource(sc.key)}
                className={`min-h-14 rounded-xl border-2 px-4 py-2 text-left ${
                  source === sc.key ? "border-brand bg-brand-soft" : "border-line bg-surface"
                }`}
              >
                <span className="block font-semibold">{sc.label}</span>
                <span className="block text-sm text-muted">{sc.hint}</span>
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date">
            <Input
              type="date"
              value={date}
              max={todayInNairobi()}
              onChange={(e) => setDate(e.target.value || todayInNairobi())}
            />
          </Field>
          <Field label="Note" hint="Optional. Who was paid, what for.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>

        {amountNum > 0 && source === "till_cash" && (
          <Notice>
            Tonight&apos;s drawer should be {money(amountNum)} lighter. Closing already expects
            that, so the count will still balance.
          </Notice>
        )}

        {done && <Notice tone="cash">{done}</Notice>}
        {error && <Notice>{error}</Notice>}

        <Button type="submit" size="lg" disabled={busy || amountNum <= 0 || !category}>
          Record expense
        </Button>
      </form>

      <div className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-bold">Recent</h2>
        {!recent ? (
          <p className="py-4 text-muted">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {recent.map((e) => {
              const cat = EXPENSE_CATEGORIES.find((c) => c.key === e.category);
              const src = EXPENSE_SOURCES.find((x) => x.key === e.paid_from);
              return (
                <li key={e.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`font-semibold ${e.voided_at ? "line-through text-muted" : ""}`}>
                        {cat?.label ?? e.category}
                      </p>
                      <p className="text-sm text-muted">
                        {formatDay(e.business_date)} · {src?.label}
                        {e.note && ` · ${e.note}`}
                      </p>
                      {e.voided_at && (
                        <p className="text-sm text-danger">
                          Voided{e.void_reason ? ` — ${e.void_reason}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Money
                        value={e.amount}
                        className={`font-bold ${e.voided_at ? "line-through text-muted" : ""}`}
                      />
                      {!e.voided_at && (
                        <Button
                          variant="ghost"
                          className="min-h-12 px-2 text-sm"
                          onClick={() => setVoiding(voiding === e.id ? null : e.id)}
                        >
                          Void
                        </Button>
                      )}
                    </div>
                  </div>

                  {voiding === e.id && (
                    <div className="mt-2 flex flex-col gap-2 rounded-xl bg-danger-soft p-3">
                      <p className="text-sm text-danger">
                        Voiding leaves it in the record, struck through, and takes it out of every
                        total. Nothing is deleted and the amount cannot be edited.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="danger"
                          className="min-h-12 px-3 text-sm"
                          onClick={async () => {
                            await voidExpense(e.id, "Entered in error");
                            setVoiding(null);
                          }}
                        >
                          Void it
                        </Button>
                        <Button
                          variant="ghost"
                          className="min-h-12 px-3 text-sm"
                          onClick={() => setVoiding(null)}
                        >
                          Keep it
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Link href="/reports/trading">
        <Button variant="neutral" className="w-full sm:w-56">
          See the profit and loss
        </Button>
      </Link>
    </div>
  );
}
