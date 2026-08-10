"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveCategory, saveProduct, saveUnit, setProductActive } from "@/lib/store";
import type { Product, ProductUnit } from "@/lib/types";
import { Button, Field, Input, Money, Notice } from "@/components/ui";
import { ProductPhoto } from "@/components/product-photo";
import { qty } from "@/lib/format";
import { useCategories } from "@/hooks/use-categories";
import { useGroupNames, usePortions, useUnits } from "@/hooks/use-catalog";

interface PortionDraft {
  id?: string;
  name: string;
  factor: string;
  price: string;
}

export function ProductForm({ product }: { product?: Product }) {
  const router = useRouter();
  const categories = useCategories();
  const units = useUnits();
  const groupNames = useGroupNames();
  const existingPortions = usePortions(product?.id);

  const [name, setName] = useState(product?.name ?? "");
  const [unit, setUnit] = useState<ProductUnit>(product?.unit ?? "pc");
  const [buying, setBuying] = useState(String(product?.buying_price ?? ""));
  const [selling, setSelling] = useState(String(product?.selling_price ?? ""));
  const [threshold, setThreshold] = useState(String(product?.low_stock_threshold ?? "5"));
  const [categoryId, setCategoryId] = useState<string>(product?.category_id ?? "");
  const [newCategory, setNewCategory] = useState("");
  const [trackStock, setTrackStock] = useState(product?.track_stock ?? true);
  const [trackBatches, setTrackBatches] = useState(product?.track_batches ?? false);
  const [isPom, setIsPom] = useState(product?.is_pom ?? false);
  const [groupName, setGroupName] = useState(product?.group_name ?? "");
  const [newUnit, setNewUnit] = useState("");
  const [newUnitFractional, setNewUnitFractional] = useState(false);
  const [addingUnit, setAddingUnit] = useState(false);
  const [portions, setPortions] = useState<PortionDraft[]>([]);
  const [portionsLoaded, setPortionsLoaded] = useState(false);
  const [opening, setOpening] = useState("");
  const [openingCost, setOpeningCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isNew = !product;

  // Derive the editable list from what is stored until the user touches it.
  // Avoids a setState-in-effect and keeps the list live until first edit.
  const portionRows: PortionDraft[] = portionsLoaded
    ? portions
    : existingPortions.map((p) => ({
        id: p.id,
        name: p.name,
        factor: String(p.factor),
        price: String(p.price),
      }));

  function editPortions(next: PortionDraft[]) {
    setPortions(next);
    setPortionsLoaded(true);
  }

  const unitMeta = units.find((u) => u.code === unit);
  const fractional = unitMeta?.is_fractional ?? false;
  const openingNum = Number(opening) || 0;
  const buyingNum = Number(buying) || 0;
  const sellingNum = Number(selling) || 0;
  const margin = sellingNum - buyingNum;

  // What the shelf is worth. This is the best typo-catcher on the form — an
  // owner knows instantly whether their stock is worth seven thousand or
  // seventy thousand shillings.
  const openingValue = Number(openingCost) || openingNum * buyingNum;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let finalCategoryId: string | null = categoryId || null;
      if (newCategory.trim()) {
        finalCategoryId = (await saveCategory(newCategory)).id;
      }

      await saveProduct({
        id: product?.id,
        name,
        unit,
        buying_price: buyingNum,
        selling_price: sellingNum,
        low_stock_threshold: Number(threshold) || 0,
        category_id: finalCategoryId,
        track_stock: trackStock,
        // Batches are meaningless without a count to attach them to.
        track_batches: trackStock && trackBatches,
        is_pom: isPom,
        group_name: groupName.trim() || null,
        portions: portionRows
          .filter((p) => p.name.trim())
          .map((p) => ({
            id: p.id,
            name: p.name.trim(),
            factor: Number(p.factor) || 0,
            price: Number(p.price) || 0,
          })),
        opening_quantity: isNew && trackStock ? openingNum : 0,
        opening_total_cost: Number(openingCost) || null,
      });
      router.push("/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!product) return;
    setBusy(true);
    try {
      await setProductActive(product.id, !product.is_active);
      router.push("/products");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-2xl font-bold lg:text-3xl">
        {product ? "Edit product" : "New product"}
      </h1>

      <Field label="Name">
        <Input required autoFocus={isNew} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {/* Only on edit. A photo belongs to a product, and on a new product there
          is nothing to attach it to yet — the form would have to hold the image
          in memory and write it after save, which is a second failure path for
          a decorative field. The form tells the owner that instead. */}
      <Field label="Photo" hint="Optional. Appears on the Sell screen to help find the item.">
        <ProductPhoto productId={product?.id} />
      </Field>

      <Field label="Category" hint="Optional. Helps you find things once you have a lot of stock.">
        <div className="flex flex-col gap-2">
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setCategoryId("");
                  setNewCategory("");
                }}
                className={`min-h-12 rounded-xl border px-4 text-base font-semibold ${
                  !categoryId && !newCategory.trim()
                    ? "border-brand bg-brand text-white"
                    : "border-line bg-surface text-ink"
                }`}
              >
                None
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setCategoryId(c.id);
                    setNewCategory("");
                  }}
                  className={`min-h-12 rounded-xl border px-4 text-base font-semibold ${
                    categoryId === c.id
                      ? "border-brand bg-brand text-white"
                      : "border-line bg-surface text-ink"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <Input
            placeholder={categories.length ? "…or type a new category" : "e.g. Flour, Soap, Fresh"}
            value={newCategory}
            onChange={(e) => {
              setNewCategory(e.target.value);
              if (e.target.value.trim()) setCategoryId("");
            }}
          />
        </div>
      </Field>

      <Field
        label="Unit"
        hint={
          fractional
            ? "This unit can be sold in halves — the till will accept 0.5."
            : "Sold as whole items."
        }
      >
        <div className="flex flex-wrap gap-2">
          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => setUnit(u.code as ProductUnit)}
              title={u.label}
              className={`min-h-12 rounded-xl border px-4 text-base font-semibold ${
                unit === u.code
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface text-ink"
              }`}
            >
              {u.code}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAddingUnit((v) => !v)}
            className="min-h-12 rounded-xl border border-dashed border-line bg-surface px-4 text-base font-semibold text-muted"
          >
            + unit
          </button>
        </div>

        {addingUnit && (
          <div className="mt-2 flex flex-col gap-2 rounded-xl bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="e.g. gunia, tray, debe"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value)}
                className="flex-1 min-w-40"
              />
              <Button
                type="button"
                variant="neutral"
                onClick={async () => {
                  const code = newUnit.trim().toLowerCase();
                  if (!code) return;
                  await saveUnit({ code, label: newUnit.trim(), is_fractional: newUnitFractional });
                  setUnit(code);
                  setNewUnit("");
                  setNewUnitFractional(false);
                  setAddingUnit(false);
                }}
              >
                Add
              </Button>
            </div>
            {/* Without this a new unit could never be sold in halves — there was
                previously no way to mark a custom unit as fractional at all. */}
            <label className="flex min-h-12 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={newUnitFractional}
                onChange={(e) => setNewUnitFractional(e.target.checked)}
                className="h-5 w-5 accent-[var(--color-brand)]"
              />
              Can be sold in halves (e.g. 2.5)
            </label>
          </div>
        )}
      </Field>

      <Field
        label="Pack group"
        hint="Optional. Sizes of the same product — Rina 1L, 5L, 10L — keep separate stock but sit together."
      >
        <Input
          list="duka-group-names"
          placeholder="e.g. Rina cooking oil"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
        />
        <datalist id="duka-group-names">
          {groupNames.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Buying price">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={buying}
            onChange={(e) => setBuying(e.target.value)}
          />
        </Field>
        <Field label="Selling price">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            required
            value={selling}
            onChange={(e) => setSelling(e.target.value)}
          />
        </Field>
      </div>

      {margin !== 0 && buyingNum > 0 && (
        <p className={`text-sm ${margin > 0 ? "text-cash-dark" : "text-danger"}`}>
          Profit per {unit}: <Money value={margin} className="font-semibold" />
          {sellingNum > 0 && ` (${Math.round((margin / sellingNum) * 100)}% margin)`}
        </p>
      )}

      {/* ------------------------------------------------- stock tracking --- */}
      <div className="rounded-2xl border border-line bg-surface p-4">
        <Switch
          checked={trackStock}
          onChange={() => setTrackStock((v) => !v)}
          label="Track stock"
          hint="Turn off for things with no count — airtime, a carrier bag."
        />

        {/* Batch tracking is opt-in per product, not shop-wide. A chemist also
            sells cotton wool and razor blades, and demanding a batch number for
            those trains staff to type rubbish into the one field that has to be
            trustworthy. */}
        {trackStock && (
          <div className="mt-3 border-t border-line pt-3">
            <Switch
              checked={trackBatches}
              onChange={() => setTrackBatches((v) => !v)}
              label="Track batches and expiry"
              hint="For medicines and anything that expires. Every delivery then needs a batch number and expiry date, and the oldest-expiring stock is dispensed first."
            />
          </div>
        )}

        <div className="mt-3 border-t border-line pt-3">
          <Switch
            checked={isPom}
            onChange={() => setIsPom((v) => !v)}
            label="Prescription only"
            hint="Warns at the till that this must not be sold over the counter."
          />
        </div>

        {trackStock && (
          <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
            {isNew ? (
              <>
                <Field
                  label={`Opening stock (${unit})`}
                  hint="How many are on the shelf right now. Leave blank to start at zero."
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    placeholder="0"
                    value={opening}
                    onChange={(e) => setOpening(e.target.value)}
                  />
                </Field>

                {openingNum > 0 && (
                  <>
                    <Field
                      label="What that stock cost in total"
                      hint="Optional. Leave blank and we work it out from the buying price."
                    >
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="1"
                        placeholder={buyingNum ? String(Math.round(openingNum * buyingNum)) : "0"}
                        value={openingCost}
                        onChange={(e) => setOpeningCost(e.target.value)}
                      />
                    </Field>

                    {openingValue > 0 && (
                      <p className="rounded-xl bg-brand-soft px-4 py-3 text-base text-brand-dark">
                        Starting with{" "}
                        <strong>
                          {qty(openingNum)} {unit}
                        </strong>{" "}
                        worth <Money value={openingValue} className="font-bold" />
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">
                Stock on hand: <strong className="tabular">{qty(product.quantity)}</strong>{" "}
                {product.unit}. Stock only changes through sales, restocks and adjustments —
                never by editing this form.
              </p>
            )}

            {/* ------------------------------------------- portions --- */}
            <div className="border-t border-line pt-4">
              <h3 className="font-semibold">Sell in measures</h3>
              <p className="mb-3 text-sm text-muted">
                For stock you measure out of one container — a drum of oil sold by the ½ litre.
                All measures draw from the same {unit || "unit"} count. Leave this empty if you
                sell this product whole.
              </p>

              {portionRows.length > 0 && (
                <ul className="mb-3 flex flex-col gap-2">
                  <li className="grid grid-cols-[1fr_5rem_5.5rem_3rem] gap-2 text-xs text-muted">
                    <span>Name</span>
                    <span>{unit || "units"}</span>
                    <span>Price</span>
                    <span />
                  </li>
                  {portionRows.map((p, i) => (
                    <li key={i} className="grid grid-cols-[1fr_5rem_5.5rem_3rem] gap-2">
                      <Input
                        placeholder="½ litre"
                        value={p.name}
                        onChange={(e) =>
                          editPortions(
                            portionRows.map((r, j) =>
                              j === i ? { ...r, name: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        placeholder="0.5"
                        value={p.factor}
                        onChange={(e) =>
                          editPortions(
                            portionRows.map((r, j) =>
                              j === i ? { ...r, factor: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <Input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="1"
                        placeholder="120"
                        value={p.price}
                        onChange={(e) =>
                          editPortions(
                            portionRows.map((r, j) =>
                              j === i ? { ...r, price: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${p.name || "measure"}`}
                        onClick={() => editPortions(portionRows.filter((_, j) => j !== i))}
                        className="min-h-12 rounded-xl text-2xl text-danger"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <Button
                type="button"
                variant="neutral"
                onClick={() =>
                  editPortions([...portionRows, { name: "", factor: "", price: "" }])
                }
              >
                + Add a measure
              </Button>

              {portionRows.some((p) => Number(p.factor) > 0) && (
                <p className="mt-2 text-sm text-muted">
                  Selling one{" "}
                  <strong>{portionRows.find((p) => Number(p.factor) > 0)!.name || "measure"}</strong>{" "}
                  takes{" "}
                  <strong>
                    {qty(Number(portionRows.find((p) => Number(p.factor) > 0)!.factor))} {unit}
                  </strong>{" "}
                  off the count.
                </p>
              )}
            </div>

            <Field
              label="Low stock alert at"
              hint="You will see this product in the low-stock list at or below this number."
            >
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
          </div>
        )}
      </div>

      {error && <Notice>{error}</Notice>}

      <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center">
        <Button type="submit" size="lg" disabled={busy} className="sm:flex-1">
          {isNew ? "Add product" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} className="sm:w-32">
          Cancel
        </Button>
      </div>

      {product && (
        <Button type="button" variant="neutral" onClick={toggleActive} disabled={busy}>
          {product.is_active ? "Deactivate (hide from Sell)" : "Reactivate"}
        </Button>
      )}
    </form>
  );
}

/**
 * A real 48px switch, not a 28px native checkbox — this is a till operated with
 * thumbs, and the responsive check fails anything under 44px.
 */
function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="flex min-h-12 w-full items-center justify-between gap-3 text-left"
    >
      <span className="min-w-0">
        <span className="block font-semibold">{label}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
      <span
        className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${
          checked ? "bg-brand" : "bg-line"
        }`}
      >
        <span
          className={`absolute top-1 h-6 w-6 rounded-full bg-surface transition-all ${
            checked ? "left-7" : "left-1"
          }`}
        />
      </span>
    </button>
  );
}
