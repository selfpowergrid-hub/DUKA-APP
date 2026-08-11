/**
 * `credit` means goods left the shop and money did not. It must never be
 * treated as a third place money lives — see Closing.
 */
export type PaymentMethod = "cash" | "mpesa" | "credit";
/** What a repayment can actually arrive as. Credit cannot repay credit. */
export type RepaymentMethod = "cash" | "mpesa";
/**
 * `reversal` is deliberately NOT `writeoff`. A write-off is a loss the owner
 * chose to absorb; a reversal is goods coming back, which is not a loss at
 * all. Recording one as the other would inflate the bad-debt figure on the
 * very screen built to make that figure honest.
 */
export type DebtEntryKind = "charge" | "payment" | "writeoff" | "reversal";
/**
 * A unit is just its code now — "pc", "litre", "gunia". It used to be a
 * Postgres enum, which meant a schema change and a redeploy every time a shop
 * needed a unit we had not thought of.
 */
export type ProductUnit = string;
export type MovementReason =
  | "sale"
  | "restock"
  | "opening"
  | "adjustment"
  | "damage"
  | "loss"
  /** Goods coming back on a refund. Not `restock` — that is a purchase. */
  | "return";
export type UserRole = "owner" | "attendant";

/** The reasons a human can pick on the adjustment screen. */
export type AdjustmentReason = "adjustment" | "damage" | "loss";

/** Fallback picker if the units table has not synced yet. */
export const FALLBACK_UNITS: ProductUnit[] = ["pc", "packet", "kg", "litre"];

export interface Unit {
  id: string;
  shop_id: string;
  code: string;
  label: string;
  /** Whether halves make sense. Drives whether Sell steps by 1 or by 0.5. */
  is_fractional: boolean;
  sort_order: number;
}

/**
 * A named measure drawn from ONE pool of stock: "½ litre" of a 20-litre drum.
 * `factor` is how much of the product's own unit a single portion consumes.
 *
 * This is the MEASURED case. Sealed pack sizes (a 1L bottle vs a 5L bottle)
 * are separate products sharing a `group_name` — their stock is independent
 * and must stay that way.
 */
export interface ProductPortion {
  id: string;
  shop_id: string;
  product_id: string;
  name: string;
  factor: number;
  price: number;
  sort_order: number;
}

export const MOVEMENT_LABELS: Record<MovementReason, string> = {
  sale: "Sale",
  restock: "Restock",
  opening: "Opening stock",
  adjustment: "Recount",
  damage: "Damaged",
  loss: "Lost or stolen",
  return: "Returned",
};

