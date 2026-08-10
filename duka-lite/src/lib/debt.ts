"use client";

import { db } from "./db";
import { businessDate } from "./format";
import type { Customer, DebtEntry, DebtReminder, ReminderChannel } from "./types";

/**
 * Customer debt — balances, ageing and FIFO allocation.
 *
 * The ledger (`debt_entries`) is append-only and the ALLOCATION of payments to
 * debts is DERIVED here, never stored. That is the same shape `stock_movements`
 * uses for stock: an event log plus a computed answer.
 *
 * Why it matters, concretely:
 *   - The shopkeeper sees balance-forward simplicity ("Wanjiku owes 3,200")
 *     and never allocates a payment by hand.
 *   - Ageing stays exact, because FIFO tells us precisely which charges are
 *     still open and how old they are. Balance-forward alone cannot answer
 *     that, and ageing is the whole point: a 45% default rate on Kenyan
 *     shopkeeper credit means "owes 3,200, oldest 47 days" is the number that
 *     actually matters.
 *   - It is idempotent and offline-convergent for free. A pure function of an
 *     ordered event list has no state that can desync, double-apply, or need
 *     reconciling after two devices have both been writing.
 *
 * Ordering is `created_at` then `id`, exactly like the stock ledger, so every
 * device converges on the same allocation once synced.
 */

/**
 * Ageing buckets tuned for a duka, NOT the standard 30/60/90.
 *
 * Duka credit is extended against a payday or the end of the week. A debt that
 * has survived 30 days is not "current" — it is already in trouble. Buckets
 * that do not change what the owner does are decoration, so each of these
 * corresponds to a different action.
 */
export type AgeBucket = "normal" | "watch" | "chase" | "at_risk";

export const AGE_BUCKETS: Array<{
  key: AgeBucket;
  label: string;
  action: string;
  maxDays: number | null;
}> = [
  { key: "normal", label: "0–7 days", action: "Normal", maxDays: 7 },
  { key: "watch", label: "8–30 days", action: "Mention it next time", maxDays: 30 },
  { key: "chase", label: "31–60 days", action: "Worth a phone call", maxDays: 60 },
  { key: "at_risk", label: "60+ days", action: "Decide: plan or write off", maxDays: null },
];

export function bucketFor(ageDays: number): AgeBucket {
  if (ageDays <= 7) return "normal";
  if (ageDays <= 30) return "watch";
  if (ageDays <= 60) return "chase";
  return "at_risk";
}

/** A charge with however much of it is still unpaid after FIFO allocation. */
export interface OpenCharge {
  entry: DebtEntry;
  outstanding: number;
  ageDays: number;
  bucket: AgeBucket;
}

export interface CustomerDebt {
  customer: Customer;
  balance: number;
  /** Charges still open, oldest first. Empty when the customer is settled. */
  open: OpenCharge[];
  /** Age of the oldest unpaid charge. 0 when nothing is outstanding. */
  oldestDays: number;
  bucket: AgeBucket | null;
  totalCharged: number;
  totalPaid: number;
  totalWrittenOff: number;
  lastPaymentAt: string | null;
  /** True when a limit is set and the balance is at or past it. */
  overLimit: boolean;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso).getTime();
  return Math.max(0, Math.floor((to.getTime() - from) / 86_400_000));
}

