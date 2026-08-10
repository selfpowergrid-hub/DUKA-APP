"use client";

import { db, META_KEYS, metaGet, metaSet } from "./db";
import { allocateFefo, batchStock, daysUntil, unbatchedQuantity } from "./batches";
import { MAX_IMAGE_BYTES } from "./image";
import { DEFAULT_TEMPLATE } from "./remind";
import { supabase } from "./supabase";
import { businessDate, qty } from "./format";
import { kick, outboxEntry } from "./sync";
import { REFUND_REASONS } from "./types";
import type {
  AdjustmentReason,
  CartLine,
  CashCount,
  Category,
  Customer,
  DebtEntry,
  DebtEntryKind,
  DebtReminder,
  ReminderChannel,
  RepaymentMethod,
  MovementReason,
  PaymentMethod,
  Product,
  ProductBatch,
  ProductImage,
  ProductPortion,
  ProductUnit,
  Refund,
  RefundReason,
  Sale,
  SaleItem,
  Session,
  StockMovement,
  Unit,
} from "./types";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for older Android WebViews without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function requireSession(): Promise<Session> {
  const s = await metaGet<Session>(META_KEYS.session);
  if (!s) throw new Error("Not signed in");
  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Derived stock
// ---------------------------------------------------------------------------

/**
 * What this device should show as stock on hand:
 *   the last quantity the server told us  +  every movement still in our outbox.
 *
 * We never mutate product.quantity locally. If we did, a pull would overwrite
 * it and the two sources would fight; keeping the pending deltas separate makes
 * the arithmetic obvious and self-healing.
 */
export async function pendingDeltas(): Promise<Map<string, number>> {
  const entries = await db.outbox.toArray();
  const map = new Map<string, number>();
  const add = (id: string, delta: number) =>
    map.set(id, (map.get(id) ?? 0) + Number(delta));

  for (const e of entries) {
    const p = e.payload as Record<string, unknown>;
    if (e.kind === "sale") {
      const movements = (p.movements ?? []) as Array<{ product_id: string; delta: number }>;
      movements.forEach((m) => add(m.product_id, m.delta));
    } else if (e.kind === "movement") {
      add(p.product_id as string, Number(p.delta));
    } else if (e.kind === "refund") {
      // Goods coming back, and — for a damaged return — going straight out
      // again. Without this the owner reverses a sale and the shelf count does
      // not move until the phone next reaches the server, which reads as the
      // refund having silently failed.
      const movements = (p.movements ?? []) as Array<{ product_id: string; delta: number }>;
      movements.forEach((m) => add(m.product_id, m.delta));
    } else if (e.kind === "new_product") {
      // Opening stock is pending too: the product row the server will send
      // back has quantity 0 until this entry lands.
      const opening = p.opening as { delta: number } | null | undefined;
      const product = p.product as { id: string } | undefined;
      if (opening && product) add(product.id, Number(opening.delta));
    }
  }
  return map;
}

export function applyDeltas(products: Product[], deltas: Map<string, number>): Product[] {
  if (!deltas.size) return products;
  return products.map((p) =>
    deltas.has(p.id) ? { ...p, quantity: p.quantity + deltas.get(p.id)! } : p,
  );
}

// ---------------------------------------------------------------------------
// Sale
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  lines: CartLine[];
  payment_method: PaymentMethod;
  amount_tendered?: number;
  mpesa_code?: string;
  /** Required for a credit sale. A debt owed by nobody is the paper book's
   *  worst failure mode, and the database constraint refuses it too. */
  customer_id?: string;
  /**
   * Money handed over at the counter on a credit sale — "pay 200 now, owe 300".
   * One tap for the attendant; two events in the ledger, because they are
   * genuinely two facts: goods left on credit, and some money came straight
   * back. Both are written in the same transaction as the sale.
   */
  paid_now?: number;
  paid_now_method?: RepaymentMethod;
  paid_now_mpesa_code?: string;
}

/**
 * The one-second path. A single IndexedDB transaction writes the sale, its
 * lines, its stock movements and the outbox entry. No network call, no await
 * on anything remote. `kick()` is deliberately not awaited.
 */
