"use client";

import Dexie, { type EntityTable } from "dexie";
import type {
  CashCount,
  Category,
  Customer,
  DebtEntry,
  DebtReminder,
  DiscardedEntry,
  Expense,
  ProductBatch,
  ProductImage,
  Refund,
  OutboxEntry,
  Product,
  ProductPortion,
  Sale,
  SaleItem,
  Staff,
  StockMovement,
  Unit,
} from "./types";

/**
 * The local store IS the app's database. Every screen reads from here and
 * nothing ever awaits the network to render. Supabase is a replica we push to.
 */
export class DukaDB extends Dexie {
  products!: EntityTable<Product, "id">;
  sales!: EntityTable<Sale, "id">;
  sale_items!: EntityTable<SaleItem, "id">;
  stock_movements!: EntityTable<StockMovement, "id">;
  cash_counts!: EntityTable<CashCount, "id">;
  categories!: EntityTable<Category, "id">;
  units!: EntityTable<Unit, "id">;
  portions!: EntityTable<ProductPortion, "id">;
  staff!: EntityTable<Staff, "id">;
  customers!: EntityTable<Customer, "id">;
  debt_entries!: EntityTable<DebtEntry, "id">;
  debt_reminders!: EntityTable<DebtReminder, "id">;
  refunds!: EntityTable<Refund, "id">;
  product_images!: EntityTable<ProductImage, "product_id">;
  product_batches!: EntityTable<ProductBatch, "id">;
  expenses!: EntityTable<Expense, "id">;
  discarded!: EntityTable<DiscardedEntry, "id">;
  outbox!: EntityTable<OutboxEntry, "seq">;
  meta!: EntityTable<{ key: string; value: unknown }, "key">;

  constructor() {
    super("duka-lite");
    this.version(1).stores({
      products: "id, shop_id, name, is_active, [shop_id+is_active], updated_at",
      sales: "id, shop_id, business_date, created_at, payment_method, synced_at",
      sale_items: "id, sale_id, product_id",
      stock_movements: "id, product_id, sale_id, created_at, synced_at, reason",
      cash_counts: "id, business_date, synced_at",
      outbox: "++seq, kind, entity_id, next_attempt_at",
      meta: "key",
    });

    // v2 — categories, plus category/track_stock on products. Dexie carries
    // unlisted stores forward untouched; the upgrade backfills the two new
    // product fields so existing local rows do not read as undefined.
    this.version(2)
      .stores({
        categories: "id, shop_id, name",
        products: "id, shop_id, name, is_active, category_id, [shop_id+is_active], updated_at",
      })
      .upgrade(async (tx) => {
        await tx
          .table("products")
          .toCollection()
          .modify((p: Product) => {
            if (p.category_id === undefined) p.category_id = null;
            if (p.track_stock === undefined) p.track_stock = true;
          });
      });

    // v3 — shop-defined units and measured-selling portions.
    this.version(3)
      .stores({
        units: "id, shop_id, code, sort_order",
        portions: "id, product_id, shop_id, sort_order",
        products: "id, shop_id, name, is_active, category_id, group_name, [shop_id+is_active], updated_at",
      })
      .upgrade(async (tx) => {
        await tx
          .table("products")
          .toCollection()
          .modify((p: Product) => {
            if (p.group_name === undefined) p.group_name = null;
          });
      });

    // v4 — the shop roster, so reports can name who rang up a sale.
    this.version(4).stores({ staff: "id, shop_id" });

    // v5 — customers and the debt ledger. `[customer_id+created_at]` is what
    // makes FIFO allocation cheap: the ledger is read per customer, in order.
    this.version(5).stores({
      customers: "id, shop_id, name, is_active",
      debt_entries: "id, customer_id, business_date, created_at, kind, [customer_id+created_at]",
    });

    // v6 — the chase, and the archive of entries the shop gave up on sending.
    this.version(6).stores({
      debt_reminders: "id, customer_id, created_at, promised_date",
      discarded: "id, kind, discarded_at",
    });

    // v7 — refunds. Indexed by sale_id because the question asked most often
    // is "has this sale already been refunded", once per row of the day's list.
    this.version(7).stores({
      refunds: "id, sale_id, business_date, created_at",
    });

    // v8 — product photos, keyed by product_id rather than an id of their own:
    // one photo per product, replaced in place, which makes every write an
    // upsert and removes a whole class of duplicate-row bug.
    this.version(8).stores({
      product_images: "product_id, shop_id, updated_at",
    });

    // v9 — batches and expiry. `[product_id+batch_no]` is what makes the same
    // delivery recorded twice collapse to one batch instead of splitting its
    // quantity in half and hiding some of it from the expiry report.
    this.version(9).stores({
      product_batches: "id, product_id, expiry_date, updated_at, [product_id+batch_no]",
    });

    // v10 — expenses. Indexed by business_date because both readers ask the
    // same question: what was spent on this day, or across these days.
    this.version(10).stores({
      expenses: "id, business_date, category, created_at",
    });
  }
}

export const db = new DukaDB();

export const META_KEYS = {
  session: "session",
  lastPullAt: "last_pull_at",
  clockSkewMs: "clock_skew_ms",
  /**
   * The reminder message the shop sends. Held in `meta` rather than the outbox
   * because it is a setting, not a record: it is edited once in a while, it
   * carries no money, and it must be changeable with the radio off. The server
   * keeps a copy (`shops.reminder_template`) purely so a second device or a
   * reinstall starts from the shop's own wording instead of the default.
   */
  reminderTemplate: "reminder_template",
} as const;

export async function metaGet<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** Wipe everything local. Used on sign-out and on shop mismatch. */
export async function clearLocalData(): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.products,
      db.sales,
      db.sale_items,
      db.stock_movements,
      db.cash_counts,
      db.categories,
      db.units,
      db.portions,
      db.staff,
      db.customers,
      db.debt_entries,
      db.debt_reminders,
      db.refunds,
      db.product_images,
      db.product_batches,
      db.expenses,
      db.discarded,
      db.outbox,
      db.meta,
    ],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.sales.clear(),
        db.sale_items.clear(),
        db.stock_movements.clear(),
        db.cash_counts.clear(),
        db.categories.clear(),
        db.units.clear(),
        db.portions.clear(),
        db.staff.clear(),
        db.customers.clear(),
        db.debt_entries.clear(),
        db.debt_reminders.clear(),
        db.refunds.clear(),
        db.product_images.clear(),
        db.product_batches.clear(),
        db.expenses.clear(),
        db.discarded.clear(),
        db.outbox.clear(),
        db.meta.clear(),
      ]);
    },
  );
}
