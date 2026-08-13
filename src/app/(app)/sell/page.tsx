"use client";

import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { useProducts, isLowStock } from "@/hooks/use-products";
import { useCategories } from "@/hooks/use-categories";
import { usePortionsByProduct, useUnits } from "@/hooks/use-catalog";
import { Thumb, useProductImages } from "@/components/product-photo";
import { checkout, saveCustomer } from "@/lib/store";
import { customerDebt, customerSummaries } from "@/lib/debt";
import { Button, Input, Notice, PaymentTag } from "@/components/ui";
import { money, qty, todayInNairobi } from "@/lib/format";
import type {
  CartLine,
  PaymentMethod,
  Product,
  ProductPortion,
  RepaymentMethod,
} from "@/lib/types";

type Stage = "cart" | "pom" | "pay" | "cash" | "mpesa" | "credit" | "done";

/**
 * Responsive shape of the till:
 *
 *   < lg   one thing at a time. Tapping Charge replaces the product grid with
 *          the payment step, because on a phone there is no room for both and
 *          a modal over a checkout is worse than a page.
 *   >= lg  the grid never leaves. The whole sale — cart, payment, change due —
 *          happens in a column beside it, so the attendant can keep adding
 *          items right up to the moment they take the money.
 *
 * Either way there are no modals during checkout.
 */