export async function checkout(input: CheckoutInput): Promise<Sale> {
  const session = await requireSession();
  const now = new Date();
  const nowIso = now.toISOString();
  const saleId = uuid();

  if (!input.lines.length) throw new Error("Cart is empty");

  // A portion means one pool of stock sold in a named measure: 3 × "½ litre"
  // is 3 on the receipt and 1.5 litre out of the drum. Without a portion the
  // factor is 1 and the two are the same number.
  const baseOf = (l: CartLine) => round3(l.quantity * (l.portion_factor ?? 1));

  const productRows = await db.products.bulkGet(input.lines.map((l) => l.product_id));
  const productById = new Map(
    productRows.filter((p): p is Product => Boolean(p)).map((p) => [p.id, p]),
  );

  // Oversell guard. This only sees what THIS device knows — two devices can
  // still both sell the last unit before either syncs, and that race is not
  // fixable without refusing to sell offline at all, which is worse. What
  // this catches is the much more common case: a fat-fingered quantity, most
  // reachable now that a cart line's number can be typed directly. A negative
  // number after a genuine cross-device race is visible and honest data for
  // the owner to reconcile; a hard floor at the database would instead throw
  // the whole sale away (see the migration comment on why there is no
  // `quantity >= 0` check constraint) — silently losing money taken from a
  // customer is a worse failure than a stock count that reads negative.
  const deltas = await pendingDeltas();
  for (const l of input.lines) {
    const p = productById.get(l.product_id);
    if (!p || p.track_stock === false) continue;
    const available = p.quantity + (deltas.get(p.id) ?? 0);
    const needed = baseOf(l);
    if (needed > available + 1e-6) {
      throw new Error(`Only ${qty(available)} ${p.unit} of ${l.name} left`);
    }
  }

  // Line totals are the source of truth; the sale total is their sum, never
  // recomputed independently from raw amounts. Rounding each line then
  // separately rounding a sum of the UNROUNDED amounts can differ by a cent
  // from the sum of the rounded lines actually printed on the receipt — a
  // total that does not equal the sum of its own lines is an accounting bug.
  const lineTotals = input.lines.map((l) => round2(l.unit_price * l.quantity));
  const total = round2(lineTotals.reduce((sum, t) => sum + t, 0));

  if (total <= 0) throw new Error("Total must be more than zero");

  const sale: Sale = {
    id: saleId,
    shop_id: session.shop_id,
    user_id: session.user_id,
    total,
    payment_method: input.payment_method,
    amount_tendered:
      input.payment_method === "cash" ? round2(input.amount_tendered ?? 0) : null,
    mpesa_code:
      input.payment_method === "mpesa"
        ? // "" is not a code. Storing it would make every `mpesa_code != null`
          // check downstream quietly wrong.
          (input.mpesa_code ?? "").trim().toUpperCase() || null
        : null,
    business_date: businessDate(now),
    created_at: nowIso,
    synced_at: null,
    customer_id: input.payment_method === "credit" ? (input.customer_id ?? null) : null,
  };

  if (sale.payment_method === "cash" && (sale.amount_tendered ?? 0) < total) {
    throw new Error("Amount tendered is less than the total");
  }
  // No guard on the M-Pesa code, deliberately. Requiring it never produced
  // more codes — it produced fewer recorded sales, or sales miskeyed as cash,
  // because the SMS had not arrived and the queue was four deep. Closing shows
  // which M-Pesa sales lack a code instead, which is a control the owner can
  // act on rather than one an attendant works around.
  if (sale.payment_method === "credit" && !sale.customer_id) {
    throw new Error("Choose who is taking this on credit");
  }

  // Cost at the moment of sale. Without this, restocking at a new price
  // silently rewrites the profit on every sale already made.
  const items: SaleItem[] = input.lines.map((l, i) => ({
    id: uuid(),
    sale_id: saleId,
    shop_id: session.shop_id,
    product_id: l.product_id,
    product_name: l.name,
    unit_price: l.unit_price,
    quantity: l.quantity,
    line_total: lineTotals[i],
    portion_name: l.portion_name ?? null,
    portion_factor: l.portion_factor ?? null,
    base_quantity: baseOf(l),
    unit_cost: productById.get(l.product_id)?.buying_price ?? null,
  }));

  // Only stock-tracked products move stock. Airtime and carrier bags sell
  // without a count, and writing a movement for them would put them in the
  // low-stock list forever.
  const tracked = new Set(
    [...productById.values()].filter((p) => p.track_stock !== false).map((p) => p.id),
  );

  // Stock leaving the shop. For an ordinary product that is one movement; for
  // a batch-tracked one it is a FEFO split, so ten tablets out of a strip of
  // thirty still resolve to a specific batch with a specific expiry.
  const movements: StockMovement[] = [];
  for (const l of input.lines) {
    if (!tracked.has(l.product_id)) continue;
    const product = productById.get(l.product_id);
    // Always in the product's own unit, never in portions.
    const need = baseOf(l);

    const base = {
      shop_id: session.shop_id,
      product_id: l.product_id,
      user_id: session.user_id,
      reason: "sale" as MovementReason,
      buying_price: null,
      total_cost: null,
      sale_id: saleId,
      note: null,
      note_ref: null,
      created_at: nowIso,
      synced_at: null,
    };

    if (!product?.track_batches) {
      movements.push({ id: uuid(), ...base, delta: -need, batch_id: null });
      continue;
    }

    const productBatches = await db.product_batches
      .where("product_id")
      .equals(l.product_id)
      .toArray();
    const productMovements = await db.stock_movements
      .where("product_id")
      .equals(l.product_id)
      .toArray();
    const shelf = batchStock(productBatches, productMovements);
    const { lines: split, short, available } = allocateFefo(shelf, need, {
      // Stock that predates batch tracking is still sellable, but only after
      // every dated batch — see allocateFefo.
      unbatched: unbatchedQuantity(productMovements),
    });

    // Expired batches are skipped by the allocator rather than used last, so a
    // shortfall here can mean "none left" OR "the only stock left is expired".
    // Both must stop the sale: dispensing expired medicine is not a lesser
    // option to fall back on, and quietly selling it is exactly the failure
    // this whole feature exists to prevent.
    if (short > 0.0001) {
      throw new Error(
        available > 0
          ? `Only ${qty(available)} of ${l.name} is in date. Check the shelf for expired stock.`
          : `${l.name} has no stock in date. Do not dispense it.`,
      );
    }

    for (const part of split) {
      movements.push({ id: uuid(), ...base, delta: -part.quantity, batch_id: part.batch_id });
    }
  }

  // A credit sale is TWO rows: the sale and its debt charge. They ride in one
  // outbox entry and one server transaction, for the same reason opening stock
  // and portions do — a charge pushed before its sale exists is a foreign-key
  // violation, which the sync engine treats as permanent and parks. That would
  // be money owed to the shop, stuck on one phone for ever.
  const charge: DebtEntry | null =
    sale.payment_method === "credit" && sale.customer_id
      ? {
          id: uuid(),
          shop_id: session.shop_id,
          customer_id: sale.customer_id,
          user_id: session.user_id,
          kind: "charge",
          amount: total,
          sale_id: saleId,
          payment_method: null,
          mpesa_code: null,
          note: null,
          business_date: sale.business_date,
          created_at: nowIso,
          synced_at: null,
        }
      : null;

  // Part-payment at the till. Paying the full amount is not a credit sale at
  // all, so it is refused here rather than written as a debt that settles
  // itself; the Sell screen steers to the ordinary Cash/M-Pesa buttons.
  const paidNow = round2(input.paid_now ?? 0);
  if (paidNow > 0) {
    if (sale.payment_method !== "credit") {
      throw new Error("Part-payment only applies to a credit sale");
    }
    if (paidNow >= total) {
      throw new Error("That covers the whole sale — take it as cash or M-Pesa instead");
    }
    if (!input.paid_now_method) throw new Error("Was the part-payment cash or M-Pesa?");
  }

  const partPayment: DebtEntry | null =
    paidNow > 0 && sale.customer_id
      ? {
          id: uuid(),
          shop_id: session.shop_id,
          customer_id: sale.customer_id,
          user_id: session.user_id,
          kind: "payment",
          amount: paidNow,
          // Naming the sale is what lets Closing tell "paid at the till" from
          // "old debt repaid today". Both raise expected cash identically.
          sale_id: saleId,
          payment_method: input.paid_now_method ?? null,
          mpesa_code:
            input.paid_now_method === "mpesa"
              ? (input.paid_now_mpesa_code ?? "").trim().toUpperCase() || null
              : null,
          note: null,
          business_date: sale.business_date,
          created_at: nowIso,
          synced_at: null,
        }
      : null;

  await db.transaction(
    "rw",
    [db.sales, db.sale_items, db.stock_movements, db.debt_entries, db.outbox],
    async () => {
      await db.sales.add(sale);
      await db.sale_items.bulkAdd(items);
      await db.stock_movements.bulkAdd(movements);
      if (charge) await db.debt_entries.add(charge);
      if (partPayment) await db.debt_entries.add(partPayment);
      await db.outbox.add(
        outboxEntry("sale", saleId, {
          sale: {
            id: sale.id,
            total: sale.total,
            payment_method: sale.payment_method,
            amount_tendered: sale.amount_tendered,
            mpesa_code: sale.mpesa_code,
            business_date: sale.business_date,
            created_at: sale.created_at,
            customer_id: sale.customer_id,
            debt_entry_id: charge?.id ?? null,
            immediate_payment: partPayment
              ? {
                  id: partPayment.id,
                  amount: partPayment.amount,
                  payment_method: partPayment.payment_method,
                  mpesa_code: partPayment.mpesa_code,
                }
              : null,
          },
          items: items.map(
            ({
              id,
              product_id,
              product_name,
              unit_price,
              quantity,
              line_total,
              portion_name,
              portion_factor,
              base_quantity,
              unit_cost,
            }) => ({
              id,
              product_id,
              product_name,
              unit_price,
              quantity,
              line_total,
              portion_name,
              portion_factor,
              base_quantity,
              unit_cost,
            }),
          ),
          movements: movements.map(({ id, product_id, delta, created_at }) => ({
            id,
            product_id,
            delta,
            created_at,
          })),
        }),
      );
    },
  );

  kick(); // not awaited — the till is already free
  return sale;
}

