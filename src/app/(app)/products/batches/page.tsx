"use client";

import { useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { batchTrace, findBatches, type ExpiryState } from "@/lib/batches";
import { Button, Input, Notice } from "@/components/ui";
import { formatClock, formatDay, money, qty } from "@/lib/format";

/**
 * Recall lookup: type the batch number from the notice, see where it went.
 *
 * This is the question a chemist cannot answer from a paper book, and the one
 * that arrives with no warning. The screen is deliberately blunt about its
 * limit: a cash sale to a stranger names nobody, and no record-keeping changes
 * that. So it reports how many of the sales can actually be traced to a person
 * rather than implying the list is complete — which is what makes the
 * contactable ones worth acting on.
 */

const TONE: Record<ExpiryState, string> = {
  expired: "border-danger bg-danger-soft",
  critical: "border-danger/40 bg-danger-soft/50",
  soon: "border-warn/40 bg-warn-soft",
  ok: "border-line bg-surface",
};

export default function BatchLookupPage() {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const matches = useLiveQuery(async () => findBatches(query), [query]);
  const trace = useLiveQuery(async () => (picked ? batchTrace(picked) : null), [picked]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div className="no-print">
        <h1 className="text-2xl font-bold lg:text-3xl">Find a batch</h1>
        <p className="mt-1 text-sm text-muted">
          For a recall notice, or to check where a specific carton went. Spaces and dashes are
          ignored, so it will match however it was typed in.
        </p>
      </div>

      {!picked ? (
        <>
          <Input
            autoFocus
            placeholder="Batch number from the carton or notice"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />

          {query.trim() && matches?.length === 0 && (
            <Notice>
              No batch matching that. It may have been received before batch tracking was switched
              on for the product, or on a device that has not synced here.
            </Notice>
          )}

          <ul className="flex flex-col gap-2">
            {(matches ?? []).map((m) => (
              <li key={m.batch.id}>
                <button
                  onClick={() => setPicked(m.batch.id)}
                  className={`flex min-h-16 w-full items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3 text-left ${TONE[m.state]}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{m.productName}</span>
                    <span className="block font-mono text-sm">{m.batch.batch_no}</span>
                    <span className="block text-sm text-muted">
                      expires {formatDay(m.batch.expiry_date)}
                      {m.state === "expired" && (
                        <span className="font-semibold text-danger"> · EXPIRED</span>
                      )}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-right font-bold">
                    {qty(m.quantity)} left
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : !trace ? (
        <div className="p-4 text-muted">Loading…</div>
      ) : (
        <>
          <div className="no-print">
            <Button variant="ghost" className="min-h-12" onClick={() => setPicked(null)}>
              ← Search another batch
            </Button>
          </div>

          <div className="print-plain rounded-2xl border border-line bg-surface p-4">
            <h2 className="text-lg font-bold">{trace.productName}</h2>
            <p className="font-mono text-sm">{trace.batch.batch_no}</p>
            <p className="text-sm text-muted">
              Expires {formatDay(trace.batch.expiry_date)}
            </p>

            <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
              <div>
                <dt className="text-sm text-muted">Received</dt>
                <dd className="tabular text-xl font-bold">{qty(trace.received)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Sold</dt>
                <dd className="tabular text-xl font-bold">{qty(trace.sold)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Still here</dt>
                <dd className="tabular text-xl font-bold">{qty(trace.remaining)}</dd>
              </div>
            </dl>
          </div>

          {trace.remaining > 0 && (
            <Notice tone="warn">
              {qty(trace.remaining)} of this batch is still on the shelf. Pull it before anything
              else, then work through the list below.
            </Notice>
          )}

          <div className="rounded-2xl border border-line bg-surface p-4">
            <h3 className="text-lg font-bold">
              Where it went{" "}
              <span className="text-base font-normal text-muted">({trace.sales.length})</span>
            </h3>

            {/* The honest limit, stated before the list rather than discovered
                halfway down it. */}
            <p className="mb-2 text-sm text-muted">
              {trace.contactable > 0
                ? `${trace.contactable} of these can be traced to someone you can contact — a credit customer or a named patient. The rest were counter sales, which name nobody.`
                : "None of these name a person. They were counter sales, and a till cannot know who a stranger paying cash was."}
            </p>

            {trace.sales.length === 0 ? (
              <p className="py-6 text-center text-muted">None of this batch has been sold.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line border-t border-line">
                {trace.sales.map((t) => {
                  const who = t.patientName ?? t.customerName;
                  const phone = t.patientPhone ?? t.customerPhone;
                  return (
                    <li
                      key={t.sale_id}
                      className="flex items-center justify-between gap-3 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold">
                          {who ?? <span className="text-muted">Counter sale</span>}
                        </span>
                        <span className="block text-sm text-muted">
                          {formatDay(t.business_date)} · {formatClock(t.created_at)} ·{" "}
                          {money(t.total)}
                        </span>
                        {phone && (
                          <a
                            href={`tel:${phone}`}
                            className="mt-1 inline-flex min-h-12 items-center text-sm text-brand-dark underline"
                          >
                            {phone}
                          </a>
                        )}
                      </span>
                      <span className="tabular shrink-0 font-bold">{qty(t.quantity)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="no-print flex flex-col gap-2 sm:flex-row">
            <Button variant="neutral" onClick={() => window.print()} className="sm:w-40">
              Print
            </Button>
            <Link
              href={`/products/history?id=${trace.batch.product_id}`}
              className="sm:w-56"
            >
              <Button variant="neutral" className="w-full">
                Full product history
              </Button>
            </Link>
          </div>
        </>
      )}

      <Link href="/products" className="no-print">
        <Button variant="ghost" className="w-full sm:w-48">
          Back to products
        </Button>
      </Link>
    </div>
  );
}
