"use client";

import { useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { chaseList, AGE_BUCKETS, type AgeBucket, type DebtorRow } from "@/lib/debt";
import { RemindSheet } from "@/components/remind-sheet";
import { Button, Input, Money, Notice } from "@/components/ui";
import { money } from "@/lib/format";
import { saveCustomer } from "@/lib/store";

/**
 * The debtors list — the screen this whole feature exists for.
 *
 * Roughly 45% of Kenyan shopkeeper credit is never repaid, the worst rate of
 * any credit type in the country, and it is traditionally tracked in a paper
 * book that gets lost. So this screen leads with EXPOSURE — how much of the
 * shop is currently sitting in other people's houses — rather than with a
 * tidy list of names.
 *
 * And it is split into TODAY and LATER rather than being one long list sorted
 * by age. A list of thirty names is the same as no list: the shop has a counter
 * to run, so nothing gets chased at all. Today's group is short by design, and
 * a broken promise sits at the top of it — "you said Friday" is a far stronger
 * thing to open with than "you have owed this for 34 days", and it is the point
 * at which to stop extending more credit rather than the point to write it off.
 */

const BUCKET_TONE: Record<AgeBucket, string> = {
  normal: "text-muted",
  watch: "text-warn",
  chase: "text-danger",
  at_risk: "text-danger",
};

export default function DebtsPage() {
  const list = useLiveQuery(async () => chaseList(), []);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [reminding, setReminding] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!list) return <div className="p-4 text-muted">Loading…</div>;

  const rows = [...list.due, ...list.later];
  const q = search.trim().toLowerCase();
  const matches = (d: DebtorRow) =>
    !q || d.customer.name.toLowerCase().includes(q) || (d.customer.phone ?? "").includes(q);

  const outstanding = rows.reduce((t, d) => t + Math.max(0, d.balance), 0);
  const atRisk = rows
    .filter((d) => d.bucket === "at_risk")
    .reduce((t, d) => t + Math.max(0, d.balance), 0);

  const due = list.due.filter(matches);
  const later = list.later.filter(matches);
  const openRow = reminding ? rows.find((d) => d.customer.id === reminding) : null;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await saveCustomer({ name, phone: phone || null });
      setName("");
      setPhone("");
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    }
  }

  function Row({ d }: { d: DebtorRow }) {
    const bucket = AGE_BUCKETS.find((b) => b.key === d.bucket);
    return (
      <li className="rounded-2xl border border-line bg-surface">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <Link href={`/debts/customer?id=${d.customer.id}`} className="min-w-0 flex-1 py-1">
            <span className="block truncate font-semibold">{d.customer.name}</span>
            <span
              className={`block text-sm ${
                d.chase.promiseBroken ? "font-semibold text-danger" : "text-muted"
              }`}
            >
              {d.chase.reason}
            </span>
            <span className={`block text-xs ${d.bucket ? BUCKET_TONE[d.bucket] : "text-muted"}`}>
              {d.oldestDays > 0 ? `oldest ${d.oldestDays} days · ${bucket?.action ?? ""}` : "settled"}
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-right">
              <Money value={d.balance} className="text-lg font-bold" />
              {d.customer.credit_limit != null && (
                <span className="block text-xs text-muted">
                  limit {money(d.customer.credit_limit)}
                </span>
              )}
            </span>
            <Button
              variant="neutral"
              className="min-h-12 px-3 text-sm"
              onClick={() => setReminding(reminding === d.customer.id ? null : d.customer.id)}
            >
              Chase
            </Button>
          </div>
        </div>
        {reminding === d.customer.id && openRow && (
          <div className="border-t border-line p-2">
            <RemindSheet debt={openRow} onClose={() => setReminding(null)} />
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-2xl font-bold lg:text-3xl">Debts</h1>

      {/* The headline is exposure, not a count of names. */}
      <div className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-sm text-muted">Owed to this shop right now</p>
        <p className="tabular text-4xl font-bold">{money(outstanding)}</p>
        <p className="mt-1 text-sm text-muted">
          {rows.length} {rows.length === 1 ? "person" : "people"}
          {atRisk > 0 && (
            <>
              {" · "}
              <span className="font-semibold text-danger">{money(atRisk)} over 60 days</span>
            </>
          )}
        </p>
      </div>

      {rows.length > 0 && (
        <Input
          placeholder="Search by name or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          inputMode="search"
        />
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl bg-cash-soft px-4 py-8 text-center font-semibold text-cash-dark">
          Nobody owes the shop anything.
        </p>
      ) : due.length === 0 && later.length === 0 ? (
        <p className="rounded-2xl bg-panel px-4 py-8 text-center text-muted">Nobody matches that.</p>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-bold">Chase today</h2>
              {due.length > 0 && (
                <span className="tabular text-sm text-muted">
                  {money(due.reduce((t, d) => t + d.balance, 0))}
                </span>
              )}
            </div>
            {due.length === 0 ? (
              <p className="rounded-2xl bg-cash-soft px-4 py-6 text-center font-semibold text-cash-dark">
                Nothing to chase today. Everyone has been spoken to recently or has promised a day.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {due.map((d) => (
                  <Row key={d.customer.id} d={d} />
                ))}
              </ul>
            )}
          </section>

          {later.length > 0 && (
            <section className="flex flex-col gap-2">
              <button
                onClick={() => setShowAll((v) => !v)}
                className="flex min-h-12 items-baseline justify-between text-left"
              >
                <span className="text-lg font-bold">
                  Everyone else{" "}
                  <span className="font-normal text-muted">({later.length})</span>
                </span>
                <span className="text-sm text-brand-dark underline">
                  {showAll ? "Hide" : "Show"}
                </span>
              </button>
              {showAll && (
                <ul className="flex flex-col gap-2">
                  {later.map((d) => (
                    <Row key={d.customer.id} d={d} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      {error && <Notice>{error}</Notice>}

      {adding ? (
        <form onSubmit={add} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="font-bold">New customer</h2>
          <Input placeholder="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            placeholder="Phone (optional, but it is how you chase a debt)"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="submit" className="sm:flex-1">
              Add
            </Button>
            <Button type="button" variant="ghost" className="sm:w-32" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="neutral" className="self-start" onClick={() => setAdding(true)}>
          + Add a customer
        </Button>
      )}
    </div>
  );
}