// ---------------------------------------------------------------------------
// Stock movements (restock / adjustment / damage)
// ---------------------------------------------------------------------------

export async function recordMovement(args: {
  product_id: string;
  delta: number;
  reason: Exclude<MovementReason, "sale" | "opening">;
  buying_price?: number | null;
  total_cost?: number | null;
  note?: string | null;
  note_ref?: string | null;
  /** Which batch this moves. Required for a product that tracks batches. */
  batch_id?: string | null;
  /** Lets a delivery entered this morning be filed against yesterday. */
  created_at?: string;
}): Promise<void> {
  const session = await requireSession();
  if (!args.delta) throw new Error("Quantity cannot be zero");
  if (args.reason === "restock" && args.delta <= 0) {
    throw new Error("Restock quantity must be more than zero");
  }
  if ((args.reason === "damage" || args.reason === "loss") && args.delta >= 0) {
    throw new Error("Damage and loss must reduce stock");
  }

  const movement: StockMovement = {
    id: uuid(),
    shop_id: session.shop_id,
    product_id: args.product_id,
    user_id: session.user_id,
    delta: args.delta,
    reason: args.reason,
    buying_price: args.buying_price ?? null,
    total_cost: args.total_cost ?? null,
    sale_id: null,
    batch_id: args.batch_id ?? null,
    note: args.note ?? null,
    note_ref: args.note_ref ?? null,
    created_at: args.created_at ?? new Date().toISOString(),
    synced_at: null,
  };

  await db.transaction("rw", [db.stock_movements, db.outbox], async () => {
    await db.stock_movements.add(movement);
    await db.outbox.add(
      outboxEntry("movement", movement.id, {
        id: movement.id,
        product_id: movement.product_id,
        delta: movement.delta,
        reason: movement.reason,
        buying_price: movement.buying_price,
        total_cost: movement.total_cost,
        note: movement.note,
        note_ref: movement.note_ref,
        created_at: movement.created_at,
      }),
    );
  });

  kick();
}

/**
 * A recount takes what the attendant actually counted, not a difference.
 * Someone standing at a shelf knows "there are 14"; making them work out
 * "that is 3 fewer than the system thinks" is how you get wrong data.
 */
export async function recordAdjustment(args: {
  product_id: string;
  reason: AdjustmentReason;
  /** For a recount: the absolute figure counted. For damage/loss: how many. */
  value: number;
  note?: string | null;
}): Promise<number> {
  const product = await db.products.get(args.product_id);
  if (!product) throw new Error("Product not found");

  const deltas = await pendingDeltas();
  const onHand = product.quantity + (deltas.get(product.id) ?? 0);

  let delta: number;
  if (args.reason === "adjustment") {
    if (args.value < 0) throw new Error("A count cannot be negative");
    delta = round3(args.value - onHand);
    if (delta === 0) return onHand; // counted exactly what we expected
  } else {
    if (args.value <= 0) throw new Error("Enter how many were affected");
    if (args.value > onHand + 1e-6) {
      throw new Error(`Only ${qty(onHand)} ${product.unit} on hand — cannot mark more than that`);
    }
    delta = -Math.abs(round3(args.value));
  }

  await recordMovement({
    product_id: args.product_id,
    delta,
    reason: args.reason,
    note: args.note ?? null,
  });

  return round3(onHand + delta);
}

// ---------------------------------------------------------------------------
// Batches and expiry
// ---------------------------------------------------------------------------

/**
 * Register a delivery, or correct one already known.
 *
 * Keyed on (product, batch number) rather than on a fresh id every time: the
 * same batch received twice IS the same batch, and two rows would split its
 * quantity so half of it could hide from an expiry report. The server enforces
 * the same collapse, so two devices receiving one delivery offline still
 * converge on a single batch.
 */
export async function saveBatch(args: {
  product_id: string;
  batch_no: string;
  expiry_date: string;
  note?: string | null;
}): Promise<ProductBatch> {
  const session = await requireSession();
  const batchNo = args.batch_no.trim();
  if (!batchNo) throw new Error("Enter the batch number from the carton");
  if (!args.expiry_date) throw new Error("Enter the expiry date");
  // A date far in the past is a typo, not a delivery. Caught here because the
  // consequence — stock that FEFO refuses to dispense — looks like a bug.
  if (daysUntil(args.expiry_date) < -3650) {
    throw new Error("That expiry date looks wrong. Check the year.");
  }

  const existing = await db.product_batches
    .where("[product_id+batch_no]")
    .equals([args.product_id, batchNo])
    .first();

  const nowIso = new Date().toISOString();
  const batch: ProductBatch = {
    id: existing?.id ?? uuid(),
    shop_id: session.shop_id,
    product_id: args.product_id,
    batch_no: batchNo,
    expiry_date: args.expiry_date,
    note: args.note?.trim() || null,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
    synced_at: null,
  };

  await db.transaction("rw", [db.product_batches, db.outbox], async () => {
    await db.product_batches.put(batch);
    await db.outbox.add(
      outboxEntry("batch", batch.id, {
        id: batch.id,
        product_id: batch.product_id,
        batch_no: batch.batch_no,
        expiry_date: batch.expiry_date,
        note: batch.note,
        created_at: batch.created_at,
        updated_at: batch.updated_at,
      }),
    );
  });

  kick();
  return batch;
}

