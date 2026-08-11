"use client";

import { db, META_KEYS, metaGet, metaSet } from "./db";
import { supabase, isSupabaseConfigured } from "./supabase";
import { MONEY_KINDS } from "./types";
import type { DiscardedEntry, OutboxEntry, Product, Session } from "./types";

/**
 * Sync engine.
 *
 * Contract:
 *   1. Nothing in the UI ever awaits this module. Every entry point is
 *      fire-and-forget; checkout must complete with the radio off.
 *   2. Push is idempotent. Every row we create carries a client-generated uuid
 *      that is its primary key, and the server RPCs are ON CONFLICT DO NOTHING.
 *      Replaying an outbox entry after a dropped connection is a no-op.
 *   3. An outbox entry is deleted only after the server confirms. A crash
 *      between confirm and delete replays — see (2), harmless.
 *   4. After a successful push we re-pull affected products BEFORE clearing the
 *      entries, so a movement is never missing from both the outbox and the
 *      server's cached quantity at the same time.
 */

export const MAX_ATTEMPTS = 8;
const POLL_MS = 30_000;
const BACKOFF_CAP_MS = 5 * 60_000;

export type SyncStatus = {
  online: boolean;
  pending: number;
  stuck: number;
  syncing: boolean;
  lastError: string | null;
  lastSyncAt: number | null;
};

type Listener = (s: SyncStatus) => void;

let status: SyncStatus = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  pending: 0,
  stuck: 0,
  syncing: false,
  lastError: null,
  lastSyncAt: null,
};

const listeners = new Set<Listener>();
let started = false;
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function getStatus(): SyncStatus {
  return status;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

function emit(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l(status));
}

async function refreshCounts() {
  const now = Date.now();
  const all = await db.outbox.toArray();
  emit({
    pending: all.length,
    stuck: all.filter((e) => e.attempts >= MAX_ATTEMPTS && e.next_attempt_at > now).length,
  });
}

// ---------------------------------------------------------------------------
// Enqueue — called from the write paths, always inside their Dexie transaction
// ---------------------------------------------------------------------------

export function outboxEntry(
  kind: OutboxEntry["kind"],
  entityId: string,
  payload: unknown,
): OutboxEntry {
  return {
    kind,
    entity_id: entityId,
    payload,
    attempts: 0,
    next_attempt_at: 0,
    last_error: null,
    created_at: Date.now(),
  };
}

/** Nudge the engine. Never awaited by UI code. */
export function kick(): void {
  void flush();
}

/** Does this entry represent money that would be lost if it never syncs? */
export function isMoneyEntry(entry: OutboxEntry): boolean {
  return MONEY_KINDS.includes(entry.kind);
}

/**
 * What a discarded entry actually was, in words, captured at discard time so
 * the archive stays readable after the payload shape has moved on.
 */
export function describeEntry(entry: OutboxEntry): string {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.kind) {
    case "sale": {
      const sale = p.sale as { total?: number; payment_method?: string } | undefined;
      return `Sale of KES ${Math.round(Number(sale?.total ?? 0)).toLocaleString("en-KE")}` +
        (sale?.payment_method ? ` (${sale.payment_method})` : "");
    }
    case "debt_entry":
      return `Debt ${String(p.kind ?? "entry")} of KES ${Math.round(
        Number(p.amount ?? 0),
      ).toLocaleString("en-KE")}`;
    case "new_product":
      return `New product "${String((p.product as { name?: string })?.name ?? "")}"`;
    case "product":
      return `Edit to "${String(p.name ?? "")}"`;
    case "movement":
      return `Stock change of ${String(p.delta ?? "")}`;
    case "cash_count":
      return `Cash count for ${String(p.business_date ?? "")}`;
    case "customer":
      return `Customer "${String(p.name ?? "")}"`;
    case "category":
      return `Category "${String(p.name ?? "")}"`;
    case "unit":
      return `Unit "${String(p.code ?? "")}"`;
    case "portions":
      return "Product measures";
    case "reminder":
      return "A debt reminder";
    case "refund": {
      const r = p.refund as { amount?: number; reason?: string } | undefined;
      return `Refund of KES ${Math.round(Number(r?.amount ?? 0)).toLocaleString("en-KE")}`;
    }
    case "product_image":
      return p.data ? "A product photo" : "A removed product photo";
    case "batch":
      return `Batch ${String(p.batch_no ?? "")} expiring ${String(p.expiry_date ?? "")}`;
    case "expense":
      return `Expense of KES ${Math.round(Number(p.amount ?? 0)).toLocaleString("en-KE")}` +
        (p.category ? ` (${String(p.category)})` : "");
  }
}