/** Deterministic ledger order. Both devices must agree, so the tiebreak matters. */
export function sortLedger(entries: DebtEntry[]): DebtEntry[] {
  return [...entries].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

/**
 * Apply payments and write-offs to charges, oldest first.
 *
 * Payments are deliberately NOT matched to the sale they were "meant for" —
 * nobody at a counter says "this 200 is for Tuesday's bread". Oldest-first is
 * both what balance-forward accounting does implicitly and what a shopkeeper
 * means when they take money.
 *
 * Overpayment (paying more than is owed) leaves a negative balance rather than
 * being refused: it is real — customers round up, or pay ahead — and refusing
 * it would send the transaction back to the paper book.
 */
export function allocate(entries: DebtEntry[], now: Date = new Date()): {
  open: OpenCharge[];
  balance: number;
  credit: number;
} {
  const ordered = sortLedger(entries);
  const charges: Array<{ entry: DebtEntry; remaining: number }> = [];
  let pool = 0; // money received that has not yet been applied to a charge

  for (const e of ordered) {
    if (e.kind === "charge") {
      let remaining = e.amount;
      // Money already in hand settles this charge immediately — that is what
      // makes paying ahead work.
      if (pool > 0) {
        const used = Math.min(pool, remaining);
        remaining = round2(remaining - used);
        pool = round2(pool - used);
      }
      charges.push({ entry: e, remaining });
    } else {
      // Payments and write-offs both reduce what is owed; only their meaning
      // to the owner differs, and that is preserved in the ledger itself.
      let left = e.amount;
      for (const c of charges) {
        if (left <= 0) break;
        if (c.remaining <= 0) continue;
        const used = Math.min(left, c.remaining);
        c.remaining = round2(c.remaining - used);
        left = round2(left - used);
      }
      if (left > 0) pool = round2(pool + left);
    }
  }

  const open: OpenCharge[] = charges
    .filter((c) => c.remaining > 0.001)
    .map((c) => {
      const ageDays = daysBetween(c.entry.created_at, now);
      return {
        entry: c.entry,
        outstanding: round2(c.remaining),
        ageDays,
        bucket: bucketFor(ageDays),
      };
    });

  const balance = round2(open.reduce((t, c) => t + c.outstanding, 0) - pool);
  return { open, balance, credit: round2(pool) };
}

export function summarise(
  customer: Customer,
  entries: DebtEntry[],
  now: Date = new Date(),
): CustomerDebt {
  const { open, balance } = allocate(entries, now);
  const payments = entries.filter((e) => e.kind === "payment");

  return {
    customer,
    balance,
    open,
    oldestDays: open.length ? open[0].ageDays : 0,
    bucket: open.length ? open[0].bucket : null,
    totalCharged: round2(
      entries.filter((e) => e.kind === "charge").reduce((t, e) => t + e.amount, 0),
    ),
    totalPaid: round2(payments.reduce((t, e) => t + e.amount, 0)),
    totalWrittenOff: round2(
      entries.filter((e) => e.kind === "writeoff").reduce((t, e) => t + e.amount, 0),
    ),
    lastPaymentAt: payments.length ? sortLedger(payments).slice(-1)[0].created_at : null,
    overLimit:
      customer.credit_limit != null && balance >= customer.credit_limit && balance > 0,
  };
}

/**
 * EVERY customer with their current position, settled ones included.
 *
 * The till's customer picker needs this rather than `debtors()`: someone who
 * paid off last week is still a customer, and not finding them by name is how
 * a duplicate "Wanjiku (2)" gets created and a person's history splits in two.
 */
export async function customerSummaries(now: Date = new Date()): Promise<CustomerDebt[]> {
  const [customers, entries] = await Promise.all([
    db.customers.toArray(),
    db.debt_entries.toArray(),
  ]);
  const byCustomer = new Map<string, DebtEntry[]>();
  for (const e of entries) {
    const list = byCustomer.get(e.customer_id) ?? [];
    list.push(e);
    byCustomer.set(e.customer_id, list);
  }

  return customers
    .map((c) => summarise(c, byCustomer.get(c.id) ?? [], now))
    // Sorted by AGE, not by size. Age predicts default far better than amount,
    // and the top of this list should be who to call today.
    .sort((a, b) => b.oldestDays - a.oldestDays || b.balance - a.balance);
}

/** Every customer who currently owes something, riskiest first. */
export async function debtors(now: Date = new Date()): Promise<CustomerDebt[]> {
  return (await customerSummaries(now)).filter((d) => Math.abs(d.balance) > 0.001);
}

export async function customerDebt(
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerDebt | null> {
  const customer = await db.customers.get(customerId);
  if (!customer) return null;
  const entries = await db.debt_entries.where("customer_id").equals(customerId).toArray();
  return summarise(customer, entries, now);
}

export interface DebtTotals {
  outstanding: number;
  customers: number;
  byBucket: Record<AgeBucket, { amount: number; customers: number }>;
  /** Repayments received in the period, split by where the money landed. */
  repaidCash: number;
  repaidMpesa: number;
  writtenOff: number;
  chargedInPeriod: number;
}

/**
 * Shop-wide debt figures. `dates` scopes the flow figures (repayments, new
 * credit) to a period; the outstanding balance is always "as of now", because
 * a historical debt balance is not a question a shopkeeper asks.
 */
export async function debtTotals(dates: string[], now: Date = new Date()): Promise<DebtTotals> {
  const all = await debtors(now);
  const inPeriod = new Set(dates);
  const entries = await db.debt_entries.toArray();
  const periodEntries = entries.filter((e) => inPeriod.has(e.business_date));

  const byBucket = {
    normal: { amount: 0, customers: 0 },
    watch: { amount: 0, customers: 0 },
    chase: { amount: 0, customers: 0 },
    at_risk: { amount: 0, customers: 0 },
  } as Record<AgeBucket, { amount: number; customers: number }>;

  for (const d of all) {
    // A customer counts once, in the bucket of their OLDEST open charge —
    // that is the bucket that determines what the owner should do about them.
    if (d.bucket) byBucket[d.bucket].customers += 1;
    for (const c of d.open) {
      byBucket[c.bucket].amount = round2(byBucket[c.bucket].amount + c.outstanding);
    }
  }

  const sum = (fn: (e: DebtEntry) => boolean) =>
    round2(periodEntries.filter(fn).reduce((t, e) => t + e.amount, 0));

  return {
    outstanding: round2(all.reduce((t, d) => t + Math.max(0, d.balance), 0)),
    customers: all.filter((d) => d.balance > 0).length,
    byBucket,
    repaidCash: sum((e) => e.kind === "payment" && e.payment_method === "cash"),
    repaidMpesa: sum((e) => e.kind === "payment" && e.payment_method === "mpesa"),
    writtenOff: sum((e) => e.kind === "writeoff"),
    chargedInPeriod: sum((e) => e.kind === "charge"),
  };
}

/** Repayments on one business day, for Closing. */
export async function repaymentsOn(date: string): Promise<{ cash: number; mpesa: number }> {
  const entries = await db.debt_entries.where("business_date").equals(date).toArray();
  const payments = entries.filter((e) => e.kind === "payment");
  return {
    cash: round2(
      payments.filter((e) => e.payment_method === "cash").reduce((t, e) => t + e.amount, 0),
    ),
    mpesa: round2(
      payments.filter((e) => e.payment_method === "mpesa").reduce((t, e) => t + e.amount, 0),
    ),
  };
}

/** Credit extended on one business day — goods gone, money not here. */
export async function creditSoldOn(date: string): Promise<number> {
  const entries = await db.debt_entries.where("business_date").equals(date).toArray();
  return round2(
    entries.filter((e) => e.kind === "charge").reduce((t, e) => t + e.amount, 0),
  );
}

export function todayBusinessDate(): string {
  return businessDate();
}

// ---------------------------------------------------------------------------
// The chase
// ---------------------------------------------------------------------------
/**
 * A list of everyone who owes you is not a work queue. Thirty names sorted by
 * age tells the owner nothing about which three to deal with before the shop
 * gets busy — so they deal with none of them, which is how a 45% default rate
 * happens.
 *
 * What turns the list into a queue is the promise. "Nitalipa Ijumaa" is a date;
 * Friday either produced money or it did not. A broken promise is a far
 * stronger signal than age alone, and it is the moment to stop extending more
 * credit rather than the moment to write the debt off.
 */
export interface ChaseInfo {
  lastReminderAt: string | null;
  lastChannel: ReminderChannel | null;
  reminders: number;
  /** The most recent promise, if it has not already been settled by payment. */
  promisedDate: string | null;
  /** Promised date has passed and no money has arrived since the promise. */
  promiseBroken: boolean;
  /** Promised for today or still ahead — waiting is the correct action. */
  promisePending: boolean;
  daysSinceReminder: number | null;
  /** Why this person is in the chase list, in the owner's words. */
  reason: string;
}

export interface DebtorRow extends CustomerDebt {
  chase: ChaseInfo;
}

/** Days between two business dates (YYYY-MM-DD), positive when `b` is later. */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function chaseFor(
  debt: CustomerDebt,
  reminders: DebtReminder[],
  today: string,
  now: Date,
): ChaseInfo {
  const ordered = [...reminders].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const last = ordered.length ? ordered[ordered.length - 1] : null;
  const daysSinceReminder = last ? daysBetween(last.created_at, now) : null;

  // The live promise is the newest one made — an older promise is superseded
  // by a later conversation, not held against them twice.
  const promised = [...ordered].reverse().find((r) => r.promised_date) ?? null;
  let promisedDate = promised?.promised_date ?? null;
  // A promise kept is not a promise pending. Any payment after the promise was
  // made retires it, whether or not it cleared the whole balance: they came
  // back, which is the behaviour the promise was tracking.
  if (promised && debt.lastPaymentAt && debt.lastPaymentAt > promised.created_at) {
    promisedDate = null;
  }

  const overdueBy = promisedDate ? dayDiff(promisedDate, today) : 0;
  const promiseBroken = promisedDate != null && overdueBy > 0;
  const promisePending = promisedDate != null && overdueBy <= 0;

  let reason: string;
  if (promiseBroken) {
    reason = `Promised ${overdueBy === 1 ? "yesterday" : `${overdueBy} days ago`}, nothing since`;
  } else if (promisePending) {
    reason = overdueBy === 0 ? "Promised today" : `Promised in ${-overdueBy} days`;
  } else if (!last) {
    reason = debt.oldestDays > 7 ? `${debt.oldestDays} days, never chased` : "New";
  } else {
    reason =
      daysSinceReminder === 0
        ? "Chased today"
        : `Chased ${daysSinceReminder} day${daysSinceReminder === 1 ? "" : "s"} ago`;
  }

  return {
    lastReminderAt: last?.created_at ?? null,
    lastChannel: last?.channel ?? null,
    reminders: ordered.length,
    promisedDate,
    promiseBroken,
    promisePending,
    daysSinceReminder,
    reason,
  };
}

/** Lower sorts first. Broken promises outrank everything, then age. */
function chaseRank(d: DebtorRow): number {
  if (d.chase.promiseBroken) return 0;
  if (d.chase.promisePending) return 3; // waiting is the correct action
  if (d.chase.lastReminderAt == null) return 1;
  return 2;
}

/**
 * Split debtors into "deal with these today" and "everything else".
 *
 * `due` is deliberately kept short. A queue of thirty is the same as no queue,
 * and the shop has a counter to run.
 */
export async function chaseList(
  now: Date = new Date(),
): Promise<{ due: DebtorRow[]; later: DebtorRow[] }> {
  const [all, reminders] = await Promise.all([debtors(now), db.debt_reminders.toArray()]);
  const today = businessDate(now);

  const byCustomer = new Map<string, DebtReminder[]>();
  for (const r of reminders) {
    const list = byCustomer.get(r.customer_id) ?? [];
    list.push(r);
    byCustomer.set(r.customer_id, list);
  }

  const rows: DebtorRow[] = all
    .filter((d) => d.balance > 0.001) // customers in credit are not chased
    .map((d) => ({ ...d, chase: chaseFor(d, byCustomer.get(d.customer.id) ?? [], today, now) }));

  const isDue = (d: DebtorRow) => {
    if (d.chase.promiseBroken) return true;
    if (d.chase.promisePending) return d.chase.promisedDate === today;
    // Silence is what lets a debt drift. Something old that has never been
    // raised, or was raised a week ago and produced nothing, is worth a minute.
    const stale = d.chase.daysSinceReminder == null || d.chase.daysSinceReminder >= 7;
    return stale && (d.bucket === "chase" || d.bucket === "at_risk" || d.oldestDays > 14);
  };

  const order = (a: DebtorRow, b: DebtorRow) =>
    chaseRank(a) - chaseRank(b) || b.oldestDays - a.oldestDays || b.balance - a.balance;

  return {
    due: rows.filter(isDue).sort(order),
    later: rows.filter((d) => !isDue(d)).sort(order),
  };
}

/** The chase history for one customer, newest first. */
export async function remindersFor(customerId: string): Promise<DebtReminder[]> {
  const rows = await db.debt_reminders.where("customer_id").equals(customerId).toArray();
  return rows.sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
}