// ---------------------------------------------------------------------------
// Product photos
// ---------------------------------------------------------------------------

/**
 * Attach or replace a product's photo.
 *
 * Written straight to IndexedDB so it shows on the till immediately, with the
 * radio off, exactly like every other write here. Unlike the money records this
 * one is last-write-wins rather than insert-once: a photo is a CORRECTION, and
 * replacing a bad one has to actually replace it. That is only safe because a
 * photo carries no money — two devices racing produces one of two photos, and
 * either is fine.
 *
 * `prepared` comes from `prepareImage()`, which has already cropped, resized
 * and compressed it. Nothing uncompressed ever reaches this function.
 */
export async function saveProductImage(
  productId: string,
  prepared: { data: string; width: number; height: number; bytes: number },
): Promise<ProductImage> {
  const session = await requireSession();
  if (prepared.bytes > MAX_IMAGE_BYTES) {
    throw new Error("That photo is too large. Try taking it again.");
  }

  const existing = await db.product_images.get(productId);
  const nowIso = new Date().toISOString();
  const image: ProductImage = {
    product_id: productId,
    shop_id: session.shop_id,
    user_id: session.user_id,
    data: prepared.data,
    width: prepared.width,
    height: prepared.height,
    bytes: prepared.bytes,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
    synced_at: null,
  };

  await db.transaction("rw", [db.product_images, db.outbox], async () => {
    await db.product_images.put(image);
    await queueImage(productId, image);
  });

  kick();
  return image;
}

/** Remove a product's photo. An empty `data` tells the server to delete it. */
export async function removeProductImage(productId: string): Promise<void> {
  await requireSession();
  await db.transaction("rw", [db.product_images, db.outbox], async () => {
    await db.product_images.delete(productId);
    await queueImage(productId, null);
  });
  kick();
}

/**
 * Queue the photo, collapsing any earlier unsent version of the SAME photo.
 *
 * Without this, photographing one product four times while offline would push
 * four payloads of ~15 KB each and the last three would simply overwrite the
 * first. Only the newest state is worth sending, and on a slow connection the
 * difference is the whole point.
 */