export default function SellPage() {
  const products = useProducts();
  const categories = useCategories();
  const units = useUnits();
  const portionsByProduct = usePortionsByProduct();
  const photos = useProductImages();
  const [category, setCategory] = useState("");
  /** Which portioned tile is currently showing its measures. */
  const [openPortions, setOpenPortions] = useState<string | null>(null);
  /** Which cart line is having its quantity typed. */
  const [editingQty, setEditingQty] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState("");
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [stage, setStage] = useState<Stage>("cart");
  const [tendered, setTendered] = useState("");
  const [mpesaCode, setMpesaCode] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  /** Money handed over at the counter on a credit sale. "" means none. */
  const [paidNow, setPaidNow] = useState("");
  const [paidNowMethod, setPaidNowMethod] = useState<RepaymentMethod>("cash");
  const [paidNowCode, setPaidNowCode] = useState("");
  /** Prescription details, required when the cart holds a POM product. */
  const [patient, setPatient] = useState("");
  const [prescriber, setPrescriber] = useState("");
  const [rxRef, setRxRef] = useState("");
  const [patientPhone, setPatientPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    total: number;
    method: PaymentMethod;
    change: number;
    code: string | null;
    customerName?: string | null;
    newBalance?: number;
    /** Cash or M-Pesa taken at the counter against a credit sale. */
    paidNow?: number;
    paidNowMethod?: RepaymentMethod;
  } | null>(null);
  const busy = useRef(false);

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + l.unit_price * l.quantity, 0),
    [lines],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => !category || p.category_id === category)
      .filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [products, search, category]);

  /**
   * A cart key is product + portion, not product alone: "half litre" and
   * "5 litres" of the same drum are two lines at two prices, and merging them
   * would misprice the sale.
   */
  const keyOf = (l: CartLine) => `${l.product_id}::${l.portion_id ?? ""}`;

  function isFractional(p: Product) {
    return units.find((u) => u.code === p.unit)?.is_fractional ?? false;
  }

  function addProduct(p: Product, portion?: ProductPortion) {
    // Adding to the cart mid-payment would silently change the amount the
    // customer was just quoted. Go back to the cart first.
    if (stage === "done") reset();
    else if (stage !== "cart") setStage("cart");

    const key = `${p.id}::${portion?.id ?? ""}`;
    // Fractional goods step by 0.5: you cannot tap "+" your way to 2.5 kg.
    const step = portion ? 1 : isFractional(p) ? 0.5 : 1;

    setLines((prev) => {
      const found = prev.find((l) => keyOf(l) === key);
      if (found) {
        return prev.map((l) =>
          keyOf(l) === key ? { ...l, quantity: round3(l.quantity + step) } : l,
        );
      }
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          unit: p.unit,
          unit_price: portion ? portion.price : p.selling_price,
          quantity: step,
          portion_id: portion?.id ?? null,
          portion_name: portion?.name ?? null,
          portion_factor: portion?.factor ?? null,
          fractional: portion ? false : isFractional(p),
        },
      ];
    });
  }

  function setQuantity(key: string, next: number) {
    setLines((prev) =>
      next <= 0
        ? prev.filter((l) => keyOf(l) !== key)
        : prev.map((l) => (keyOf(l) === key ? { ...l, quantity: round3(next) } : l)),
    );
  }

  function commitQtyDraft(key: string) {
    const n = Number(qtyDraft);
    if (qtyDraft !== "" && !Number.isNaN(n)) setQuantity(key, n);
    setEditingQty(null);
    setQtyDraft("");
  }

  function reset() {
    setLines([]);
    setStage("cart");
    setTendered("");
    setMpesaCode("");
    setCustomerId(null);
    setCustomerSearch("");
    setNewCustomerPhone("");
    setPaidNow("");
    setPaidNowMethod("cash");
    setPaidNowCode("");
    setPatient("");
    setPrescriber("");
    setRxRef("");
    setPatientPhone("");
    setError(null);
    setReceipt(null);
  }

  /**
   * One IndexedDB transaction, no network. This is the path that must finish
   * in well under a second with the radio off.
   */
  async function confirm(method: PaymentMethod) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const tenderedNum = Number(tendered) || 0;
      const partNum = method === "credit" ? Number(paidNow) || 0 : 0;
      const sale = await checkout({
        lines,
        payment_method: method,
        amount_tendered: method === "cash" ? tenderedNum : undefined,
        mpesa_code: method === "mpesa" ? mpesaCode : undefined,
        customer_id: method === "credit" ? (customerId ?? undefined) : undefined,
        paid_now: partNum > 0 ? partNum : undefined,
        paid_now_method: partNum > 0 ? paidNowMethod : undefined,
        paid_now_mpesa_code: partNum > 0 ? paidNowCode : undefined,
        dispensing: hasPom
          ? {
              patient_name: patient,
              prescriber,
              prescription_ref: rxRef || null,
              patient_phone: patientPhone || null,
            }
          : undefined,
      });

      // For credit, the useful number on the receipt is not the change — it is
      // what this person now owes in total.
      let customerName: string | null = null;
      let newBalance: number | undefined;
      if (method === "credit" && sale.customer_id) {
        const after = await customerDebt(sale.customer_id);
        customerName = after?.customer.name ?? null;
        newBalance = after?.balance;
      }

      setReceipt({
        total: sale.total,
        method,
        change: method === "cash" ? tenderedNum - sale.total : 0,
        code: sale.mpesa_code,
        customerName,
        newBalance,
        paidNow: partNum > 0 ? partNum : undefined,
        paidNowMethod: partNum > 0 ? paidNowMethod : undefined,
      });
      setLines([]);
      setTendered("");
      setMpesaCode("");
      setPaidNow("");
      setPaidNowCode("");
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the sale");
    } finally {
      busy.current = false;
    }
  }

  const tenderedNum = Number(tendered) || 0;
  const change = tenderedNum - total;
  const enough = tenderedNum >= total;
  const code = mpesaCode.trim().toUpperCase();

  // The same code typed twice in one day is far more likely a mistake — one
  // sale confirmed on the phone twice, or the previous customer's SMS still
  // on screen — than a genuine coincidence. Never blocks: the brief already
  // rules out checking a code against Safaricom, and a duplicate customer
  // code (a repeat buyer, same till number) is not actually impossible.
  // Every debtor, so the picker can show what someone already owes BEFORE the
  // attendant commits more credit to them. That number at the moment of
  // decision is the whole point of the feature.
  const debtorRows = useLiveQuery(async () => customerSummaries(), []);
  const allDebtors = useMemo(() => debtorRows ?? [], [debtorRows]);
  const chosenCustomer = customerId
    ? (allDebtors.find((d) => d.customer.id === customerId) ?? null)
    : null;

  const matchingCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    return allDebtors
      .filter((d) => d.customer.is_active)
      .filter(
        (d) =>
          !q ||
          d.customer.name.toLowerCase().includes(q) ||
          (d.customer.phone ?? "").includes(q),
      )
      .slice(0, 20);
  }, [allDebtors, customerSearch]);

  // A limit is a WARNING, never a lock. Two devices can each approve credit
  // that combined breaches the limit and neither can see the other — the same
  // class of race as overselling. Blocking on a stale local balance would
  // refuse legitimate credit to someone who settled up on the other till an
  // hour ago, which is worse than the overshoot.
  // A prescription-only item in the cart makes the record compulsory, so the
  // till routes through a step rather than relying on anyone remembering.
  const pomInCart = lines.filter((l) => (products ?? []).find((p) => p.id === l.product_id)?.is_pom);
  const hasPom = pomInCart.length > 0;
  const rxReady = patient.trim().length > 0 && prescriber.trim().length > 0;

  // Drives the phone layout: once there is a sale in progress, the picker
  // gives up room to it.
  const cartHasItems = stage === "cart" && lines.length > 0;

  const partNum = Number(paidNow) || 0;
  // Blocks the button rather than failing at checkout, and says the useful
  // thing: a "part"-payment that covers everything is just a cash sale.
  const partPaymentProblem = (() => {
    if (partNum <= 0) return null;
    if (partNum >= total) return "That covers the whole sale — go back and take it as Cash or M-Pesa.";
    if (paidNowMethod === "mpesa" && !paidNowCode.trim()) return "Enter the M-Pesa code.";
    return null;
  })();

  const overLimitWarning = (() => {
    if (!chosenCustomer) return null;
    const limit = chosenCustomer.customer.credit_limit;
    const after = chosenCustomer.balance + total;
    if (limit != null && after > limit) {
      return `This puts ${chosenCustomer.customer.name} at ${money(after)}, over their ${money(limit)} limit.`;
    }
    if (chosenCustomer.oldestDays > 30) {
      return `${chosenCustomer.customer.name} has debt ${chosenCustomer.oldestDays} days old already.`;
    }
    return null;
  })();

  const mpesaDupe = useLiveQuery(async () => {
    if (code.length < 6) return undefined;
    const today = todayInNairobi();
    const todaysSales = await db.sales.where("business_date").equals(today).toArray();
    return todaysSales.find((s) => s.mpesa_code === code);
  }, [code]);

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start lg:gap-6 lg:p-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
      {/* ------------------------------------------------------ catalogue --- */}
      <section className={stage === "cart" ? "" : "hidden lg:block"}>
        <div className="sticky top-12 z-[5] bg-canvas px-4 pt-3 pb-2 lg:static lg:p-0 lg:pb-3">
          <Input
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            inputMode="search"
          />

          {categories.length > 0 && (
            <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
              {[{ id: "", name: "All" }, ...categories].map((c) => (
                <button
                  key={c.id || "all"}
                  onClick={() => setCategory(category === c.id ? "" : c.id)}
                  className={`min-h-12 shrink-0 rounded-full border px-4 text-base font-semibold whitespace-nowrap ${
                    category === c.id
                      ? "border-brand bg-brand text-white"
                      : "border-line bg-surface text-muted"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Two things happen on a phone once the cart has something in it.

            The tiles shrink — 7rem instead of 9.5rem — so roughly twice as
            many products are reachable without scrolling. Finding the next
            item is the most repeated action at a till, and every scroll is
            a customer waiting.

            And the grid stops growing, capping at about a third of the
            screen with its own scroll, so the running sale below it stays on
            screen instead of being pushed off by a long catalogue. An empty
            cart keeps the full height, because there is nothing underneath
            worth protecting. Desktop is untouched: it has a side panel and
            no shortage of room. */}
        <div
          className={`grid gap-2 px-4 pb-4 sm:gap-3 lg:px-0 lg:pb-0 ${
            cartHasItems
              ? "max-h-[38dvh] grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] overflow-y-auto overscroll-contain sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] lg:max-h-none lg:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] lg:overflow-visible"
              : "grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]"
          }`}
        >
          {filtered.map((p) => {
            const measures = portionsByProduct.get(p.id) ?? [];
            const carted = lines
              .filter((l) => l.product_id === p.id)
              .reduce((n, l) => n + l.quantity, 0);
            const open = openPortions === p.id;

            return (
              <div key={p.id} className={open ? "col-span-full" : ""}>
                <button
                  onClick={() =>
                    measures.length ? setOpenPortions(open ? null : p.id) : addProduct(p)
                  }
                  className={`relative flex min-h-24 w-full flex-col justify-between gap-1.5 rounded-2xl border-2 p-2.5 text-left shadow-sm sm:min-h-32 sm:gap-2 sm:p-3.5 transition-all active:scale-[0.97] active:shadow-none lg:hover:-translate-y-0.5 lg:hover:border-brand lg:hover:shadow-md ${
                    carted ? "border-brand bg-brand-soft shadow-md" : "border-line bg-surface"
                  }`}
                >
                  {/* The count badge sits ON the photo when there is one, and
                      only falls back to the tile corner when there is not.
                      Reserving corner space in both cases cost the name ~32px,
                      which on a tile already carrying a 40px thumbnail turned
                      "Blue Band 250g" into "Blue Band…" — losing the pack size,
                      which is precisely what a photo cannot tell you apart. */}
                  {carted > 0 && !photos.get(p.id) && (
                    <span className="tabular absolute top-2 right-2 z-[1] flex h-7 min-w-7 items-center justify-center rounded-full bg-brand px-1.5 text-sm font-bold text-white">
                      {qty(carted)}
                    </span>
                  )}
                  <span className="flex min-w-0 items-start gap-2">
                    {/* 40px, inline. Deliberately small: a photo card would
                        halve how many products fit on screen, and every sale
                        would gain a scroll. A product with no photo renders
                        exactly as it did before this feature existed. */}
                    {photos.get(p.id) && (
                      <span className="relative shrink-0">
                        <Thumb
                          src={photos.get(p.id)!}
                          className="h-10 w-10 rounded-lg object-cover"
                        />
                        {carted > 0 && (
                          <span className="tabular absolute -top-1.5 -right-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1 text-xs font-bold text-white ring-2 ring-brand-soft">
                            {qty(carted)}
                          </span>
                        )}
                      </span>
                    )}
                    <span
                      className={`line-clamp-2 min-w-0 text-sm leading-snug font-semibold sm:text-base ${
                        carted > 0 && !photos.get(p.id) ? "pr-8" : ""
                      }`}
                    >
                      {p.name}
                    </span>
                  </span>

                  <span className="flex items-end justify-between gap-2">
                    <span className="tabular text-lg leading-none font-bold sm:text-xl">
                      {measures.length
                        ? `${money(Math.min(...measures.map((m) => m.price)))}+`
                        : money(p.selling_price)}
                    </span>
                    {/* Stock on the tile. An attendant should not have to leave
                        the till to find out they are selling the last one. */}
                    {p.track_stock !== false && (
                      <span
                        className={`tabular shrink-0 text-xs font-semibold ${
                          isLowStock(p) ? "text-danger" : "text-muted"
                        }`}
                      >
                        {qty(p.quantity)} left
                      </span>
                    )}
                  </span>
                </button>

                {/* Measures drawn from ONE pool. Inline, never a modal. */}
                {open && (
                  <div className="mt-2 rounded-2xl border-2 border-brand bg-brand-soft p-3">
                    <p className="mb-2 text-sm text-brand-dark">
                      {qty(p.quantity)} {p.unit} left - pick a measure
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {measures.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => addProduct(p, m)}
                          className="min-h-14 rounded-xl border border-line bg-surface px-4 text-left"
                        >
                          <span className="block font-semibold">{m.name}</span>
                          <span className="tabular block text-sm text-muted">{money(m.price)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {products && products.length === 0 && (
          <p className="p-8 text-center text-muted">
            No products yet. Add some under Products.
          </p>
        )}
        {products && products.length > 0 && filtered.length === 0 && (
          <p className="p-8 text-center text-muted">Nothing matches &ldquo;{search}&rdquo;.</p>
        )}
      </section>

      {/* ----------------------------------------------------- till panel --- */}
      <aside className="lg:sticky lg:top-6 lg:self-start">
        {stage === "cart" && (
          <div className={lines.length ? "px-4 lg:px-0" : "hidden lg:block"}>
            <div className="rounded-2xl border border-line bg-surface p-3 shadow-sm lg:p-4 lg:shadow-md">
              <h2 className="mb-2 hidden text-lg font-bold lg:block">Current sale</h2>

              {lines.length === 0 ? (
                <p className="py-10 text-center text-muted">Tap a product to start a sale.</p>
              ) : (
                <ul className="flex max-h-[45vh] flex-col divide-y divide-line overflow-y-auto lg:max-h-[calc(100dvh-22rem)]">
                  {lines.map((l) => {
                    const key = keyOf(l);
                    const step = l.fractional ? 0.5 : 1;
                    return (
                      <li key={key} className="py-2.5">
                        {/* Name and money on their own row, controls beneath.
                            Squeezing all four onto one line wrapped the price
                            across three lines on a phone. */}
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate font-semibold">{l.name}</span>
                            {/* The measure is what tells two lines of the same
                                drum apart, so it must never be truncated. */}
                            {l.portion_name && (
                              <span className="shrink-0 rounded bg-brand-soft px-1.5 text-sm font-semibold text-brand-dark">
                                {l.portion_name}
                              </span>
                            )}
                          </span>
                          <span className="tabular shrink-0 font-bold">
                            {money(l.unit_price * l.quantity)}
                          </span>
                        </div>

                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <span className="tabular truncate text-sm text-muted">
                            {money(l.unit_price)} each
                            {l.portion_factor ? (
                              <span className="ml-1">
                                &#183; {qty(l.quantity * l.portion_factor)} {l.unit}
                              </span>
                            ) : null}
                          </span>

                          <span className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => setQuantity(key, l.quantity - step)}
                          aria-label={`Reduce ${l.name}`}
                          className="h-12 w-12 shrink-0 rounded-xl border border-line text-2xl leading-none font-bold active:bg-panel"
                        >
                          &#8722;
                        </button>

                        {/* Tap the number to type it. Without this a kg or
                            litre product cannot be sold in fractions at all. */}
                        {editingQty === key ? (
                          <input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min="0"
                            autoFocus
                            value={qtyDraft}
                            onChange={(e) => setQtyDraft(e.target.value)}
                            onBlur={() => commitQtyDraft(key)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitQtyDraft(key);
                              if (e.key === "Escape") {
                                setEditingQty(null);
                                setQtyDraft("");
                              }
                            }}
                            className="tabular h-12 w-16 shrink-0 rounded-xl border-2 border-brand bg-surface text-center text-lg font-bold outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => {
                              setEditingQty(key);
                              setQtyDraft(String(l.quantity));
                            }}
                            aria-label={`Type quantity for ${l.name}`}
                            className="tabular h-12 w-14 shrink-0 rounded-xl border border-dashed border-line text-center text-lg font-bold active:bg-panel"
                          >
                            {qty(l.quantity)}
                          </button>
                        )}

                        <button
                          onClick={() => setQuantity(key, l.quantity + step)}
                          aria-label={`Add ${l.name}`}
                          className="h-12 w-12 shrink-0 rounded-xl border border-line text-2xl leading-none font-bold active:bg-panel"
                        >
                          +
                        </button>
                        <button
                          onClick={() => setQuantity(key, 0)}
                          aria-label={`Remove ${l.name}`}
                          className="h-12 w-10 shrink-0 rounded-xl text-xl leading-none text-muted active:text-danger"
                        >
                          &#215;
                        </button>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* Desktop total + Charge. On smaller screens this is the pinned
                  bar below, which stays in thumb reach. */}
              {lines.length > 0 && (
                <div className="mt-3 hidden border-t border-line pt-3 lg:block">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-muted">
                      {lines.length} item{lines.length === 1 ? "" : "s"}
                    </span>
                    <span className="tabular text-3xl font-bold">{money(total)}</span>
                  </div>
                  <Button size="lg" className="mt-3 w-full" onClick={() => setStage("pay")}>
                    Charge
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {stage === "pom" && (
          <Panel>
            <TotalBar total={total} count={lines.length} />

            <div className="rounded-2xl border-2 border-warn/40 bg-warn-soft p-3">
              <p className="font-semibold">Prescription only</p>
              <p className="text-sm text-muted">
                {pomInCart.map((l) => l.name).join(", ")} must be recorded before it leaves the
                shop. This is kept as your dispensing register.
              </p>
            </div>

            <label className="block">
              <span className="mb-1 block text-base font-medium">Who is it for?</span>
              <Input
                autoFocus
                placeholder="Patient name"
                value={patient}
                onChange={(e) => setPatient(e.target.value)}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-base font-medium">Who prescribed it?</span>
              <Input
                placeholder="Doctor, clinic or hospital"
                value={prescriber}
                onChange={(e) => setPrescriber(e.target.value)}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-base font-medium">
                Prescription number{" "}
                <span className="font-normal text-muted">if it has one</span>
              </span>
              <Input value={rxRef} onChange={(e) => setRxRef(e.target.value)} />
            </label>

            <label className="block">
              <span className="mb-1 block text-base font-medium">
                Patient phone <span className="font-normal text-muted">optional</span>
              </span>
              <Input
                inputMode="tel"
                value={patientPhone}
                onChange={(e) => setPatientPhone(e.target.value)}
              />
            </label>

            {error && <Notice>{error}</Notice>}

            <Button size="xl" disabled={!rxReady} onClick={() => setStage("pay")}>
              {rxReady ? "Continue to payment" : "Name and prescriber are needed"}
            </Button>
            <Button variant="ghost" onClick={() => setStage("cart")}>
              Back to cart
            </Button>
          </Panel>
        )}

        {stage === "pay" && (
          <Panel>
            <TotalBar total={total} count={lines.length} />
            <p className="text-center text-lg text-muted">How did they pay?</p>

            {/* Two buttons, two colours, no dropdown, no modal. */}
            <Button
              variant="cash"
              size="xl"
              className="h-32 text-3xl lg:h-24 lg:text-2xl"
              onClick={() => setStage("cash")}
            >
              Cash
            </Button>
            <Button
              variant="mpesa"
              size="xl"
              className="h-32 text-3xl lg:h-24 lg:text-2xl"
              onClick={() => setStage("mpesa")}
            >
              M-Pesa
            </Button>

            {/* Credit is deliberately smaller and outlined, not a third
                equal-weight colour: it is not a way of being paid, it is a
                decision to not be paid yet. */}
            <Button
              variant="neutral"
              size="lg"
              className="border-dashed"
              onClick={() => setStage("credit")}
            >
              On credit (deni)
            </Button>

            <Button
              variant="ghost"
              onClick={() => setStage(hasPom ? "pom" : "cart")}
            >
              {hasPom ? "Back to the prescription" : "Back to cart"}
            </Button>
          </Panel>
        )}

        {stage === "credit" && (
          <Panel>
            <TotalBar total={total} count={lines.length} />

            {chosenCustomer ? (
              <div className="rounded-2xl border border-line bg-surface p-4">
                <p className="text-sm text-muted">Taking this on credit</p>
                <p className="text-xl font-bold">{chosenCustomer.customer.name}</p>
                {chosenCustomer.customer.phone && (
                  <p className="text-sm text-muted">{chosenCustomer.customer.phone}</p>
                )}
                <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-base">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted">Already owes</dt>
                    <dd className="tabular font-semibold">
                      {money(chosenCustomer.balance)}
                      {chosenCustomer.oldestDays > 0 && (
                        <span className="ml-1 text-sm font-normal text-muted">
                          · oldest {chosenCustomer.oldestDays}d
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted">After this sale</dt>
                    <dd className="tabular text-lg font-bold">
                      {money(chosenCustomer.balance + total)}
                    </dd>
                  </div>
                </dl>
                <Button
                  variant="ghost"
                  className="mt-2 min-h-10 px-0 text-sm"
                  onClick={() => setCustomerId(null)}
                >
                  Choose someone else
                </Button>
              </div>
            ) : (
              <>
                <Input
                  placeholder="Search or type a new name"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  autoFocus
                />
                <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                  {matchingCustomers.map((d) => (
                    <li key={d.customer.id}>
                      <button
                        onClick={() => setCustomerId(d.customer.id)}
                        className="flex min-h-14 w-full items-center justify-between rounded-xl border border-line bg-surface px-4 text-left"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{d.customer.name}</span>
                          {d.customer.phone && (
                            <span className="text-sm text-muted">{d.customer.phone}</span>
                          )}
                        </span>
                        {d.balance > 0 && (
                          <span className="tabular shrink-0 text-sm font-semibold text-muted">
                            owes {money(d.balance)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>

                {customerSearch.trim() && matchingCustomers.length === 0 && (
                  <div className="flex flex-col gap-2 rounded-xl bg-panel p-3">
                    <p className="text-sm text-muted">
                      No one by that name. Add them — a phone number is what lets you chase
                      this later.
                    </p>
                    <Input
                      placeholder="Phone (optional)"
                      inputMode="tel"
                      value={newCustomerPhone}
                      onChange={(e) => setNewCustomerPhone(e.target.value)}
                    />
                    <Button
                      variant="neutral"
                      onClick={async () => {
                        setError(null);
                        try {
                          const c = await saveCustomer({
                            name: customerSearch,
                            phone: newCustomerPhone || null,
                          });
                          setCustomerId(c.id);
                          setNewCustomerPhone("");
                          setCustomerSearch("");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Could not add");
                        }
                      }}
                    >
                      Add &ldquo;{customerSearch.trim()}&rdquo;
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* Part-payment. "Pay 200 now, owe 300" is the single most common
                real transaction after plain cash, and without it the attendant
                either records the whole thing as debt (drawer reads over) or
                takes the 200 off the books entirely. One optional field. */}
            {chosenCustomer && (
              <div className="rounded-2xl border border-line bg-panel p-3">
                <label className="block">
                  <span className="mb-1 block text-base font-medium">
                    Paying something now?{" "}
                    <span className="font-normal text-muted">Leave blank if not</span>
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min="0"
                    value={paidNow}
                    onChange={(e) => setPaidNow(e.target.value)}
                    className="tabular h-14 w-full rounded-xl border-2 border-line bg-surface px-4 text-2xl font-bold outline-none"
                  />
                </label>

                {partNum > 0 && (
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2">
                      {(["cash", "mpesa"] as RepaymentMethod[]).map((m) => (
                        <button
                          key={m}
                          onClick={() => setPaidNowMethod(m)}
                          className={`min-h-12 rounded-xl border-2 text-base font-semibold ${
                            paidNowMethod === m
                              ? m === "cash"
                                ? "border-cash bg-cash-soft text-cash-dark"
                                : "border-mpesa bg-mpesa-soft text-mpesa-dark"
                              : "border-line bg-surface text-muted"
                          }`}
                        >
                          {m === "cash" ? "Cash" : "M-Pesa"}
                        </button>
                      ))}
                    </div>

                    {paidNowMethod === "mpesa" && (
                      <Input
                        placeholder="M-Pesa code"
                        autoCapitalize="characters"
                        value={paidNowCode}
                        onChange={(e) => setPaidNowCode(e.target.value.toUpperCase())}
                      />
                    )}

                    <div className="flex items-center justify-between border-t border-line pt-2 text-base">
                      <span className="text-muted">Still owing on this sale</span>
                      <span className="tabular text-lg font-bold">
                        {money(Math.max(0, total - partNum))}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {overLimitWarning && <Notice tone="warn">{overLimitWarning}</Notice>}
            {partPaymentProblem && <Notice tone="warn">{partPaymentProblem}</Notice>}
            {error && <Notice>{error}</Notice>}

            <Button
              variant="neutral"
              size="xl"
              className="border-dashed"
              disabled={!customerId || partPaymentProblem != null}
              onClick={() => confirm("credit")}
            >
              {partNum > 0
                ? `Take ${money(partNum)} now, ${money(total - partNum)} on credit`
                : "Record as credit"}
            </Button>
            <Button variant="ghost" onClick={() => setStage("pay")}>
              Back
            </Button>
          </Panel>
        )}

        {stage === "cash" && (
          <Panel>
            <TotalBar total={total} count={lines.length} />

            <label className="block">
              <span className="mb-1 block text-lg font-medium">Cash received</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min="0"
                autoFocus
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                className="tabular h-20 w-full rounded-2xl border-2 border-cash bg-surface px-4 text-4xl font-bold outline-none lg:h-16 lg:text-3xl"
              />
            </label>

            <div className="grid grid-cols-3 gap-2">
              {quickTenders(total).map((v) => (
                <button
                  key={v}
                  onClick={() => setTendered(String(v))}
                  className="tabular min-h-14 rounded-xl border border-line bg-surface text-lg font-semibold lg:text-base"
                >
                  {money(v)}
                </button>
              ))}
            </div>

            <div className={`rounded-2xl p-5 text-center ${enough ? "bg-cash-soft" : "bg-canvas"}`}>
              <p className="text-lg font-medium text-muted">Change</p>
              <p
                className={`tabular text-5xl font-bold lg:text-4xl ${
                  enough ? "text-cash-dark" : "text-muted"
                }`}
              >
                {enough ? money(change) : "—"}
              </p>
            </div>

            {error && <Notice>{error}</Notice>}

            <Button variant="cash" size="xl" disabled={!enough} onClick={() => confirm("cash")}>
              Confirm cash sale
            </Button>
            <Button variant="ghost" onClick={() => setStage("pay")}>
              Back
            </Button>
          </Panel>
        )}

        {stage === "mpesa" && (
          <Panel>
            <TotalBar total={total} count={lines.length} />

            <label className="block">
              <span className="mb-1 block text-lg font-medium">M-Pesa confirmation code</span>
              <input
                value={mpesaCode}
                onChange={(e) => setMpesaCode(e.target.value.toUpperCase())}
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={32}
                placeholder="SGH7X2K9LM"
                className="h-20 w-full rounded-2xl border-2 border-mpesa bg-surface px-4 text-3xl font-bold tracking-widest uppercase outline-none lg:h-16 lg:text-2xl"
              />
            </label>
            <p className="text-sm text-muted">
              Type the code from the customer&apos;s SMS exactly as it appears. It is stored for the
              Closing screen; the app does not check it with Safaricom.
            </p>

            {/* Optional on purpose. Blocking the sale never produced more codes
                — it produced sales recorded as cash, or not recorded at all.
                The warning keeps the code worth entering without making the
                till unusable when the SMS has not arrived. */}
            {code.length === 0 && (
              <Notice tone="warn">
                You can record this without a code, but it will not be tickable against your
                Safaricom statement at Closing.
              </Notice>
            )}

            {mpesaDupe && (
              <Notice tone="warn">
                This code was already used today for {money(mpesaDupe.total)}. Check it is not
                the same message entered twice.
              </Notice>
            )}

            {error && <Notice>{error}</Notice>}

            <Button
              variant="mpesa"
              size="xl"
              // A partially typed code is more likely a slip than a decision;
              // an empty one is a decision. So block the first, allow the second.
              disabled={code.length > 0 && code.length < 6}
              onClick={() => confirm("mpesa")}
            >
              {code.length === 0 ? "Confirm M-Pesa sale without a code" : "Confirm M-Pesa sale"}
            </Button>
            <Button variant="ghost" onClick={() => setStage("pay")}>
              Back
            </Button>
          </Panel>
        )}

        {stage === "done" && receipt && (
          <Panel>
            <div className="text-center">
              <p className="text-lg text-muted">Sale recorded</p>
              <p className="tabular mt-1 text-5xl font-bold lg:text-4xl">{money(receipt.total)}</p>
              <div className="mt-3 flex justify-center">
                <PaymentTag method={receipt.method} />
              </div>
            </div>

            {receipt.method === "credit" ? (
              <div className="rounded-2xl border border-dashed border-muted p-6 text-center lg:p-4">
                <p className="text-lg font-medium text-muted">
                  {receipt.customerName ?? "Customer"} now owes
                </p>
                <p className="tabular text-5xl font-bold lg:text-4xl">
                  {money(receipt.newBalance ?? receipt.total)}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {receipt.paidNow
                    ? `${money(receipt.paidNow)} taken in ${
                        receipt.paidNowMethod === "mpesa" ? "M-Pesa" : "cash"
                      } — it is in today's expected ${
                        receipt.paidNowMethod === "mpesa" ? "M-Pesa" : "drawer"
                      }.`
                    : "No money was taken for this sale."}
                </p>
              </div>
            ) : receipt.method === "cash" ? (
              <div className="rounded-2xl bg-cash-soft p-6 text-center lg:p-4">
                <p className="text-lg font-medium text-cash-dark">Change</p>
                <p className="tabular text-6xl font-bold text-cash-dark lg:text-5xl">
                  {money(receipt.change)}
                </p>
              </div>
            ) : (
              <div className="rounded-2xl bg-mpesa-soft p-6 text-center lg:p-4">
                <p className="text-lg font-medium text-mpesa-dark">M-Pesa code</p>
                <p className="text-3xl font-bold tracking-wide text-mpesa-dark lg:text-2xl">
                  {receipt.code}
                </p>
              </div>
            )}

            <Button size="xl" onClick={reset}>
              Next customer
            </Button>
          </Panel>
        )}
      </aside>

      {/* Pinned running total — phone and tablet only. Always visible, always
          large, never scrolls away.

          The spacer above it is not decoration. `main` reserves a fixed
          `pb-28` (112px), but the furniture at the bottom of a phone is the
          nav (65px) PLUS this bar (83px, and taller when the total wraps) —
          147px. The last 35px of the page was therefore permanently hidden,
          including the top of the cart panel itself. A hardcoded padding can
          never be right for a bar whose height depends on its contents, so an
          in-flow spacer of the same height reserves exactly as much room as
          the bar actually takes. */}
      {stage === "cart" && lines.length > 0 && (
        <div aria-hidden className="h-24 lg:hidden" />
      )}
      {stage === "cart" && lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-[8] mx-auto max-w-3xl border-t border-line bg-surface px-4 py-3 shadow-[0_-4px_16px_rgba(20,24,31,0.06)] lg:hidden">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-sm text-muted">
                {lines.length} item{lines.length === 1 ? "" : "s"}
              </div>
              <div className="tabular text-3xl leading-tight font-bold">{money(total)}</div>
            </div>
            <Button size="lg" className="px-8" onClick={() => setStage("pay")}>
              Charge
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Full-bleed step on a phone; a card in the side column on a desktop. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[70vh] flex-col gap-4 p-5 lg:min-h-0 lg:rounded-2xl lg:border lg:border-line lg:bg-surface lg:p-4">
      {children}
    </div>
  );
}

function TotalBar({ total, count }: { total: number; count: number }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 text-center lg:border-0 lg:bg-canvas lg:p-3">
      <p className="text-sm text-muted">
        {count} item{count === 1 ? "" : "s"} · total
      </p>
      <p className="tabular text-4xl font-bold lg:text-3xl">{money(total)}</p>
    </div>
  );
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Note-sized shortcuts above the total: the notes an attendant actually gets handed. */
function quickTenders(total: number): number[] {
  const notes = [50, 100, 200, 500, 1000, 2000, 5000];
  const rounded = Math.ceil(total / 50) * 50;
  const options = new Set<number>();
  if (rounded >= total && rounded > 0) options.add(rounded);
  for (const n of notes) {
    if (n >= total) options.add(n);
    if (options.size >= 3) break;
  }
  if (options.size < 3) options.add(Math.ceil(total / 1000) * 1000);
  return [...options].sort((a, b) => a - b).slice(0, 3);
}
