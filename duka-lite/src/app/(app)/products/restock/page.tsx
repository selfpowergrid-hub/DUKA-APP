"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProducts } from "@/hooks/use-products";
import { recordMovement } from "@/lib/store";
import { Button, Field, Input, Money, Notice } from "@/components/ui";
import { qty, todayInNairobi } from "@/lib/format";
import type { Product } from "@/lib/types";

type CostMode = "unit" | "total";

export default function RestockPage() {
  const products = useProducts();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Product | null>(null);
  const [received, setReceived] = useState("");
  const [costMode, setCostMode] = useState<CostMode>("unit");
  const [unitCost, setUnitCost] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [date, setDate] = useState(todayInNairobi());
  const [ref, setRef] = useState("");
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

  // Live, so a sale on another device does not leave a stale "currently".
  const current = picked ? (products ?? []).find((p) => p.id === picked.id) ?? picked : null;

  const receivedNum = Number(received) || 0;

  // A duka owner is handed an invoice reading "25 packets, KES 4,375", not
  // "KES 175 each". Let them enter whichever they were actually told and
  // derive the other, rather than making them divide in their head.
  const derivedUnit =
    costMode === "unit"
      ? Number(unitCost) || 0
      : receivedNum > 0
        ? (Number(totalCost) || 0) / receivedNum
        : 0;
  const derivedTotal =
    costMode === "total" ? Number(totalCost) || 0 : (Number(unitCost) || 0) * receivedNum;

  const newTotal = current ? current.quantity + receivedNum : 0;

  function pick(p: Product) {
    setPicked(p);
    setCostMode("unit");
    setUnitCost(String(p.buying_price || ""));
    setTotalCost("");
    setReceived("");
    setRef("");
    setDate(todayInNairobi());
    setError(null);
    setDone(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      if (!receivedNum || receivedNum <= 0) throw new Error("Enter the quantity received");

      // Backdating keeps the delivery on the day it actually arrived. Noon
      // Nairobi (09:00Z) so the business date can never slide either way.
      const createdAt =
        date === todayInNairobi()
          ? new Date().toISOString()
          : new Date(`${date}T09:00:00.000Z`).toISOString();

      await recordMovement({
        product_id: current.id,
        delta: receivedNum,
        reason: "restock",
        buying_price: derivedUnit > 0 ? Math.round(derivedUnit * 100) / 100 : current.buying_price,
        total_cost: derivedTotal > 0 ? derivedTotal : null,
        note_ref: ref.trim() || null,
        created_at: createdAt,
      });

      setDone(
        `Added ${qty(receivedNum)} ${current.unit} of ${current.name}. Now ${qty(newTotal)} in stock.`,
      );
      setPicked(null);
      setReceived("");
      setSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-2xl font-bold lg:text-3xl">Restock</h1>

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
                      buying <Money value={p.buying_price} />
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-lg font-bold">{qty(p.quantity)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <form onSubmit={submit} className="flex w-full max-w-xl flex-col gap-4">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="text-lg font-bold">{current.name}</div>
            <div className="text-sm text-muted">
              Currently <span className="tabular font-semibold">{qty(current.quantity)}</span>{" "}
              {current.unit} in stock
            </div>
          </div>

          <Field label={`Quantity received (${current.unit})`}>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              required
              autoFocus
              value={received}
              onChange={(e) => setReceived(e.target.value)}
              className="tabular h-16 text-3xl font-bold"
            />
          </Field>

          {/* The arithmetic that removes all doubt about what was received. */}
          {receivedNum > 0 && (
            <p className="rounded-xl bg-brand-soft px-4 py-3 text-base text-brand-dark">
              <span className="tabular">{qty(current.quantity)}</span> +{" "}
              <span className="tabular">{qty(receivedNum)}</span> ={" "}
              <strong className="tabular">
                {qty(newTotal)} {current.unit}
              </strong>{" "}
              in stock
            </p>
          )}

          <Field label="Cost">
            <div className="mb-2 grid grid-cols-2 gap-2">
              {(
                [
                  ["unit", `Price per ${current.unit}`],
                  ["total", "Total paid"],
                ] as Array<[CostMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setCostMode(mode)}
                  className={`min-h-12 rounded-xl border px-3 text-base font-semibold ${
                    costMode === mode
                      ? "border-brand bg-brand text-white"
                      : "border-line bg-surface text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {costMode === "unit" ? (
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
              />
            ) : (
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                placeholder="what the invoice says"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
              />
            )}
          </Field>

          {receivedNum > 0 && (derivedUnit > 0 || derivedTotal > 0) && (
            <p className="text-base text-muted">
              {costMode === "unit" ? (
                <>
                  Total cost: <Money value={derivedTotal} className="font-bold text-ink" />
                </>
              ) : (
                <>
                  That is <Money value={derivedUnit} className="font-bold text-ink" /> per{" "}
                  {current.unit}
                </>
              )}
              {current.selling_price > 0 && derivedUnit > 0 && (
                <>
                  {" · "}
                  selling at <Money value={current.selling_price} /> leaves{" "}
                  <Money
                    value={current.selling_price - derivedUnit}
                    className={
                      current.selling_price - derivedUnit >= 0
                        ? "font-semibold text-cash-dark"
                        : "font-semibold text-danger"
                    }
                  />{" "}
                  each
                </>
              )}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date received" hint="Change it if this arrived on an earlier day.">
              <Input
                type="date"
                max={todayInNairobi()}
                value={date}
                onChange={(e) => setDate(e.target.value || todayInNairobi())}
              />
            </Field>
            <Field label="Reference" hint="Optional. Invoice or delivery note number.">
              <Input value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
          </div>

          {error && <Notice>{error}</Notice>}

          <Button type="submit" size="lg" disabled={busy}>
            Add to stock
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
