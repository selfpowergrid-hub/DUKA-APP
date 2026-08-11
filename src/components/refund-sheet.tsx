"use client";

import { useState } from "react";
import { refundSale } from "@/lib/store";
import { Button, Input, Notice } from "@/components/ui";
import { money } from "@/lib/format";
import { REFUND_REASONS, type RefundReason, type Sale } from "@/lib/types";

/**
 * Reversing one sale.
 *
 * The screen asks **why** and nothing else. Where the money goes is computed,
 * never chosen: an M-Pesa sale is refunded in cash because the app has no
 * Daraja and cannot send M-Pesa, and a credit sale reverses the debt because
 * nobody ever paid. Offering that as a choice at a busy counter is how the
 * wrong column silently ends up short — which is the exact failure this whole
 * app exists to prevent.
 *
 * The reason is a code rather than free text so refunds can be counted. A
 * rising "returned" count is a pattern worth seeing; free text is not.
 */
export function RefundSheet({
  sale,
  onClose,
}: {
  sale: Sale;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<RefundReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCredit = sale.payment_method === "credit";

  async function submit() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await refundSale({ sale_id: sale.id, reason, note: note || null });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refund this sale");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-danger/30 bg-danger-soft p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">Reverse this sale</h3>
          <p className="tabular text-sm text-muted">{money(sale.total)}</p>
        </div>
        <Button variant="ghost" className="min-h-12 shrink-0 px-2 text-sm" onClick={onClose}>
          Cancel
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-base font-medium">Why?</p>
        {REFUND_REASONS.map((r) => (
          <button
            key={r.key}
            onClick={() => setReason(r.key)}
            className={`min-h-14 rounded-xl border-2 px-4 py-2 text-left ${
              reason === r.key
                ? "border-danger bg-surface"
                : "border-line bg-surface/60"
            }`}
          >
            <span className="block font-semibold">{r.label}</span>
            <span className="block text-sm text-muted">{r.hint}</span>
          </button>
        ))}
      </div>

      <Input
        placeholder="Anything worth noting (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {/* Stated, not asked. The attendant cannot misfile which column is short. */}
      {reason && (
        <div className="rounded-xl bg-surface p-3">
          <p className="text-base font-semibold">
            {isCredit
              ? "No money changes hands"
              : `Give ${money(sale.total)} back in cash`}
          </p>
          <p className="mt-1 text-sm text-muted">
            {isCredit
              ? "They took these goods on credit and never paid, so their debt drops by " +
                `${money(sale.total)}. If they had already paid more than they kept, the ` +
                "difference stays as credit toward their next purchase."
              : sale.payment_method === "mpesa"
                ? "The sale was paid by M-Pesa, but this app cannot send M-Pesa. Hand the " +
                  "cash over and today's expected drawer drops by that amount — expected " +
                  "M-Pesa is left alone."
                : "Today's expected drawer drops by that amount."}
          </p>
          {!REFUND_REASONS.find((r) => r.key === reason)?.sellable && (
            <p className="mt-2 text-sm text-muted">
              The goods go back on the books and are then written off as damage, so the shrink
              report picks them up.
            </p>
          )}
        </div>
      )}

      {error && <Notice>{error}</Notice>}

      <Button variant="danger" size="lg" disabled={!reason || busy} onClick={submit}>
        {busy ? "Reversing…" : `Reverse ${money(sale.total)}`}
      </Button>
      <p className="text-sm text-muted">
        The original sale is never deleted. This is recorded alongside it, with your name on it.
      </p>
    </div>
  );
}