async function queueImage(productId: string, image: ProductImage | null): Promise<void> {
  const stale = await db.outbox
    .where("kind")
    .equals("product_image")
    .filter((e) => e.entity_id === productId)
    .toArray();
  if (stale.length) {
    await db.outbox.bulkDelete(stale.map((e) => e.seq!));
  }
  await db.outbox.add(
    outboxEntry("product_image", productId, {
      product_id: productId,
      data: image?.data ?? null,
      width: image?.width ?? null,
      height: image?.height ?? null,
      bytes: image?.bytes ?? null,
      created_at: image?.created_at ?? new Date().toISOString(),
      updated_at: image?.updated_at ?? new Date().toISOString(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Reverse a whole sale.
 *
 * The sale itself is never touched. Everything else here is a new record that
 * points at it — the same append-only rule the stock and debt ledgers already
 * follow, and the reason a refund can be trusted at all: nothing that was true
 * yesterday quietly stops being true.
 *
 * Three effects, and they must land together or not at all:
 *   1. the refund row (money out, and why)
 *   2. stock coming back
 *   3. for a credit sale, the debt reversed
 *
 * A refund that reached the server without its return movement would show
 * money out and the stock still gone. The reverse would show stock back and
 * the drawer still expecting the money. So all three ride in ONE outbox entry
 * and one server transaction, exactly as a credit sale and its charge do.
 */
export async function refundSale(args: {
  sale_id: string;
  reason: RefundReason;
  note?: string | null;
}): Promise<Refund> {
  const session = await requireSession();
  if (session.role !== "owner") {
    // Also enforced by RLS and by sync_refund. Checked here so the message is
    // useful rather than a sync failure surfacing hours later.
    throw new Error("Only the owner can refund a sale");
  }

  const sale = await db.sales.get(args.sale_id);
  if (!sale) throw new Error("That sale is not on this device");

  const already = await db.refunds.where("sale_id").equals(args.sale_id).first();
  if (already) throw new Error("That sale has already been refunded");

  const items = await db.sale_items.where("sale_id").equals(args.sale_id).toArray();
  const nowIso = new Date().toISOString();
  const businessDay = businessDate();
  const reason = REFUND_REASONS.find((r) => r.key === args.reason);
  if (!reason) throw new Error("Choose why this is being refunded");

  const refund: Refund = {
    id: uuid(),
    shop_id: session.shop_id,
    sale_id: sale.id,
    user_id: session.user_id,
    amount: round2(sale.total),
    // Not how the sale was paid. An M-Pesa sale settles as cash because this
    // app cannot send M-Pesa, and saying so is better than implying it did.
    settled_as: sale.payment_method === "credit" ? "credit" : "cash",
    reason: args.reason,
    note: args.note?.trim() || null,
    business_date: businessDay,
    // Dated TODAY, not the day of the sale. The money leaves the drawer now,
    // so it belongs to today's count; back-dating it would make a past day
    // that was already counted and signed off silently stop balancing.
    created_at: nowIso,
    synced_at: null,
  };

  // Goods coming back. Only for products that still exist and are tracked —
  // a sale of an untracked item never moved stock, so nothing comes back.
  const products = await db.products.bulkGet(items.map((i) => i.product_id));
  // What the original sale took, and from which batch. Goods must go back to
  // the batch they came from — returning them to a pool, or to whichever batch
  // happens to expire first, would put stock under an expiry date that was
  // never on that carton.
  const soldMovements = (await db.stock_movements.toArray()).filter(
    (m) => m.sale_id === sale.id && m.reason === "sale",
  );

  const movements: StockMovement[] = [];
  items.forEach((item, i) => {
    const product = products[i];
    if (!product || !product.track_stock) return;
    const qtyBack = round3(item.base_quantity ?? item.quantity);
    if (qtyBack <= 0) return;

    const base = {
      shop_id: session.shop_id,
      product_id: item.product_id,
      user_id: session.user_id,
      sale_id: sale.id,
      buying_price: null,
      total_cost: null,
      note_ref: null,
      created_at: nowIso,
      synced_at: null,
    };

    // One line can have spanned two batches, so the reversal mirrors the split
    // rather than assuming a single origin.
    const origins = soldMovements.filter((m) => m.product_id === item.product_id);
    const parts = origins.length
      ? origins.map((m) => ({ batch_id: m.batch_id, quantity: round3(-m.delta) }))
      : [{ batch_id: null, quantity: qtyBack }];

    for (const part of parts) {
      if (part.quantity <= 0) continue;
      movements.push({
        id: uuid(),
        ...base,
        delta: part.quantity,
        reason: "return",
        note: null,
        batch_id: part.batch_id,
      });

      // Damaged goods come back AND are written off. A single no-op movement
      // would record that stock did not change while losing both facts, and the
      // shrink report needs the second one.
      if (!reason.sellable) {
        movements.push({
          id: uuid(),
          ...base,
          delta: -part.quantity,
          reason: "damage",
          note: "Returned damaged",
          batch_id: part.batch_id,
        });
      }
    }
  });

  // Reversing a credit sale moves no cash: they never paid for it. If they had
  // part-paid at the till for more than they kept, the FIFO allocation turns
  // the excess into credit toward their next purchase with no extra work.
  const reversal: DebtEntry | null =
    refund.settled_as === "credit" && sale.customer_id
      ? {
          id: uuid(),
          shop_id: session.shop_id,
          customer_id: sale.customer_id,
          user_id: session.user_id,
          kind: "reversal",
          amount: refund.amount,
          sale_id: sale.id,
          payment_method: null,
          mpesa_code: null,
          note: null,
          business_date: businessDay,
          created_at: nowIso,
          synced_at: null,
        }
      : null;

  await db.transaction(
    "rw",
    [db.refunds, db.stock_movements, db.debt_entries, db.outbox],
    async () => {
      await db.refunds.add(refund);
      if (movements.length) await db.stock_movements.bulkAdd(movements);
      if (reversal) await db.debt_entries.add(reversal);
      await db.outbox.add(
        outboxEntry("refund", refund.id, {
          refund: {
            id: refund.id,
            sale_id: refund.sale_id,
            amount: refund.amount,
            settled_as: refund.settled_as,
            reason: refund.reason,
            note: refund.note,
            business_date: refund.business_date,
            created_at: refund.created_at,
            debt_entry_id: reversal?.id ?? null,
          },
          movements: movements.map((m) => ({
            id: m.id,
            product_id: m.product_id,
            delta: m.delta,
            reason: m.reason,
            created_at: m.created_at,
          })),
        }),
      );
    },
  );

  kick();
  return refund;
}

/** Sale ids already refunded, for marking up a list of sales. */
export async function refundedSaleIds(): Promise<Set<string>> {
  return new Set((await db.refunds.toArray()).map((r) => r.sale_id));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function stableHash32(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 2654435761);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Deterministic id for the one cash_counts row a shop can have on a given day.
 *
 * `sync_cash_count` resolves conflicts on `(shop_id, business_date)`, not on
 * `id` — a second device counting the same day used to generate its own random
 * uuid, which the server's ON CONFLICT DO UPDATE then discarded in favour of
 * whichever id got there first. That device's local row kept its own
 * (now-orphaned) id, and the next pull added the server's canonical row under
 * a THIRD id rather than replacing anything — two local rows for one day, and
 * `dayTotals()` reading `.first()` with no defined order between them.
 *
 * Every device computing the same id for the same (shop, day) up front removes
 * the need to reconcile anything after the fact: the row simply IS the same
 * row everywhere, the same way a client-generated sale id already works,
 * just derived from content instead of chosen at random.
 *
 * Not cryptographic — a shop's handful of cash counts a day only need this to
 * avoid colliding with itself over a few decades, not resist an attacker.
 */
export function cashCountId(shopId: string, businessDateStr: string): string {
  const key = `${shopId}:${businessDateStr}`;
  const hex = [1, 2, 3, 4]
    .map((seed) => stableHash32(key, seed * 0x9e3779b9).toString(16).padStart(8, "0"))
    .join("");
  const shaped =
    hex.slice(0, 12) + "4" + hex.slice(13, 16) + "8" + hex.slice(17, 20) + hex.slice(20);
  return [
    shaped.slice(0, 8),
    shaped.slice(8, 12),
    shaped.slice(12, 16),
    shaped.slice(16, 20),
    shaped.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface ProductInput {
  id?: string;
  name: string;
  unit: ProductUnit;
  buying_price: number;
  selling_price: number;
  low_stock_threshold: number;
  is_active?: boolean;
  category_id?: string | null;
  track_stock?: boolean;
  /** Clusters sealed pack sizes. Display only — stock stays independent. */
  group_name?: string | null;
  /** Track this product per batch, with an expiry date on each delivery. */
  track_batches?: boolean;
  /** Prescription-only medicine. Warns at the till. */
  is_pom?: boolean;
  /** New products only: what is already on the shelf. Ignored on edit. */
  opening_quantity?: number;
  /** New products only: what that opening stock cost in total. */
  opening_total_cost?: number | null;
  /** Named measures drawn from one pool. Empty means sold whole. */
  portions?: Array<{ id?: string; name: string; factor: number; price: number }>;
}

export async function saveProduct(input: ProductInput): Promise<Product> {
  const session = await requireSession();
  const existing = input.id ? await db.products.get(input.id) : undefined;
  const isNew = !existing;
  const nowIso = new Date().toISOString();
  const opening = isNew ? Math.max(0, Number(input.opening_quantity) || 0) : 0;

  const product: Product = {
    id: input.id ?? uuid(),
    shop_id: session.shop_id,
    name: input.name.trim(),
    unit: input.unit,
    buying_price: round2(input.buying_price),
    selling_price: round2(input.selling_price),
    // Never set locally. On a new product the server derives it from the
    // opening movement; on an edit it stays whatever the ledger says.
    quantity: existing?.quantity ?? 0,
    low_stock_threshold: input.low_stock_threshold,
    is_active: input.is_active ?? existing?.is_active ?? true,
    category_id: input.category_id ?? existing?.category_id ?? null,
    track_stock: input.track_stock ?? existing?.track_stock ?? true,
    group_name: (input.group_name ?? existing?.group_name ?? null) || null,
    track_batches: input.track_batches ?? existing?.track_batches ?? false,
    is_pom: input.is_pom ?? existing?.is_pom ?? false,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };

  if (!product.name) throw new Error("Name is required");
  if (product.selling_price <= 0) throw new Error("Selling price is required");
  if (opening > 0 && !product.track_stock) {
    throw new Error("Turn stock tracking on to record opening stock");
  }

  // Catches the single-device case immediately, with a clear message, instead
  // of a silent sync failure days later. Two devices creating the same name
  // while both offline still collide server-side — that case is handled by
  // the sync engine treating a unique-constraint violation as permanent and
  // surfacing it in Settings, since no local check can see another device.
  if (!existing || existing.name.trim().toLowerCase() !== product.name.toLowerCase()) {
    const clash = await db.products
      .filter(
        (p) =>
          p.id !== product.id &&
          p.is_active &&
          p.name.trim().toLowerCase() === product.name.toLowerCase(),
      )
      .first();
    if (clash) throw new Error(`"${product.name}" already exists`);
  }

  // The payload never carries `quantity`: it is the server's derived value and
  // no client is even granted permission to write that column.
  const fields = {
    id: product.id,
    shop_id: product.shop_id,
    name: product.name,
    unit: product.unit,
    buying_price: product.buying_price,
    selling_price: product.selling_price,
    low_stock_threshold: product.low_stock_threshold,
    is_active: product.is_active,
    category_id: product.category_id,
    track_stock: product.track_stock,
    group_name: product.group_name,
  };

  const portionRows: ProductPortion[] = (input.portions ?? []).map((p, i) => ({
    id: p.id ?? uuid(),
    shop_id: session.shop_id,
    product_id: product.id,
    name: p.name.trim(),
    factor: p.factor,
    price: round2(p.price),
    sort_order: (i + 1) * 10,
  }));

  for (const p of portionRows) {
    if (!p.name) throw new Error("Every portion needs a name");
    if (!(p.factor > 0)) throw new Error(`"${p.name}" needs a size greater than zero`);
  }

  const openingMovement: StockMovement | null =
    opening > 0
      ? {
          id: uuid(),
          shop_id: session.shop_id,
          product_id: product.id,
          user_id: session.user_id,
          // Opening stock has no batch. A shop turning batch tracking on for a
          // product that is already on the shelf genuinely does not know which
          // batch that stock is, and inventing one would be worse than an
          // honest null — FEFO simply has nothing to allocate from until the
          // next delivery, which is the truthful state of affairs.
          batch_id: null,
          delta: opening,
          reason: "opening",
          buying_price: product.buying_price || null,
          total_cost:
            input.opening_total_cost != null
              ? round2(input.opening_total_cost)
              : product.buying_price
                ? round2(product.buying_price * opening)
                : null,
          sale_id: null,
          note: "Opening stock",
          note_ref: null,
          created_at: nowIso,
          synced_at: null,
        }
      : null;

  await db.transaction(
    "rw",
    [db.products, db.stock_movements, db.portions, db.outbox],
    async () => {
    await db.products.put(product);
    if (openingMovement) await db.stock_movements.add(openingMovement);

    // Replace-all: the editor is a list, so a removed row must actually go.
    await db.portions.where("product_id").equals(product.id).delete();
    if (portionRows.length) await db.portions.bulkPut(portionRows);

    if (isNew) {
      // ONE outbox entry, not two. A separate movement entry could be pushed
      // before the product row exists, which is a foreign-key violation the
      // sync engine treats as permanent — a movement that never syncs.
      await db.outbox.add(
        outboxEntry("new_product", product.id, {
          product: fields,
          opening: openingMovement
            ? {
                id: openingMovement.id,
                delta: openingMovement.delta,
                buying_price: openingMovement.buying_price,
                total_cost: openingMovement.total_cost,
                note: openingMovement.note,
                created_at: openingMovement.created_at,
              }
            : null,
          // Portions ride with the product for the same reason opening stock
          // does: they reference a row that may not exist on the server yet.
          portions: portionRows.map(({ id, name, factor, price, sort_order }) => ({
            id,
            name,
            factor,
            price,
            sort_order,
          })),
        }),
      );
    } else {
      await db.outbox.add(outboxEntry("product", product.id, fields));
      // The product already exists server-side, so its portion list can be
      // replaced on its own. sync_portions does the whole swap in one
      // transaction so a removed row can never linger.
      await db.outbox.add(
        outboxEntry("portions", product.id, {
          product_id: product.id,
          portions: portionRows.map(({ id, name, factor, price, sort_order }) => ({
            id,
            name,
            factor,
            price,
            sort_order,
          })),
        }),
      );
    }
    },
  );

  kick();
  return product;
}

// ---------------------------------------------------------------------------
// Customers and debt
// ---------------------------------------------------------------------------

export async function saveCustomer(input: {
  id?: string;
  name: string;
  phone?: string | null;
  credit_limit?: number | null;
  note?: string | null;
  is_active?: boolean;
}): Promise<Customer> {
  const session = await requireSession();
  const existing = input.id ? await db.customers.get(input.id) : undefined;
  const nowIso = new Date().toISOString();
  const name = input.name.trim();
  const phone = (input.phone ?? "").trim() || null;

  if (!name) throw new Error("Name is required");

  // Phone is the natural key in Kenya and the only way to chase a debt, so a
  // collision almost always means "this is the same person", not a new one.
  if (phone) {
    const clash = (await db.customers.toArray()).find(
      (c) => c.id !== (input.id ?? "") && (c.phone ?? "").trim() === phone,
    );
    if (clash) throw new Error(`${clash.name} already uses that phone number`);
  }

  const customer: Customer = {
    id: input.id ?? uuid(),
    shop_id: session.shop_id,
    name,
    phone,
    credit_limit:
      input.credit_limit != null && input.credit_limit > 0 ? round2(input.credit_limit) : null,
    is_active: input.is_active ?? existing?.is_active ?? true,
    note: input.note?.trim() || null,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };

  await db.transaction("rw", [db.customers, db.outbox], async () => {
    await db.customers.put(customer);
    await db.outbox.add(
      outboxEntry("customer", customer.id, {
        id: customer.id,
        shop_id: customer.shop_id,
        name: customer.name,
        phone: customer.phone,
        credit_limit: customer.credit_limit,
        is_active: customer.is_active,
        note: customer.note,
        created_at: customer.created_at,
      }),
    );
  });

  kick();
  return customer;
}

/**
 * Record money coming back, or an owner giving up on a debt.
 *
 * Charges are NOT created here — they belong to a sale and ride with it, so
 * that a charge can never reach the server before the sale it points at.
 */
export async function recordDebtEntry(args: {
  customer_id: string;
  kind: Exclude<DebtEntryKind, "charge">;
  amount: number;
  payment_method?: RepaymentMethod;
  mpesa_code?: string | null;
  note?: string | null;
}): Promise<DebtEntry> {
  const session = await requireSession();
  const customer = await db.customers.get(args.customer_id);
  if (!customer) throw new Error("Customer not found");
  if (!(args.amount > 0)) throw new Error("Enter an amount");

  if (args.kind === "payment") {
    // Same reasoning as the till: a debtor who paid and cannot produce the
    // code is still a debtor who paid, and refusing the record is worse than
    // holding it without the reference.
    if (!args.payment_method) throw new Error("Was it cash or M-Pesa?");
  }

  const now = new Date();
  const entry: DebtEntry = {
    id: uuid(),
    shop_id: session.shop_id,
    customer_id: args.customer_id,
    user_id: session.user_id,
    kind: args.kind,
    amount: round2(args.amount),
    sale_id: null,
    payment_method: args.kind === "payment" ? (args.payment_method ?? null) : null,
    mpesa_code:
      args.kind === "payment" && args.payment_method === "mpesa"
        ? (args.mpesa_code ?? "").trim().toUpperCase() || null
        : null,
    note: args.note?.trim() || null,
    business_date: businessDate(now),
    created_at: now.toISOString(),
    synced_at: null,
  };

  await db.transaction("rw", [db.debt_entries, db.outbox], async () => {
    await db.debt_entries.add(entry);
    await db.outbox.add(
      outboxEntry("debt_entry", entry.id, {
        id: entry.id,
        customer_id: entry.customer_id,
        kind: entry.kind,
        amount: entry.amount,
        payment_method: entry.payment_method,
        mpesa_code: entry.mpesa_code,
        note: entry.note,
        business_date: entry.business_date,
        created_at: entry.created_at,
      }),
    );
  });

  kick();
  return entry;
}

/** The shop's reminder wording, or the default when it has never been changed. */
export async function reminderTemplate(): Promise<string> {
  return (await metaGet<string>(META_KEYS.reminderTemplate)) ?? DEFAULT_TEMPLATE;
}

/**
 * Save the reminder wording.
 *
 * Local first and always — the owner may be editing this in a shop with no
 * signal, and a settings screen that can fail is a settings screen that gets
 * abandoned. The push to the server is best-effort and deliberately silent: if
 * it does not land, the only consequence is that the NEXT device to sign in
 * starts from the default wording, which is a mild inconvenience rather than a
 * lost record.
 */
export async function saveReminderTemplate(template: string): Promise<void> {
  const session = await requireSession();
  const text = template.trim() || DEFAULT_TEMPLATE;
  await metaSet(META_KEYS.reminderTemplate, text);
  try {
    const sb = supabase();
    await sb.from("shops").update({ reminder_template: text }).eq("id", session.shop_id);
  } catch {
    // Offline, or the column is not there yet. Neither is worth a message.
  }
}

/**
 * Record an attempt to get paid.
 *
 * Written whether or not the message actually sent — the app hands off to
 * WhatsApp or the dialler and cannot know what happened next. What it can
 * record honestly is that the owner tried, when, and what was owed at the
 * time. An unrecorded reminder is a conversation nobody can refer back to.
 */
export async function recordReminder(args: {
  customer_id: string;
  channel: ReminderChannel;
  balance_at_time: number;
  promised_date?: string | null;
  note?: string | null;
}): Promise<DebtReminder> {
  const session = await requireSession();
  const reminder: DebtReminder = {
    id: uuid(),
    shop_id: session.shop_id,
    customer_id: args.customer_id,
    user_id: session.user_id,
    channel: args.channel,
    balance_at_time: round2(Math.max(0, args.balance_at_time)),
    promised_date: args.promised_date || null,
    note: args.note?.trim() || null,
    created_at: new Date().toISOString(),
    synced_at: null,
  };

  await db.transaction("rw", [db.debt_reminders, db.outbox], async () => {
    await db.debt_reminders.add(reminder);
    await db.outbox.add(
      outboxEntry("reminder", reminder.id, {
        id: reminder.id,
        customer_id: reminder.customer_id,
        channel: reminder.channel,
        balance_at_time: reminder.balance_at_time,
        promised_date: reminder.promised_date,
        note: reminder.note,
        created_at: reminder.created_at,
      }),
    );
  });

  kick();
  return reminder;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export async function saveUnit(args: {
  code: string;
  label?: string;
  is_fractional?: boolean;
}): Promise<Unit> {
  const session = await requireSession();
  const code = args.code.trim().toLowerCase();
  if (!code) throw new Error("Unit code is required");

  const existing = (await db.units.toArray()).find(
    (u) => u.code.trim().toLowerCase() === code,
  );
  if (existing) return existing;

  const unit: Unit = {
    id: uuid(),
    shop_id: session.shop_id,
    code,
    label: (args.label ?? args.code).trim() || code,
    is_fractional: args.is_fractional ?? false,
    sort_order: 500,
  };

  await db.transaction("rw", [db.units, db.outbox], async () => {
    await db.units.put(unit);
    await db.outbox.add(outboxEntry("unit", unit.id, unit));
  });

  kick();
  return unit;
}

/** Does this product's unit allow halves? Drives the Sell keypad and stepping. */
export function unitIsFractional(unitCode: string, units: Unit[]): boolean {
  return units.find((u) => u.code === unitCode)?.is_fractional ?? false;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function saveCategory(name: string): Promise<Category> {
  const session = await requireSession();
  const clean = name.trim();
  if (!clean) throw new Error("Category name is required");

  const existing = (await db.categories.toArray()).find(
    (c) => c.name.trim().toLowerCase() === clean.toLowerCase(),
  );
  if (existing) return existing;

  const nowIso = new Date().toISOString();
  const category: Category = {
    id: uuid(),
    shop_id: session.shop_id,
    name: clean,
    created_at: nowIso,
    updated_at: nowIso,
  };

  await db.transaction("rw", [db.categories, db.outbox], async () => {
    await db.categories.put(category);
    await db.outbox.add(
      outboxEntry("category", category.id, {
        id: category.id,
        shop_id: category.shop_id,
        name: category.name,
      }),
    );
  });

  kick();
  return category;
}

export async function setProductActive(id: string, active: boolean): Promise<void> {
  const p = await db.products.get(id);
  if (!p) throw new Error("Product not found");
  await saveProduct({ ...p, is_active: active });
}

// ---------------------------------------------------------------------------
// Cash count
// ---------------------------------------------------------------------------

export async function saveCashCount(date: string, counted: number): Promise<CashCount> {
  const session = await requireSession();
  const existing = await db.cash_counts.where("business_date").equals(date).first();
  const nowIso = new Date().toISOString();

  const row: CashCount = {
    id: existing?.id ?? cashCountId(session.shop_id, date),
    shop_id: session.shop_id,
    user_id: session.user_id,
    business_date: date,
    counted_amount: round2(counted),
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
    synced_at: null,
  };

  await db.transaction("rw", [db.cash_counts, db.outbox], async () => {
    await db.cash_counts.put(row);
    await db.outbox.add(
      outboxEntry("cash_count", row.id, {
        id: row.id,
        business_date: row.business_date,
        counted_amount: row.counted_amount,
        created_at: row.created_at,
      }),
    );
  });

  kick();
  return row;
}

// ---------------------------------------------------------------------------
// Closing figures — computed entirely from IndexedDB so the screen works offline
// ---------------------------------------------------------------------------

export interface DayTotals {
  date: string;
  /** Cash from SALES only. `expectedCash` is what should be in the drawer. */
  cash: number;
  mpesa: number;
  /** Sales total, all methods including credit. Not money received. */
  total: number;
  count: number;
  cashCount: CashCount | undefined;
  mpesaSales: Sale[];
  unsynced: number;
  /** Goods that left on credit today. Deliberately NOT money. */
  creditSales: number;
  creditCount: number;
  /**
   * Part-payments taken at the counter on today's credit sales — the money
   * side of "pay 200 now, owe 300". Split out from `repaid*` because they are
   * a different fact: this is change of hands at the till, not a debtor
   * walking in to clear an old book. Both raise expected cash identically, so
   * the drawer was never wrong either way; what would be wrong is telling the
   * owner an old debt came back when it did not.
   */
  paidAtTillCash: number;
  paidAtTillMpesa: number;
  /** What is still owed on today's credit sales after any part-payment. */
  creditOutstanding: number;
  /** OLD debt repaid today — a payment with no sale of its own attached. */
  repaidCash: number;
  repaidMpesa: number;
  /**
   * M-Pesa repayments, with their codes. These are real M-Pesa transactions on
   * the Safaricom statement, so they must appear in the tick-off list — an
   * M-Pesa payment the owner cannot find in the app is indistinguishable from
   * one that was never recorded.
   */
  mpesaRepayments: DebtEntry[];
  /**
   * M-Pesa money taken today with no confirmation code — sales and repayments
   * together. These are real transactions that CANNOT be ticked off against
   * the Safaricom statement, so the count is the price of making the code
   * optional, and the owner should be able to see it rather than discover it.
   */
  mpesaWithoutCode: number;
  /**
   * Sales reversed today. Shown as their OWN line, never netted into sales:
   * "sales 12,400, refunds -800, net 11,600" is the honest shape, and a single
   * 11,600 hides exactly what the owner most wants to see. Same rule credit
   * already follows.
   *
   * Dated by the day the money left the drawer, not the day of the original
   * sale — back-dating would make a past day that was already counted and
   * signed off silently stop balancing.
   */
  refunds: Refund[];
  /** Cash handed back today. A credit reversal moves no cash and is excluded. */
  refundedCash: number;
  /** Everything reversed today, including credit reversals. Not all money. */
  refundedTotal: number;
  /**
   * What should actually be in the drawer: cash sales PLUS cash repayments,
   * LESS any cash handed back.
   * A repayment is money arriving on a day with no sale, so leaving it out
   * makes the drawer read OVER — the same failure as counting a credit sale
   * as cash, with the sign flipped.
   */
  expectedCash: number;
  expectedMpesa: number;
}

export async function dayTotals(date: string): Promise<DayTotals> {
  const [sales, debtEntries, refunds] = await Promise.all([
    db.sales.where("business_date").equals(date).toArray(),
    db.debt_entries.where("business_date").equals(date).toArray(),
    db.refunds.where("business_date").equals(date).toArray(),
  ]);

  const sumBy = (rows: Sale[], method: PaymentMethod) =>
    rows.filter((s) => s.payment_method === method).reduce((sum, s) => sum + s.total, 0);

  const cash = sumBy(sales, "cash");
  const mpesa = sumBy(sales, "mpesa");
  const credit = sumBy(sales, "credit");

  const payments = debtEntries.filter((e) => e.kind === "payment");
  // A payment that names a sale was taken at the till alongside it; one that
  // names nothing is a debtor clearing an older book.
  const sum = (rows: DebtEntry[], method: RepaymentMethod) =>
    rows.filter((e) => e.payment_method === method).reduce((t, e) => t + e.amount, 0);
  const atTill = payments.filter((e) => e.sale_id);
  const oldDebt = payments.filter((e) => !e.sale_id);

  // An M-Pesa sale is refunded in CASH — there is no Daraja, so the app cannot
  // send M-Pesa. That means a refund always comes out of the drawer, whatever
  // column the original sale landed in, and expected M-Pesa is never touched.
  const refundedCash = refunds
    .filter((r) => r.settled_as === "cash")
    .reduce((t, r) => t + r.amount, 0);
  const refundedTotal = refunds.reduce((t, r) => t + r.amount, 0);

  const paidAtTillCash = sum(atTill, "cash");
  const paidAtTillMpesa = sum(atTill, "mpesa");
  const repaidCash = sum(oldDebt, "cash");
  const repaidMpesa = sum(oldDebt, "mpesa");

  return {
    date,
    cash: round2(cash),
    mpesa: round2(mpesa),
    total: round2(cash + mpesa + credit),
    count: sales.length,
    cashCount: await db.cash_counts.where("business_date").equals(date).first(),
    mpesaSales: sales
      .filter((s) => s.payment_method === "mpesa")
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    unsynced: sales.filter((s) => !s.synced_at).length,
    creditSales: round2(credit),
    creditCount: sales.filter((s) => s.payment_method === "credit").length,
    paidAtTillCash: round2(paidAtTillCash),
    paidAtTillMpesa: round2(paidAtTillMpesa),
    creditOutstanding: round2(credit - paidAtTillCash - paidAtTillMpesa),
    repaidCash: round2(repaidCash),
    repaidMpesa: round2(repaidMpesa),
    // Every M-Pesa payment from a debtor, part-payment or not: each one is a
    // real transaction on the Safaricom statement and has to be tickable.
    mpesaRepayments: payments
      .filter((e) => e.payment_method === "mpesa")
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    refunds: refunds.sort((a, b) => a.created_at.localeCompare(b.created_at)),
    refundedCash: round2(refundedCash),
    refundedTotal: round2(refundedTotal),
    mpesaWithoutCode:
      sales.filter((s) => s.payment_method === "mpesa" && !s.mpesa_code).length +
      payments.filter((e) => e.payment_method === "mpesa" && !e.mpesa_code).length,
    expectedCash: round2(cash + repaidCash + paidAtTillCash - refundedCash),
    expectedMpesa: round2(mpesa + repaidMpesa + paidAtTillMpesa),
  };
}
