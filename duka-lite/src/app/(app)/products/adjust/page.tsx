"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProducts } from "@/hooks/use-products";
import { recordAdjustment } from "@/lib/store";
import { Button, Field, Input, Money, Notice } from "@/components/ui";
import { qty } from "@/lib/format";
import type { AdjustmentReason, Product } from "@/lib/types";

/**
 * Stock adjustments — the screen that was missing.
 *
 * Without it a shop drifts permanently: every spoilt loaf and every miscount
 * is an error the system can never absorb, and the stock figure decays until
 * nobody trusts it.
 *
 * The recount takes an ABSOLUTE count, not a difference. Someone standing at a
 * shelf knows "there are 14"; making them work out "that is 3 fewer than the
 * app thinks" is how you get wrong data entered confidently.
 */

const REASONS: Array<{
  key: AdjustmentReason;
  label: string;
  blurb: string;
  prompt: string;
}> = [
  {
    key: "adjustment",
    label: "Recount",
    blurb: "I counted the shelf and the number is wrong",
    prompt: "How many are actually there?",
  },
  {
    key: "damage",
    label: "Damaged",
    blurb: "Spoilt, broken or expired",
    prompt: "How many are damaged?",
  },
  {
    key: "loss",
    label: "Lost or stolen",
    blurb: "Missing and not sold",
    prompt: "How many are missing?",
  },
];

export default function AdjustStockPage() {
  const products = useProducts();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Product | null>(null);
  const [reason, setReason] = useState<AdjustmentReason>("adjustment");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => p.track_stock !== false)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .slice(0, 30);
  }, [products, search]);

  // Keep the picked product's stock live — another tab may have sold one.
  const current = picked ? (products ?? []).find((p) => p.id === picked.id) ?? picked : null;

  const num = Number(value);
  const valid = value !== "" && !Number.isNaN(num) && (reason === "adjustment" ? num >= 0 : num > 0);
  const resulting = current
    ? reason === "adjustment"
      ? num
      : Math.max(0, current.quantity - Math.abs(num))
    : 0;
  const delta = current ? resulting - current.quantity : 0;

  function pick(p: Product) {
    setPicked(p);
    setValue("");
    setNote("");
    setError(null);
    setDone(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const after = await recordAdjustment({
        product_id: current.id,
        reason,
        value: num,
        note: note.trim() || null,
      });
      setDone(`${current.name} is now ${qty(after)} ${current.unit}`);
      setPicked(null);
      setValue("");
      setNote("");
      setSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const chosen = REASONS.find((r) => r.key === reason)!;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-bold lg:text-3xl">Adjust stock</h1>
        <p className="mt-1 text-sm text-muted">
          Correct a wrong count, or write off stock that was damaged or went missing. Every
          adjustment is recorded — nothing is quietly overwritten.
        </p>
      </div>

      {done && <Notice tone="cash">{done}</Notice>}

      {!current ? (
        <>
          <Input
            placeholder="Search product"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            inputMode="search"
            autoFocus
          />
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => pick(p)}
                  className="flex min-h-16 w-full items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3 text-left transition-colors lg:hover:border-brand"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="text-sm text-muted">
                      <Money value={p.selling_price} /> / {p.unit}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-lg font-bold">{qty(p.quantity)}</span>
                </button>
              </li>
            ))}
          </ul>
          {filtered.length === 0 && (
            <p className="py-8 text-center text-muted">No stock-tracked products match.</p>
          )}
        </>
      ) : (
        <form onSubmit={submit} className="flex w-full max-w-xl flex-col gap-4">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="text-lg font-bold">{current.name}</div>
            <div className="text-sm text-muted">
              App says <span className="tabular font-semibold">{qty(current.quantity)}</span>{" "}
              {current.unit} in stock
            </div>
          </div>

          <Field label="What happened?">
            <div className="flex flex-col gap-2">
              {REASONS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => {
                    setReason(r.key);
                    setValue("");
                  }}
                  className={`min-h-14 rounded-xl border px-4 py-2 text-left ${
                    reason === r.key
                      ? "border-brand bg-brand-soft text-brand-dark"
                      : "border-line bg-surface text-ink"
                  }`}
                >
                  <span className="block font-semibold">{r.label}</span>
                  <span className="block text-sm text-muted">{r.blurb}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label={chosen.prompt}>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              required
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="tabular h-16 text-3xl font-bold"
            />
          </Field>

          {valid && (
            <div
              className={`rounded-xl px-4 py-3 text-base ${
                delta === 0
                  ? "bg-canvas text-muted"
                  : delta > 0
                    ? "bg-cash-soft text-cash-dark"
                    : "bg-danger-soft text-danger"
              }`}
            >
              {delta === 0 ? (
                "That matches what the app already says — nothing will be recorded."
              ) : (
                <>
                  Stock goes from <strong className="tabular">{qty(current.quantity)}</strong> to{" "}
                  <strong className="tabular">{qty(resulting)}</strong>{" "}
                  <span className="tabular">
                    ({delta > 0 ? "+" : ""}
                    {qty(delta)})
                  </span>
                </>
              )}
            </div>
          )}

          <Field label="Note" hint="Optional. Why the count changed.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={reason === "damage" ? "e.g. milk went sour" : "e.g. end of month count"}
            />
          </Field>

          {error && <Notice>{error}</Notice>}

          <Button type="submit" size="lg" disabled={busy || !valid || delta === 0}>
            Record adjustment
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPicked(null)}>
            Pick a different product
          </Button>
        </form>
      )}

      <Button variant="ghost" onClick={() => router.push("/products")}>
        Back to products
      </Button>
    </div>
  );
}