/**
 * Give up on sending a parked entry — but never destroy it.
 *
 * This used to be `db.outbox.delete(seq)`. For a rejected category that was
 * harmless; for a rejected credit sale it meant the sale and the debt existed
 * on one phone and would never reach the server, so on the owner's device the
 * debt simply did not exist. A shop cannot be asked to notice that.
 *
 * The entry moves to an archive instead: still readable, still re-queueable
 * once the cause is fixed (a renamed product, a promoted user). The only thing
 * that stops is the retrying.
 */
export async function discardOutboxEntry(seq: number): Promise<void> {
  const entry = await db.outbox.get(seq);
  if (!entry) return;

  const archived: DiscardedEntry = {
    id: `${entry.entity_id}:${entry.seq}`,
    kind: entry.kind,
    entity_id: entry.entity_id,
    payload: entry.payload,
    last_error: entry.last_error,
    summary: describeEntry(entry),
    discarded_at: Date.now(),
    created_at: entry.created_at,
  };

  await db.transaction("rw", [db.outbox, db.discarded], async () => {
    await db.discarded.put(archived);
    await db.outbox.delete(seq);
  });
  await refreshCounts();
}

/**
 * Put an archived entry back in the queue. The whole reason discarding archives
 * rather than deletes: the cause is usually fixable, and then the record should
 * go where it always belonged.
 */
export async function requeueDiscarded(id: string): Promise<void> {
  const archived = await db.discarded.get(id);
  if (!archived) return;

  await db.transaction("rw", [db.outbox, db.discarded], async () => {
    await db.outbox.add(outboxEntry(archived.kind, archived.entity_id, archived.payload));
    await db.discarded.delete(id);
  });
  await refreshCounts();
  kick();
}

/**
 * Everything on this device that has not reached the server, as plain text.
 *
 * A phone that dies takes its unsynced records with it — that is inherent to
 * offline-first and cannot be engineered away. What can be done is make the
 * exposure recoverable: one share into WhatsApp turns a lost phone into an
 * afternoon of retyping instead of lost debts.
 */
