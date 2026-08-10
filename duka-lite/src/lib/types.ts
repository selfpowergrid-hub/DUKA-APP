/**
 * `credit` means goods left the shop and money did not. It must never be
 * treated as a third place money lives — see Closing.
 */
export type PaymentMethod = "cash" | "mpesa" | "credit";
/** What a repayment can actually arrive as. Credit cannot repay credit. */
export type RepaymentMethod = "cash" | "mpesa";
export type DebtEntryKind = "charge" | "payment" | "writeoff";
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
  | "loss";
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
  | "reminder";

/**
 * Outbox kinds that represent money. Discarding one of these means a sale or a
 * debt exists on this device and will never reach the server — on any other
 * device it simply does not exist. They are archived, never deleted, and the
 * confirmation names the amount.
 */
export const MONEY_KINDS: OutboxKind[] = ["sale", "debt_entry"];

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