/** A shop member, pulled so reports can name who rang up what. */
export interface Customer {
  id: string;
  shop_id: string;
  name: string;
  phone: string | null;
  credit_limit: number | null;
  is_active: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One event in the debt ledger. Append-only: a mistake is corrected by another
 * entry, never by editing this one. `amount` is always positive — `kind`
 * carries the direction, because a signed amount plus a kind is two sources of
 * truth for one fact and they can disagree.
 */
export interface DebtEntry {
  id: string;
  shop_id: string;
  customer_id: string;
  user_id: string;
  kind: DebtEntryKind;
  amount: number;
  sale_id: string | null;
  payment_method: RepaymentMethod | null;
  mpesa_code: string | null;
  note: string | null;
  business_date: string;
  created_at: string;
  synced_at: string | null;
}

export type ReminderChannel = "whatsapp" | "sms" | "call" | "in_person";

/**
 * One attempt to get paid. Append-only, like every other ledger here.
 *
 * `balance_at_time` is the point of it: without it you cannot later see that
 * someone was chased at KES 1,000 and has since grown to KES 1,800.
 */
export interface DebtReminder {
  id: string;
  shop_id: string;
  customer_id: string;
  user_id: string;
  channel: ReminderChannel;
  balance_at_time: number;
  /** "nitalipa Ijumaa" — what turns a list into a work queue. */
  promised_date: string | null;
  note: string | null;
  created_at: string;
  synced_at: string | null;
}

/** Why a sale was reversed. A code, not free text, so it can be counted. */
export type RefundReason = "mis_key" | "returned" | "damaged";

export const REFUND_REASONS: Array<{
  key: RefundReason;
  label: string;
  hint: string;
  /** Do the goods come back sellable? `damaged` returns them, then writes off. */
  sellable: boolean;
}> = [
  {
    key: "mis_key",
    label: "Rung up wrong",
    hint: "Nothing left the shop — the sale itself was the mistake",
    sellable: true,
  },
  {
    key: "returned",
    label: "Customer brought it back",
    hint: "Goods are fine and go back on the shelf",
    sellable: true,
  },
  {
    key: "damaged",
    label: "Brought back damaged",
    hint: "Goods come back but cannot be sold — recorded as damage too",
    sellable: false,
  },
];

/**
 * A reversed sale. The sale itself is never edited or deleted; this is a new
 * record that points at it.
 */
export interface Refund {
  id: string;
  shop_id: string;
  sale_id: string;
  user_id: string;
  amount: number;
  /**
   * Where the money PHYSICALLY went back, which is not how the sale was paid.
   * An M-Pesa sale settles as "cash" — there is no Daraja, so the app cannot
   * send M-Pesa and says so instead of pretending.
   */
  settled_as: "cash" | "credit";
  reason: RefundReason;
  note: string | null;
  business_date: string;
  created_at: string;
  synced_at: string | null;
}

/**
 * A product photo, already compressed on the device.
 *
 * Kept apart from `Product` on purpose: the catalogue must load and be sellable
 * before any photo arrives, so the till is never waiting on a few megabytes
 * over a 2G connection.
 */
export interface ProductImage {
  /** The product IS the identity — one photo each, replaced in place. */
  product_id: string;
  shop_id: string;
  user_id: string;
  /** `data:image/webp;base64,...` — renderable directly, no object URLs. */
  data: string;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

/**
 * A delivery of one product, identified by the number printed on the carton.
 *
 * Its remaining quantity is NOT stored here — it is derived by summing the
 * movements that name it, exactly as `products.quantity` is derived from the
 * movement ledger. One source of truth, nothing that can desync.
 */
export interface ProductBatch {
  id: string;
  shop_id: string;
  product_id: string;
  /** As printed. Free text, because manufacturers use every format there is. */
  batch_no: string;
  /** A date, not a timestamp: cartons print months, not moments. */
  expiry_date: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export type ExpenseCategory =
  | "rent"
  | "salaries"
  | "transport"
  | "utilities"
  | "licences"
  | "airtime"
  | "repairs"
  | "other";

/**
 * Where the money physically came from.
 *
 * This is the field that decides whether the drawer should be lighter tonight,
 * which is why it is required rather than inferred.
 */
export type ExpenseSource = "till_cash" | "mpesa" | "other";

export const EXPENSE_CATEGORIES: Array<{ key: ExpenseCategory; label: string; hint: string }> = [
  { key: "rent", label: "Rent", hint: "Shop rent or ground fees" },
  { key: "salaries", label: "Wages", hint: "What you pay staff" },
  { key: "transport", label: "Transport", hint: "Fare, fuel, delivery, boda" },
  { key: "utilities", label: "Power & water", hint: "Electricity, water, gas" },
  { key: "licences", label: "Licences & fees", hint: "County permits, PPB, association" },
  { key: "airtime", label: "Airtime & data", hint: "For the shop line" },
  { key: "repairs", label: "Repairs", hint: "Fridge, shelving, the premises" },
  { key: "other", label: "Something else", hint: "Anything not covered above" },
];

export const EXPENSE_SOURCES: Array<{ key: ExpenseSource; label: string; hint: string }> = [
  {
    key: "till_cash",
    label: "Cash from the till",
    hint: "The drawer will be lighter tonight, and Closing expects that",
  },
  { key: "mpesa", label: "Shop M-Pesa", hint: "Sent from the shop's own M-Pesa" },
  { key: "other", label: "Own pocket or bank", hint: "Not from today's takings" },
];

/**
 * Money spent that is not stock.
 *
 * Buying stock is deliberately NOT an expense here: it already flows through
 * restock movements into cost of goods sold, and recording it twice would
 * count the same shilling twice and understate profit.
 *
 * Append-only. A mistyped amount is corrected by voiding, never by editing —
 * an expense that can be silently rewritten is an expense nobody can audit.
 */
export interface Expense {
  id: string;
  shop_id: string;
  user_id: string;
  category: ExpenseCategory;
  amount: number;
  paid_from: ExpenseSource;
  note: string | null;
  business_date: string;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface Staff {
  id: string;
  shop_id: string;
  role: UserRole;
  full_name: string | null;
}

export interface Category {
  id: string;
  shop_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  shop_id: string;
  name: string;
  unit: ProductUnit;
  buying_price: number;
  selling_price: number;
  /** Server-maintained cache of the movement ledger. Never write this locally. */
  quantity: number;
  low_stock_threshold: number;
  is_active: boolean;
  category_id: string | null;
  /** Off for things with no meaningful count — airtime, a carrier bag. */
  track_stock: boolean;
  /** Clusters sealed pack sizes for display only. Stock stays independent. */
  group_name: string | null;
  /**
   * Whether stock of this product is tracked per batch with an expiry date.
   * Off by default: a chemist also sells cotton wool, and demanding a batch
   * number for that trains staff to type rubbish into the field that matters.
   */
  track_batches: boolean;
  /** Prescription-only. Warns at the till. */
  is_pom: boolean;
  created_at: string;
  updated_at: string;
}

export interface Sale {
  id: string;
  shop_id: string;
  user_id: string;
  total: number;
  payment_method: PaymentMethod;
  amount_tendered: number | null;
  mpesa_code: string | null;
  business_date: string;
  created_at: string;
  synced_at: string | null;
  /** Set only on credit sales. Enforced by the payment-shape constraint. */
  customer_id: string | null;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  shop_id: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  line_total: number;
  portion_name: string | null;
  portion_factor: number | null;
  /** What actually left the stock pool, in the product's own unit. */
  base_quantity: number | null;
  /**
   * Buying price per base unit at the moment of sale. Null for sales recorded
   * before this was captured — report as unknown, never as zero, or a sale
   * shows a 100% margin and an owner prices something wrongly.
   */
  unit_cost: number | null;
}

export interface StockMovement {
  id: string;
  shop_id: string;
  product_id: string;
  user_id: string;
  delta: number;
  reason: MovementReason;
  buying_price: number | null;
  /** What was actually paid, when the invoice gives a total rather than a rate. */
  total_cost: number | null;
  sale_id: string | null;
  /**
   * Which batch this movement moved. Null for products that do not track
   * batches, and for everything recorded before batches existed — backfilling
   * a guess would be inventing history.
   */
  batch_id: string | null;
  note: string | null;
  note_ref: string | null;
  created_at: string;
  synced_at: string | null;
}

export interface CashCount {
  id: string;
  shop_id: string;
  user_id: string;
  business_date: string;
  counted_amount: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface Session {
  user_id: string;
  shop_id: string;
  shop_name: string;
  role: UserRole;
  full_name: string | null;
  email: string;
}

/** A line in the till before it becomes a sale. */
export interface CartLine {
  product_id: string;
  name: string;
  unit: ProductUnit;
  unit_price: number;
  /** Number of units, or number of portions when a portion is chosen. */
  quantity: number;
  /** Set only for measured products sold in named portions. */
  portion_id?: string | null;
  portion_name?: string | null;
  /** How much of the base unit one portion consumes. 1 when not portioned. */
  portion_factor?: number | null;
  /** Whether this product's unit allows halves. */
  fractional?: boolean;
}

export type OutboxKind =
  | "sale"
  | "movement"
  | "cash_count"
  /** An edit to an existing product. */
  | "product"
  /**
   * A brand new product, possibly with opening stock. One entry, not two:
   * the product and its opening movement must reach the server in a single
   * transaction or the movement can arrive before the row it points at.
   */
  | "new_product"
  | "category"
  | "unit"
  | "portions"
  | "customer"
  /** A repayment or write-off. Charges ride with their sale, never alone. */
  | "debt_entry"
  | "reminder"
  /** A reversed sale: the refund, its stock movements and any debt reversal. */
  | "refund"
  /** A product photo, or its removal. Never money — safe to overwrite. */
  | "product_image"
  /** A batch of stock: its number and, crucially, its expiry date. */
  | "batch"
  /** Money spent that is not stock. Counts against profit, and often the drawer. */
  | "expense";

/**
 * Outbox kinds that represent money. Discarding one of these means a sale or a
 * debt exists on this device and will never reach the server — on any other
 * device it simply does not exist. They are archived, never deleted, and the
 * confirmation names the amount.
 */
export const MONEY_KINDS: OutboxKind[] = ["sale", "debt_entry", "refund"];

/**
 * An outbox entry the shop gave up on sending.
 *
 * Kept, never deleted. The underlying cause is usually fixable — a product
 * renamed, a user promoted — and when it is, the entry can be put back in the
 * queue. Deleting it instead would destroy the only copy of a record that
 * never reached the server.
 */
export interface DiscardedEntry {
  id: string;
  kind: OutboxKind;
  entity_id: string;
  payload: unknown;
  last_error: string | null;
  /** A human summary captured at discard time, so the archive is readable. */
  summary: string;
  discarded_at: number;
  created_at: number;
}

export interface OutboxEntry {
  seq?: number;
  kind: OutboxKind;
  /** Row id this entry is about — used to clear local `synced_at` markers. */
  entity_id: string;
  payload: unknown;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}
