"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { expiringStock, EXPIRY_BANDS, EXPIRY_WARN_DAYS, type ExpiryState } from "@/lib/batches";
import { Button } from "@/components/ui";
import { formatDay, qty } from "@/lib/format";

/**
 * What is dying on the shelf.
 *
 * Sorted by expiry, soonest first, with expired stock at the very top — that
 * is the order the owner should physically work through it, and expired stock
 * is a standing instruction rather than a statistic.
 *
 * The bands are not decorative. A wholesaler will usually take stock back with
 * three months of life on it and almost never with less than one, so each band
 * marks the point where the available ACTION changes: return it, move it, or
 * accept the loss.
 */

const TONE: Record<ExpiryState, string> = {
  expired: "border-danger bg-danger-soft",
  critical: "border-danger/40 bg-danger-soft/50",
  soon: "border-warn/40 bg-warn-soft",
  ok: "border-line bg-surface",
};

const TEXT: Record<ExpiryState, string> = {
  expired: "text-danger",
  critical: "text-danger",
  soon: "text-warn",
  ok: "text-muted",
};

export default function ExpiryPage() {
  const rows = useLiveQuery(async () => expiringStock(), []);

  if (!rows) return <div className="p-4 text-muted">Loading…</div>;

  const expired = rows.filter((r) => r.state === "expired");
  const rest = rows.filter((r) => r.state !== "expired");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold lg:text-3xl">Expiry</h1>
        <p className="mt-1 text-sm text-muted">
          Batches still on the shelf, expiring within {EXPIRY_WARN_DAYS} days. Nearest first.
        </p>
      </div>

      {/* Expired stock is not a row in a list. It is a thing to go and remove
          from the shelf, so it gets its own block at the top and says so. */}
      {expired.length > 0 && (
        <div className="rounded-2xl border-2 border-danger bg-danger-soft p-4">
          <h2 className="text-lg font-bold text-danger">
            {expired.length} expired {expired.length === 1 ? "batch" : "batches"} still counted as
            stock
          </h2>
          <p className="mt-1 text-sm text-danger">
            Pull these off the shelf now. The till will not dispense them, but they are still in
            your stock figures until you record them as damage or loss.
          </p>
          <ul className="mt-3 flex flex-col divide-y divide-danger/20">
            {expired.map((r) => (
              <li key={r.batch.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{r.productName}</span>
                  <span className="block text-sm text-danger">
                    Batch {r.batch.batch_no} · expired {formatDay(r.batch.expiry_date)} (
                    {Math.abs(r.daysLeft)} days ago)
                  </span>
                </span>
                <span className="tabular shrink-0 font-bold">{qty(r.quantity)}</span>
              </li>
            ))}
          </ul>
          <Link href="/products/adjust" className="mt-3 inline-block">
            <Button variant="danger" className="min-h-12">
              Write these off
            </Button>
          </Link>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl bg-cash-soft px-4 py-8 text-center font-semibold text-cash-dark">
          Nothing expires in the next {EXPIRY_WARN_DAYS} days.
        </p>
      ) : (
        rest.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rest.map((r) => {
              const band = EXPIRY_BANDS.find((b) => b.key === r.state);
              return (
                <li
                  key={r.batch.id}
                  className={`flex items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3 ${TONE[r.state]}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{r.productName}</span>
                    <span className="block text-sm text-muted">
                      Batch {r.batch.batch_no} · {formatDay(r.batch.expiry_date)}
                    </span>
                    <span className={`block text-sm ${TEXT[r.state]}`}>
                      {r.daysLeft} days left · {band?.action}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular block text-lg font-bold">{qty(r.quantity)}</span>
                    <Link
                      href={`/products/history?id=${r.productId}`}
                      className="text-sm text-brand-dark underline"
                    >
                      history
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        )
      )}

      <Link href="/products">
        <Button variant="ghost" className="w-full sm:w-48">
          Back to products
        </Button>
      </Link>
    </div>
  );
}