export async function unsyncedReport(): Promise<{ count: number; text: string }> {
  const [queued, archived] = await Promise.all([
    db.outbox.orderBy("seq").toArray(),
    db.discarded.toArray(),
  ]);
  const lines: string[] = [];

  if (queued.length) {
    lines.push(`NOT YET SENT (${queued.length})`);
    queued.forEach((e) =>
      lines.push(`  ${describeEntry(e)}${e.attempts >= MAX_ATTEMPTS ? "  [rejected]" : ""}`),
    );
  }
  if (archived.length) {
    if (lines.length) lines.push("");
    lines.push(`GIVEN UP ON (${archived.length})`);
    archived.forEach((a) => lines.push(`  ${a.summary}`));
  }
  if (!lines.length) lines.push("Everything on this device has reached the server.");

  return {
    count: queued.length + archived.length,
    text: [`Duka Lite — unsynced records`, new Date().toLocaleString("en-KE"), "", ...lines].join(
      "\n",
    ),
  };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function pushEntry(entry: OutboxEntry): Promise<void> {
  const sb = supabase();
  const payload = entry.payload as Record<string, unknown>;

  switch (entry.kind) {
    case "sale": {
      const { sale, items, movements } = payload as {
        sale: unknown;
        items: unknown;
        movements: unknown;
      };
      const { error } = await sb.rpc("sync_sale", {
        p_sale: sale,
        p_items: items,
        p_movements: movements,
      });
      if (error) throw new Error(error.message);
      return;
    }
    case "movement": {
      const { error } = await sb.rpc("sync_movement", { p_movement: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "cash_count": {
      const { error } = await sb.rpc("sync_cash_count", { p_count: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "new_product": {
      // Product + opening stock in one server transaction. See sync_new_product.
      const { product, opening, portions } = payload as {
        product: unknown;
        opening: unknown;
        portions: unknown;
      };
      const { error } = await sb.rpc("sync_new_product", {
        p_product: product,
        p_opening: opening ?? null,
        p_portions: portions ?? null,
      });
      if (error) throw new Error(error.message);
      return;
    }
    case "product": {
      // Edits to an existing product are owner-only and rare; a straight
      // upsert is enough and last-write-wins is the intended behaviour.
      const { error } = await sb.from("products").upsert(payload, { onConflict: "id" });
      if (error) throw new Error(error.message);
      return;
    }
    case "category": {
      const { error } = await sb.from("categories").upsert(payload, { onConflict: "id" });
      if (error) throw new Error(error.message);
      return;
    }
    case "unit": {
      const { error } = await sb.from("units").upsert(payload, { onConflict: "id" });
      if (error) throw new Error(error.message);
      return;
    }
    case "customer": {
      const { error } = await sb.from("customers").upsert(payload, { onConflict: "id" });
      if (error) throw new Error(error.message);
      return;
    }
    case "debt_entry": {
      const { error } = await sb.rpc("sync_debt_entry", { p_entry: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "reminder": {
      const { error } = await sb.rpc("sync_debt_reminder", { p_reminder: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "product_image": {
      const { error } = await sb.rpc("sync_product_image", { p_image: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "batch": {
      const { error } = await sb.rpc("sync_batch", { p_batch: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "expense": {
      const { error } = await sb.rpc("sync_expense", { p_expense: payload });
      if (error) throw new Error(error.message);
      return;
    }
    case "refund": {
      const body = payload as { refund: unknown; movements: unknown };
      const { error } = await sb.rpc("sync_refund", {
        p_refund: body.refund,
        p_movements: body.movements,
      });
      if (error) throw new Error(error.message);
      return;
    }
    case "portions": {
      // Replace-all in one server transaction, so a portion removed offline
      // cannot survive on the server.
      const { product_id, portions } = payload as { product_id: string; portions: unknown };
      const { error } = await sb.rpc("sync_portions", {
        p_product_id: product_id,
        p_portions: portions,
      });
      if (error) throw new Error(error.message);
      return;
    }
  }
}

/**
 * A failure that will never succeed on retry (constraint violation, bad data).
 * Retrying these forever would block every later entry in the queue.
 *
 * Two shapes were missing until an audit caught them, and both are reachable
 * in normal use, not just misuse:
 *   - "row-level security" — a write RLS correctly refuses (e.g. an attendant
 *     reaching an owner-only screen by URL rather than a hidden link). RLS was
 *     doing its job; this module just never recognised the failure as final.
 *   - "duplicate key value violates unique constraint" — two offline devices
 *     independently creating a product/category/unit with the same name. Not
 *     a misuse case at all, just two people working at once.
 * Both used to retry forever with growing backoff, and because sync_sale is
 * one atomic transaction, any SALE that referenced the thing that failed to
 * sync got its own foreign-key violation and was parked too — money taken
 * from a customer, never reaching the server, with only a raw Postgres error
 * string as the explanation.
 */
export function isPermanent(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("violates check constraint") ||
    m.includes("violates foreign key") ||
    m.includes("invalid input syntax") ||
    m.includes("violates not-null") ||
    m.includes("row-level security") ||
    m.includes("duplicate key value violates unique constraint")
  );
}

/**
 * A human explanation for a parked outbox entry, shown on the Settings screen.
 * Falls back to the raw server message when the shape is not one of the
 * common ones — better an ugly true sentence than a wrong friendly one.
 */
export function describeSyncError(message: string): string {
  const raw = message.replace(/^rejected:\s*/i, "");
  const m = raw.toLowerCase();
  if (m.includes("row-level security")) {
    return "This device tried to save something only the shop owner is allowed to change.";
  }
  if (m.includes("duplicate key value violates unique constraint")) {
    if (m.includes("products_shop_name_unique")) return "A product with this name already exists.";
    if (m.includes("categories_shop_name_unique")) return "A category with this name already exists.";
    if (m.includes("refunds_one_per_sale")) {
      return "That sale was already refunded, most likely on another device.";
    }
    if (m.includes("only an owner can record or void an expense")) {
      return "Only the owner can record an expense. Ask them to do it on their phone.";
    }
    if (m.includes("only an owner can refund")) {
      return "Only the owner can refund a sale. Ask them to do it on their phone.";
    }
    if (m.includes("units_shop_code_unique")) return "This unit already exists.";
    return "Something with the same name already exists.";
  }
  if (m.includes("violates foreign key")) {
    return "This depends on something that never made it to the server.";
  }
  if (m.includes("violates check constraint")) {
    return "The numbers on this entry do not add up and the server refused it.";
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/** Network only — the caller decides when to commit, so it can do so atomically. */
async function fetchProducts(session: Session, ids?: string[]): Promise<Product[]> {
  const sb = supabase();
  let query = sb.from("products").select("*").eq("shop_id", session.shop_id);
  if (ids && ids.length) {
    query = query.in("id", ids);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Product[];
}

async function pullProducts(session: Session, ids?: string[]) {
  const rows = await fetchProducts(session, ids);
  if (rows.length) await db.products.bulkPut(rows);
}

/**
 * Categories are a convenience, not part of the money. A shop whose database
 * has not had the categories migration applied yet must still be able to sign
 * in and sell — so this failure is swallowed rather than propagated. Without
 * that, a missing optional table takes down login for the whole shop.
 */
async function pullReferenceData(session: Session) {
  const sb = supabase();
  // Four independent queries, each guarded on its own. They used to run
  // categories/units/portions in parallel and staff AFTERWARD in sequence —
  // if that later call threw, the three already-successful results above it
  // were discarded for that whole cycle for no reason. Now one query failing
  // never costs the others anything, and the till does not depend on any of
  // this succeeding at all.
  const [cats, units, portions, staff, customers, shop, batches] = await Promise.allSettled([
    sb.from("categories").select("*").eq("shop_id", session.shop_id),
    sb.from("units").select("*").eq("shop_id", session.shop_id),
    sb.from("product_portions").select("*").eq("shop_id", session.shop_id),
    // The roster, so reports can put a name against a sale. An attendant only
    // sees themselves under RLS, which is correct — they get their own figures.
    sb.from("users").select("id, shop_id, role, full_name"),
    sb.from("customers").select("*").eq("shop_id", session.shop_id),
    // `select("*")` rather than naming the column: a shop whose database has
    // not had the 0008 migration applied yet would get a 400 for an unknown
    // column, and no optional setting is worth a failed sync cycle.
    sb.from("shops").select("*").eq("id", session.shop_id).maybeSingle(),
    // Batches ride with the catalogue rather than with activity: a batch is
    // part of what a product IS, and the till cannot dispense safely without
    // knowing what expires when.
    sb.from("product_batches").select("*").eq("shop_id", session.shop_id),
  ]);

  // Seed the reminder wording ONLY when this device has none. The local copy
  // always wins afterwards: this device's owner typed it, possibly offline, and
  // silently replacing their words on the next sync would be the worst kind of
  // surprise. The trade is that two devices can hold different wording — which
  // is a message, not money, and nobody is worse off for it.
  if (shop.status === "fulfilled" && !shop.value.error) {
    const template = (shop.value.data as { reminder_template?: string | null } | null)
      ?.reminder_template;
    if (template && !(await metaGet<string>(META_KEYS.reminderTemplate))) {
      await metaSet(META_KEYS.reminderTemplate, template);
    }
  }

  if (staff.status === "fulfilled" && staff.value.data?.length) {
    await db.staff.bulkPut(staff.value.data as never);
  }
  if (customers.status === "fulfilled" && customers.value.data?.length) {
    await db.customers.bulkPut(customers.value.data as never);
  }
  if (batches.status === "fulfilled" && !batches.value.error) {
    const pendingBatchIds = new Set(
      (await db.outbox.where("kind").equals("batch").toArray()).map((e) => e.entity_id),
    );
    const rows = ((batches.value.data ?? []) as Array<Record<string, unknown>>).filter(
      (b) => !pendingBatchIds.has(b.id as string),
    );
    if (rows.length) await db.product_batches.bulkPut(rows as never);
  }
  if (cats.status === "fulfilled" && cats.value.data?.length) {
    await db.categories.bulkPut(cats.value.data as never);
  }

  // Photos are fetched LAST and on their own, deliberately. They are by far the
  // heaviest thing this app syncs, and nothing on the till depends on them: a
  // product with no photo yet simply looks the way it did before the feature
  // existed. Fetching them alongside the catalogue would mean a fresh phone
  // waiting on a few megabytes over 2G before it could sell anything.
  //
  // Failure is swallowed for the same reason categories are: a shop whose
  // database has not had the 0011 migration yet must still be able to trade.
  await pullProductImages(session);
  if (units.status === "fulfilled" && units.value.data?.length) {
    await db.units.bulkPut(units.value.data as never);
  }
  // Replace-all: a portion deleted on another device must disappear here too,
  // and bulkPut alone would leave the stale row behind.
  if (portions.status === "fulfilled" && !portions.value.error) {
    await db.transaction("rw", db.portions, async () => {
      await db.portions.clear();
      if (portions.value.data?.length) await db.portions.bulkPut(portions.value.data as never);
    });
  }
}

/**
 * Product photos, pulled incrementally.
 *
 * Only rows newer than the newest one held locally are requested, so the
 * megabytes are paid for once rather than on every sync cycle. Photos with an
 * unsent local edit are skipped, so a slow server copy never overwrites a
 * change the owner just made on this phone.
 */
async function pullProductImages(session: Session) {
  try {
    const newest = await db.product_images.orderBy("updated_at").last();
    let query = supabase()
      .from("product_images")
      .select("*")
      .eq("shop_id", session.shop_id);
    if (newest?.updated_at) query = query.gt("updated_at", newest.updated_at);

    const { data, error } = await query;
    if (error || !data?.length) return;

    const pending = new Set(
      (await db.outbox.where("kind").equals("product_image").toArray()).map((e) => e.entity_id),
    );
    const rows = (data as Array<Record<string, unknown>>).filter(
      (r) => !pending.has(r.product_id as string),
    );
    if (rows.length) await db.product_images.bulkPut(rows as never);
  } catch {
    // Offline, or the table is not there yet. The till does not care.
  }
}

/**
 * How far back the device keeps activity. 62 days covers the longest report
 * period (30 days) plus the 30 before it for comparison, so reports work with
 * the radio off like every other screen. At roughly 100 sales a day that is
 * about 6,000 sales and 19,000 lines — a few MB, nothing for IndexedDB.
 *
 * The cost is a heavier FIRST sync after login; every later one is incremental.
 * Reports beyond this window would need connectivity, so the screen does not
 * offer them rather than quietly showing a wrong total.
 */
const HISTORY_DAYS = 62;

async function pullRecentActivity(session: Session) {
  const sb = supabase();
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);

  // Movements are keyed by created_at, not business_date.
  const sinceTs = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString();

  const [sales, counts, movements, debts, reminders, refunds, expenses, dispensing] =
    await Promise.all([
    sb.from("sales").select("*").eq("shop_id", session.shop_id).gte("business_date", since),
    sb.from("cash_counts").select("*").eq("shop_id", session.shop_id).gte("business_date", since),
    // Movements used to be pushed and never pulled back, which made the shrink
    // report device-local: an attendant's damage and loss records were
    // invisible on the owner's phone, and a fresh device showed an empty
    // history despite months of real trade. Stock QUANTITIES were always
    // right, because those ride on `products` — only the explanation was
    // missing, which is what made it easy to miss.
    sb
      .from("stock_movements")
      .select("*")
      .eq("shop_id", session.shop_id)
      .gte("created_at", sinceTs),
    // The WHOLE debt ledger, not just the window: a balance is the sum of
    // every entry ever, so truncating it to 62 days would silently forgive
    // older debt. Debt volume is tiny next to sales — a shop with a hundred
    // debtors has a few hundred rows, not tens of thousands.
    sb.from("debt_entries").select("*").eq("shop_id", session.shop_id),
    // Reminders, like the ledger itself, are pulled in full rather than
    // windowed: "when did we last chase this person" is exactly the question
    // that matters most about an old debt.
    sb.from("debt_reminders").select("*").eq("shop_id", session.shop_id),
    // Refunds are windowed with the rest of the activity: a refund older than
    // the history window belongs to a sale this device no longer holds.
    sb.from("refunds").select("*").eq("shop_id", session.shop_id).gte("business_date", since),
    sb.from("expenses").select("*").eq("shop_id", session.shop_id).gte("business_date", since),
    sb
      .from("dispensing_records")
      .select("*")
      .eq("shop_id", session.shop_id)
      .gte("business_date", since),
  ]);
  if (sales.error) throw new Error(sales.error.message);
  if (counts.error) throw new Error(counts.error.message);
  if (movements.error) throw new Error(movements.error.message);
  if (debts.error) throw new Error(debts.error.message);
  if (!dispensing.error && dispensing.data?.length) {
    await db.dispensing_records.bulkPut(dispensing.data as never);
  }
  if (!expenses.error && expenses.data?.length) {
    const pendingExpenseIds = new Set(
      (await db.outbox.where("kind").equals("expense").toArray()).map((e) => e.entity_id),
    );
    await db.expenses.bulkPut(
      (expenses.data as Array<Record<string, unknown>>).filter(
        (r) => !pendingExpenseIds.has(r.id as string),
      ) as never,
    );
  }
  if (!refunds.error && refunds.data?.length) {
    const pendingRefundIds = new Set(
      (await db.outbox.where("kind").equals("refund").toArray()).map((e) => e.entity_id),
    );
    await db.refunds.bulkPut(
      (refunds.data as Array<Record<string, unknown>>).filter(
        (r) => !pendingRefundIds.has(r.id as string),
      ) as never,
    );
  }
  if (!reminders.error && reminders.data?.length) {
    const pendingReminderIds = new Set(
      (await db.outbox.where("kind").equals("reminder").toArray()).map((e) => e.entity_id),
    );
    await db.debt_reminders.bulkPut(
      (reminders.data as Array<Record<string, unknown>>).filter(
        (r) => !pendingReminderIds.has(r.id as string),
      ) as never,
    );
  }

  if (debts.data?.length) {
    const pendingDebtIds = new Set(
      (await db.outbox.where("kind").anyOf("debt_entry", "sale").toArray()).flatMap((e) => {
        const p = e.payload as Record<string, unknown>;
        if (e.kind === "debt_entry") return [p.id as string];
        const sale = p.sale as { debt_entry_id?: string | null } | undefined;
        return sale?.debt_entry_id ? [sale.debt_entry_id] : [];
      }),
    );
    await db.debt_entries.bulkPut(
      (debts.data as Array<Record<string, unknown>>).filter(
        (d) => !pendingDebtIds.has(d.id as string),
      ) as never,
    );
  }

  if (movements.data?.length) {
    // Same rule as sales: never overwrite a local row still waiting in the
    // outbox, or we would mark something synced that has not been sent.
    const pendingMovementIds = new Set(
      (await db.outbox.where("kind").anyOf("movement", "sale", "new_product").toArray()).flatMap(
        (e) => {
          const p = e.payload as Record<string, unknown>;
          if (e.kind === "movement") return [p.id as string];
          if (e.kind === "sale") {
            return ((p.movements ?? []) as Array<{ id: string }>).map((m) => m.id);
          }
          const opening = p.opening as { id: string } | null | undefined;
          return opening ? [opening.id] : [];
        },
      ),
    );
    await db.stock_movements.bulkPut(
      (movements.data as Array<Record<string, unknown>>).filter(
        (m) => !pendingMovementIds.has(m.id as string),
      ) as never,
    );
  }

  const saleRows = (sales.data ?? []) as Array<Record<string, unknown>>;
  if (saleRows.length) {
    // Preserve local rows that are still queued: the server copy would say
    // synced_at, and we must not mark something synced that we haven't pushed.
    const pendingIds = new Set(
      (await db.outbox.where("kind").equals("sale").toArray()).map((e) => e.entity_id),
    );
    await db.sales.bulkPut(
      saleRows.filter((s) => !pendingIds.has(s.id as string)) as never,
    );

    const ids = saleRows.map((s) => s.id as string);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await sb.from("sale_items").select("*").in("sale_id", chunk);
      if (error) throw new Error(error.message);
      if (data?.length) await db.sale_items.bulkPut(data as never);
    }
  }

  if (counts.data?.length) {
    const pendingIds = new Set(
      (await db.outbox.where("kind").equals("cash_count").toArray()).map((e) => e.entity_id),
    );
    await db.cash_counts.bulkPut(
      (counts.data as Array<Record<string, unknown>>).filter(
        (c) => !pendingIds.has(c.id as string),
      ) as never,
    );
  }
}

/**
 * Drop local rows older than the sync window.
 *
 * `HISTORY_DAYS` bounded what was PULLED but nothing ever bounded what was
 * KEPT, so a device accumulated every sale, line and movement for ever — tens
 * of thousands of rows after a year on a phone that cost very little. The
 * server keeps the full history regardless; this only trims what this device
 * caches, and anything inside the window is re-pulled on the next sync.
 *
 * Deliberately keeps a week of slack beyond the window so a report at the far
 * edge of the range never reads a period this function has just emptied.
 */
async function pruneOldLocalData() {
  const cutoffDate = new Date(Date.now() - (HISTORY_DAYS + 7) * 86_400_000);
  const cutoffDay = cutoffDate.toISOString().slice(0, 10);
  const cutoffIso = cutoffDate.toISOString();

  // Never prune anything still waiting to sync, however old it looks.
  const queued = new Set((await db.outbox.toArray()).map((e) => e.entity_id));

  const staleSales = await db.sales.where("business_date").below(cutoffDay).toArray();
  const staleSaleIds = staleSales.filter((s) => !queued.has(s.id)).map((s) => s.id);

  await db.transaction(
    "rw",
    [db.sales, db.sale_items, db.stock_movements, db.cash_counts],
    async () => {
      if (staleSaleIds.length) {
        await db.sales.bulkDelete(staleSaleIds);
        await db.sale_items.where("sale_id").anyOf(staleSaleIds).delete();
      }
      const staleMoves = await db.stock_movements.where("created_at").below(cutoffIso).toArray();
      const removableMoves = staleMoves.filter((m) => !queued.has(m.id)).map((m) => m.id);
      if (removableMoves.length) await db.stock_movements.bulkDelete(removableMoves);

      const staleCounts = await db.cash_counts.where("business_date").below(cutoffDay).toArray();
      const removableCounts = staleCounts.filter((c) => !queued.has(c.id)).map((c) => c.id);
      if (removableCounts.length) await db.cash_counts.bulkDelete(removableCounts);
    },
  );
}

/**
 * Measure the gap between this device's clock and the server's. A phone with a
 * wrong date files sales on the wrong business day, which quietly corrupts the
 * one number this app exists to produce, so we surface it on Closing.
 */
async function measureClockSkew() {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      method: "HEAD",
      cache: "no-store",
    });
    const serverDate = res.headers.get("date");
    if (serverDate) {
      await metaSet(META_KEYS.clockSkewMs, new Date(serverDate).getTime() - Date.now());
    }
  } catch {
    /* skew detection is best-effort */
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function flush(): Promise<void> {
  if (running) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    emit({ online: false });
    await refreshCounts();
    return;
  }
  if (!isSupabaseConfigured()) return;

  const session = await metaGet<Session>(META_KEYS.session);
  if (!session) return;

  running = true;
  emit({ syncing: true });

  try {
    const now = Date.now();
    const due = (await db.outbox.orderBy("seq").toArray()).filter(
      (e) => e.next_attempt_at <= now,
    );

    const touchedProducts = new Set<string>();
    const doneSeqs: number[] = [];
    let hardFailure = false;

    for (const entry of due) {
      try {
        await pushEntry(entry);
        doneSeqs.push(entry.seq!);
        collectProductIds(entry, touchedProducts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = entry.attempts + 1;

        // Two ways an entry earns a park instead of a retry: the error shape
        // is one we recognise as never going to succeed, or it has simply
        // failed enough times that further retries are pointless. Either way
        // it must only isolate itself, never block entries queued after it —
        // that second condition is the safety net for a permanent failure
        // shaped in a way this module has not seen before.
        if (isPermanent(message) || attempts >= MAX_ATTEMPTS) {
          await db.outbox.update(entry.seq!, {
            attempts: Math.max(attempts, MAX_ATTEMPTS),
            next_attempt_at: now + BACKOFF_CAP_MS,
            last_error: `rejected: ${message}`,
          });
          emit({ lastError: message });
          continue;
        }

        await db.outbox.update(entry.seq!, {
          attempts,
          next_attempt_at: now + Math.min(2 ** attempts * 1000, BACKOFF_CAP_MS),
          last_error: message,
        });
        emit({ lastError: message });
        hardFailure = true;
        break; // almost certainly the network; stop hammering it
      }
    }

    if (doneSeqs.length) {
      // Fetch the server's new quantities BEFORE touching the outbox, then
      // commit the new quantities and the outbox removal in ONE transaction.
      //
      // Displayed stock = server quantity + pending outbox deltas. If these two
      // writes landed separately, there would be a window where a movement was
      // counted twice (server already has it, outbox still has it) or not at
      // all. One transaction means the UI only ever sees a consistent pair.
      const freshProducts = await fetchProducts(session, [...touchedProducts]);
      const syncedAt = new Date().toISOString();

      await db.transaction(
        "rw",
        [db.outbox, db.sales, db.cash_counts, db.products],
        async () => {
          if (freshProducts.length) await db.products.bulkPut(freshProducts);
          await db.outbox.bulkDelete(doneSeqs);

          const done = new Set(doneSeqs);
          for (const e of due) {
            if (!done.has(e.seq!)) continue;
            if (e.kind === "sale") {
              await db.sales.update(e.entity_id, { synced_at: syncedAt });
            } else if (e.kind === "cash_count") {
              await db.cash_counts.update(e.entity_id, { synced_at: syncedAt });
            }
          }
        },
      );
    }

    if (!hardFailure) {
      const lastPull = (await metaGet<number>(META_KEYS.lastPullAt)) ?? 0;
      if (Date.now() - lastPull > 20_000 || doneSeqs.length > 0) {
        await pullProducts(session);
        await pullReferenceData(session);
        await pullRecentActivity(session);
        await pruneOldLocalData();
        await metaSet(META_KEYS.lastPullAt, Date.now());
        void measureClockSkew();
      }
      emit({ lastError: null, lastSyncAt: Date.now() });
    }

    emit({ online: true });
  } catch (err) {
    emit({ lastError: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
    emit({ syncing: false });
    await refreshCounts();
  }
}

function collectProductIds(entry: OutboxEntry, into: Set<string>) {
  const p = entry.payload as Record<string, unknown>;
  if (entry.kind === "sale") {
    const movements = (p.movements ?? []) as Array<{ product_id: string }>;
    movements.forEach((m) => into.add(m.product_id));
  } else if (entry.kind === "movement") {
    into.add(p.product_id as string);
  } else if (entry.kind === "product") {
    into.add(p.id as string);
  } else if (entry.kind === "new_product") {
    const product = p.product as { id: string } | undefined;
    if (product) into.add(product.id);
  }
}

/** Full refresh from the server — used right after login. */
export async function pullAll(session: Session): Promise<void> {
  await pullProducts(session);
  await pullReferenceData(session);
  await pullRecentActivity(session);
  await pruneOldLocalData();
  await metaSet(META_KEYS.lastPullAt, Date.now());
  await measureClockSkew();
  await refreshCounts();
}

export function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("online", () => {
    emit({ online: true });
    kick();
  });
  window.addEventListener("offline", () => emit({ online: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });

  timer = setInterval(() => kick(), POLL_MS);
  void refreshCounts();
  kick();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
