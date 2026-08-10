# Debt management & inventory review

Research report. **Nothing has been implemented.** Decisions needed at §1.9 and §2.7.

---

# PART 1 — DEBT MANAGEMENT

## 1.1 The research reframes this feature entirely

I expected to be designing a bookkeeping feature. The data says it is a **loss-prevention**
feature, and that changes what should be built.

| Finding | Source |
|---|---|
| **90%+ of dukas offer customer credit** — near-universal, not a niche case | BFA Global field study |
| 50% of Nairobi dukas extend credit (a more conservative figure — sources disagree, see below) | Kenyan Wall Street / FinAccess |
| **Shopkeeper credit is the single largest source of credit in Kenya** — bigger than family, friends, mobile banks or banks | Kenya Financial Sector Stability Report |
| **~45% default rate on shopkeeper goods-and-services credit** | FinAccess 2019, via FSD Kenya digital credit audit |

That last number deserves its own line. Compare it against every other credit type measured in
the same survey:

```
Shopkeeper (goods/services)   45%   ←
Digital loan apps             18%
Mobile bank loans             13%
Friends and family             9%
Banks                          2%
```

**A duka owner is running the riskiest loan book in the country, on paper, from memory.** Roughly
two out of every five shillings lent across the counter never comes back. The two sources
disagree on how many shops lend (50% vs 90%+) — likely different samples and definitions — but
they agree completely that it is widespread and that losses are severe.

The traditional instrument is a black counter book. The documented failure modes are almost
comic and entirely real: the book goes missing, items get written at the wrong price, and
children help themselves to stock that is then recorded as debt owed by nobody.

**Design consequence:** a feature that only records debts accurately would still let an owner
lend their way out of business. What the numbers argue for is a feature that makes exposure
*visible* — who owes, for how long, and how much of the shop's working capital is currently
sitting in other people's houses.

## 1.2 The correctness requirement that outranks everything else

This app exists to answer one question: **how much should be in cash, and how much in M-Pesa.**
Credit sales break that arithmetic if modelled naively, and the failure is silent.

Three rules follow, and they are not negotiable:

1. **A credit sale must never count toward expected cash.** Goods left the shop; money did not.
   Booking it as a cash sale makes the drawer read short by exactly that amount — which is
   indistinguishable from theft, the precise ambiguity the whole app exists to remove.
2. **A repayment IS money arriving**, on a day that has no sale attached to it. If Closing does
   not account for it, the drawer reads *over* — the same failure with the sign flipped.
3. **A repayment has its own payment method.** Someone can settle a debt in cash or by M-Pesa,
   and it must land in the right column.

So Closing's arithmetic becomes:

```
Expected cash    = cash sales    + cash repayments
Expected M-Pesa  = M-Pesa sales  + M-Pesa repayments
Credit sales     = shown separately, explicitly NOT money
```

I would show credit as a **third figure with a visibly different treatment** — not a third
colour peer to cash and M-Pesa, but something that reads as "goods gone, money not here yet".
Cash and M-Pesa are money in two places. Credit is not money at all, and the screen should not
imply otherwise.

## 1.3 The core architectural decision: derived allocation

The one genuinely hard modelling question is **how a repayment attaches to specific debts.**
Accounting offers two established answers:

| | **Balance-forward** | **Open-item** |
|---|---|---|
| How it works | Customer has one running balance; payments reduce it | Each payment is matched to specific invoices |
| Strength | Simple — matches how a shopkeeper thinks ("Wanjiku owes 3,200") | Exact — you know precisely which debts are still open |
| Weakness | Cannot compute ageing: no idea which part of the balance is old | Burdensome — someone must allocate every payment by hand |

For a duka, balance-forward is obviously right for the interface and obviously wrong for the
risk management — **ageing is the entire value of the feature**, and balance-forward cannot
produce it. "Wanjiku owes 3,200" is far less useful than "Wanjiku owes 3,200, oldest 47 days".

**My recommendation is neither, or rather both:** store an append-only ledger of credit sales
and repayments, and **derive** the allocation FIFO — oldest debt first — at read time. Never
store the allocation.

This is not a compromise, it is strictly better here, and it falls out of the architecture this
app already has:

- **The interface stays balance-forward.** The shopkeeper sees one number per customer and never
  allocates anything by hand.
- **Ageing stays exact**, because FIFO allocation over the ledger tells you precisely which sales
  remain unpaid and how old they are.
- **It is idempotent by construction.** Allocation is a pure function of the event list, so
  there is no allocation state that can desync, double-apply, or need reconciling.
- **It is offline-safe.** Two devices each append events; once synced, both compute the same
  allocation from the same ordered list. Convergence is automatic, provided ordering is
  deterministic (`created_at`, then `id` as tiebreak — the same rule the stock ledger uses).

**This is exactly the pattern `stock_movements` already uses.** Stock is an append-only ledger of
deltas with a derived quantity; debt becomes an append-only ledger of charges and payments with a
derived balance and ageing. One idea, applied twice. That consistency is worth a great deal —
it means the sync engine, the idempotency guarantees and the offline behaviour all work the way
they already do, with nothing new to reason about.

## 1.4 Proposed schema

```sql
-- Minimal by design. NOT a customer relationship feature: no loyalty, no
-- marketing, no purchase history. The brief was right to exclude customers;
-- it is debt that needs them, and only barely.
create table public.customers (
  id           uuid primary key,
  shop_id      uuid not null references public.shops,
  name         text not null,
  phone        text,                    -- how you actually chase a debt
  credit_limit numeric(12,2),           -- null = no limit set
  is_active    boolean not null default true,
  created_at   timestamptz not null,
  updated_at   timestamptz not null
);
create unique index customers_shop_phone_unique
  on public.customers (shop_id, phone) where phone is not null;

-- The ledger. Append-only, like stock_movements.
--   charge   (+) a credit sale        — always tied to a sale
--   payment  (-) a repayment          — has its own payment method
--   writeoff (-) owner gives up on it — an explicit, visible decision
create type public.debt_entry_kind as enum ('charge', 'payment', 'writeoff');

create table public.debt_entries (
  id             uuid primary key,       -- client-generated, as everywhere
  shop_id        uuid not null references public.shops,
  customer_id    uuid not null references public.customers,
  user_id        uuid not null references public.users,
  kind           public.debt_entry_kind not null,
  amount         numeric(12,2) not null check (amount > 0),  -- always positive; kind carries sign
  sale_id        uuid references public.sales,               -- charges only
  payment_method public.payment_method,                      -- payments only
  mpesa_code     text,
  note           text,
  business_date  date not null,          -- so Closing can find it
  created_at     timestamptz not null,
  synced_at      timestamptz not null default now(),
  constraint debt_entry_shape check (
    (kind = 'charge'   and sale_id is not null and payment_method is null) or
    (kind = 'payment'  and sale_id is null     and payment_method is not null) or
    (kind = 'writeoff' and sale_id is null     and payment_method is null)
  )
);
```

Plus, on `sales`:

```sql
alter type public.payment_method add value 'credit';   -- separate migration file
alter table public.sales add column customer_id uuid references public.customers;
```

**Two things to flag about that enum change.** First, adding an enum value must go in its own
migration file, committed before anything references it — the same constraint that forced
`0003a`/`0003b` apart. Second, and more importantly, `sales_payment_shape` currently reads:

```sql
(payment_method = 'cash'  and amount_tendered is not null and amount_tendered >= total and mpesa_code is null)
or (payment_method = 'mpesa' and mpesa_code is not null and amount_tendered is null)
```

That constraint is doing real work — it is what makes a cash sale provably a cash sale. It must
gain a `credit` branch requiring `customer_id is not null` and both money fields null.
**Existing rows are unaffected**, so this is a safe alteration, but it is the single most
load-bearing constraint in the schema and worth changing deliberately.

## 1.5 Ageing buckets, tuned for a duka

Standard AR practice is 0–30 / 31–60 / 61–90 / 90+ days, with collection rates falling sharply
past 90 days (industry figures put 90-day-plus collection at roughly 70%).

**Those buckets are wrong for this shop.** Duka credit is extended against a payday, a harvest,
or the end of the week. A debt that has survived 30 days is not "current" — it is already in
trouble. I would propose:

```
0–7 days      Normal        — the ordinary "pay me Friday" case
8–30 days     Watch         — worth a mention when they next come in
31–60 days    Chase         — needs an actual phone call
60+ days      At risk       — decide: payment plan, or write it off
```

The point of the buckets is not accounting nicety, it is prompting a **different action** at each
stage. Buckets that do not change what the owner does are decoration.

## 1.6 Screens

- **Debtors list** — the feature people will actually open daily. Every customer with a balance,
  sorted by risk (oldest first, not largest first — age predicts default better than size).
  Total owed at the top: *this is how much of your shop is sitting in other people's houses.*
- **Customer page** — full ledger, running balance, oldest unpaid debt, one-tap "Record payment"
  and a WhatsApp/call link to the phone number.
- **Sell screen** — "Credit" as a third payment button. It **must** require choosing a customer;
  a debt owed by nobody is the paper book's worst failure mode reproduced digitally.
- **Closing** — credit sales shown separately, repayments folded into expected cash/M-Pesa per
  §1.2.
- **Reports** — total outstanding, debt aged into the buckets above, and repayments received in
  the period.

## 1.7 The offline problem, and where it genuinely bites

Most of this inherits the existing architecture cleanly. One case does not.

**A credit sale is two rows** — the sale and the `charge` entry — and they must reach the server
atomically, exactly like a product and its opening stock. This is the same foreign-key ordering
trap already solved twice: a charge pushed before its sale exists is an FK violation, which the
sync engine now classifies as permanent and parks. So credit sales must extend `sync_sale`
rather than queue a second outbox entry.

**Credit limits cannot be enforced reliably offline.** Two devices can each approve credit that,
combined, breaches the limit — neither can see the other. This is the same class of race as
overselling stock, and it has the same honest answer: **treat the limit as a warning, not a
lock.** Blocking a sale on a stale local balance would refuse legitimate credit for a customer
who paid up on the other till an hour ago, which is worse than the overshoot. Warn loudly at the
point of sale; reconcile on sync.

## 1.8 Decisions I need

**1.8.1 — Partial payment at the point of sale.** *(the one that most affects scope)*
"Nipe hii, nitalipa mia mbili sasa" — pay 200 now, owe 300 — is extremely common. Supporting it
means a sale can have two payment methods at once, which complicates the shape constraint that
currently guarantees a cash sale is a cash sale.
- **A — No split payments.** A sale is cash, M-Pesa, *or* credit. Partial payment is recorded as
  a full credit sale plus an immediate repayment — two taps, and the ledger comes out identical.
  *Recommended: it keeps the constraint intact and costs the attendant almost nothing.*
- **B — Native split payments.** One tap, materially more schema and UI complexity.

**1.8.2 — Write-offs: who, and does it need a reason?** My schema includes `writeoff` as an
explicit, visible ledger entry rather than a silent deletion, and I would make it owner-only.
Confirm you want that, and whether a reason should be mandatory.

**1.8.3 — Credit limits: default on or off?** Given the 45% default rate I lean toward
prompting for a limit when a customer is first created, defaulting to a modest figure rather than
unlimited. That is a nudge with real teeth, and also the most paternalistic thing in this
proposal — your call.

**1.8.4 — Does a credit sale reduce stock immediately?** Almost certainly yes; the goods have
left the shop. Worth confirming explicitly, because it means stock and revenue diverge in time
for the first time in this app.

---

# PART 2 — INVENTORY SYSTEM REVIEW

I audited the actual code rather than describing it from memory. Four findings, two of which are
real defects.

## 2.1 What is genuinely strong

Worth stating plainly, because it is the foundation the rest depends on:

- **Stock is a ledger, not a number.** `products.quantity` is a trigger-maintained cache of
  `stock_movements`, and no client is granted permission to write that column. Every count is
  explainable by a list of movements. This is the correct design and it is properly enforced.
- **Six movement reasons** (`opening`, `restock`, `sale`, `adjustment`, `damage`, `loss`) with
  shape constraints on each — damage cannot be positive, restock cannot be negative, a recount
  can go either way.
- **Idempotent intake.** `sync_new_product` and `sync_sale` are single transactions with
  `ON CONFLICT DO NOTHING`; replays are provably no-ops.
- **Measured selling and pack groups** handle the cooking-oil problem properly — one pool sold in
  portions, versus sealed sizes with genuinely independent stock.
- **Cost at time of sale** is now captured on `sale_items.unit_cost`, so gross profit no longer
  silently rewrites itself when buying prices change.

## 2.2 Finding — stock movements are push-only and never pulled back

```
sync.ts pulls:  products, categories, units, product_portions,
                users, sales, sale_items, cash_counts
sync.ts never pulls:  stock_movements
```

Movements are pushed to the server and never fetched back. Three consequences, in increasing
severity:

1. **The shrink report is device-local.** Reports → "Stock movement" reads
   `db.stock_movements.toArray()`, so the owner's phone shows only movements the owner's phone
   created. An attendant's damage and loss records are **invisible on the owner's device** — and
   the owner is precisely the person that report exists for.
2. **A fresh device shows an empty history.** New phone, reinstall, or signing in on a second
   handset yields an empty stock-movement report despite months of real shop history. Stock
   *quantities* are correct, because those come from the server on `products`. Only the
   explanation is missing.
3. **It fails in exactly the scenario it matters most.** A single-device shop is fine. A
   multi-device shop — the one where shrinkage is hardest to attribute and most worth
   investigating — is the one that gets an incomplete report, with no indication it is
   incomplete.

The quantities being correct is what makes this dangerous: the report renders plausibly and is
simply missing rows.

## 2.3 Finding — stock is valued at latest cost, not weighted average

`products.buying_price` is **overwritten on every restock** (`sync_movement` does this on the
restock branch), and everything values stock at that latest figure:

```ts
atCost: tracked.reduce((t, p) => t + p.quantity * p.buying_price, 0)   // reports.ts:320
const buy = productById.get(m.product_id)?.buying_price ?? 0;          // reports.ts:311 — damage/loss
```

So when unga is restocked at a higher price, **every packet already on the shelf instantly
revalues upward**, and damage that occurred last week is costed at this week's price. This is
"latest cost" valuation, which is not one of the recognised methods (FIFO or weighted average) —
it overstates stock value and understates historic shrinkage during rising prices. Kenyan staple
prices have moved sharply in recent years, so this is not a theoretical concern.

The fix is genuinely cheap — a moving weighted average, maintained incrementally on each restock:

```
new_avg_cost = (old_qty × old_avg_cost + received_qty × received_cost)
               ÷ (old_qty + received_qty)
```

One formula, computed where `buying_price` is already being updated. It would make stock
valuation, COGS and damage valuation all consistent and defensible. Full FIFO cost layering
would be more accurate still, but it is a substantially larger change and weighted average is
the standard recommendation for small retail precisely because it is stable and simple.

Note this also affects `sale_items.unit_cost`, which currently captures the latest buying price
at the moment of sale. That was a real improvement over reading the price at report time, but it
is still latest-cost rather than weighted-average cost. Worth being precise about: **gross profit
is now stable over time, but not yet strictly correct.**

## 2.4 Finding — unbounded local growth, and reports that scan everything

Nothing prunes local data. `clearLocalData()` only runs on sign-out, and `HISTORY_DAYS = 62`
bounds what is *pulled*, not what is *retained*. Meanwhile `buildReport()` does:

```ts
db.sales.toArray()        // every sale ever, then filtered in JS
db.sale_items.toArray()   // every line ever
db.stock_movements.toArray()
```

At ~100 sales/day that is roughly 36,500 sales and 110,000 line items after a year — all loaded
into memory on a cheap Android phone every time the Reports screen renders or the period
changes. It is fine today and will degrade steadily. `dayTotals()` by contrast correctly uses an
index (`where("business_date")`), so the pattern to follow already exists in the codebase.

Two straightforward fixes: query by indexed date range instead of scanning, and prune local rows
older than the retention window.

## 2.5 Finding — the ledger is never visible to the user

`stock_movements` is written on every sale, restock and adjustment, and read only by the reports
aggregation. **There is no screen anywhere that shows a product's stock history.**

So when an owner looks at "Unga Jogoo 2kg — 14 in stock" and believes it should be 20, the app
cannot answer the obvious next question: *why?* The data to answer it is right there —
every movement, with reason, timestamp, user and note. It is simply never shown.

This is the cheapest high-value screen remaining in the app: a per-product movement list, reached
by tapping a product. It also makes the adjustment feature trustworthy, because a recount stops
being a number that silently changed and becomes an entry someone can point at. (It depends on
2.2 being fixed first, or it shows only this device's half of the story.)

## 2.6 Gaps against standard practice, ranked

| Gap | Severity | Note |
|---|---|---|
| Movements never pulled → incomplete shrink report | **High** | §2.2. Silent and multi-device only |
| Latest-cost instead of weighted-average valuation | **Medium** | §2.3. Cheap fix, real accuracy gain |
| No stock history screen | **Medium** | §2.5. Data exists; only the screen is missing |
| Unbounded growth + full scans in reports | **Medium** | §2.4. Degrades over time, not broken today |
| No expiry / batch tracking | **Medium** | Already in `BACKLOG.md`. Matters most for the milk, bread and eggs this shop stocks |
| No supplier on restock | Low | Deliberately excluded by the brief |
| No barcode support | Low | Deliberately excluded by the brief |
| No stock-take / cycle-count mode | Low | Recount exists per product; no guided full count |
| No reorder suggestions from sales velocity | Low | Low-stock threshold is manual and static |

## 2.7 What I would do, and in what order

1. **Pull stock movements** (§2.2). It is a correctness bug in a loss-prevention report, and the
   smallest of the three fixes.
2. **Weighted-average cost** (§2.3). One formula; makes valuation, COGS and shrink figures
   consistent.
3. **Per-product stock history screen** (§2.5). Highest value per unit of effort in the app right
   now, and it makes 1 and 2 legible to the owner.
4. **Indexed report queries + local pruning** (§2.4). Before the data volume makes it urgent.

Debt is a larger piece of work than all four combined. My recommendation is to fix **2.2 and 2.3
first** — they are small, they are defects rather than features, and debt reporting will
otherwise inherit the same valuation inconsistency on day one.

---

## Sources

**Debt / credit**
- [FSD Kenya — Digital credit audit report (default rates by credit type, FinAccess 2019)](https://www.fsdkenya.org/wp-content/uploads/2020/03/Digital-Credit-audit-report.pdf)
- [FSD Kenya — Inclusive Finance? Headline findings from FinAccess 2019](https://fsdkenya.org/wp-content/uploads/2019/07/Inclusive_Finance_headline-findings-from_FinAccess.pdf)
- [BFA Global — A Day in the Life of a Shopkeeper](https://bfaglobal.com/fibr/insights/a-day-in-the-life-of-a-shopkeeper/)
- [The Standard — "No deni in my duka": app for shopkeeper debt management](https://www.standardmedia.co.ke/entertainment/county-nairobi/article/2000212324/no-deni-in-my-duka-man-develops-app-that-allows-shopkeepers-to-manage-debts)
- [Kenyan Wall Street — Shopkeeper is king of credit market](https://kenyanwallstreet.com/shopkeeper-is-king-of-credit-market/)
- [SalesPlay POS — Credit sales and settlement](https://salesplay.com/credit-function/)
- [Oracle — Open-item versus balance-forward accounting](https://docs.oracle.com/en/industries/energy-water/rate-cloud/22c/rcs-user-guides/RCS_22c/C1_03Finan_Open_Item_Versus_Balance_Forward_.html)
- [Upflow — AR aging reports](https://upflow.io/blog/ar-metrics/aging-reports)
- [Stripe — What is an aging report](https://stripe.com/resources/more/what-is-an-aging-report-what-is-in-one-and-how-to-use-it)

**Inventory**
- [Descartes Finale — Weighted average inventory method](https://www.finaleinventory.com/guides/weighted-average-inventory-method/)
- [Descartes Finale — Inventory costing methods: FIFO, LIFO, weighted average](https://www.finaleinventory.com/guides/inventory-costing-methods/)
- [Fulfil — FIFO vs moving weighted average](https://www.fulfil.io/blog/inventory-valuation-methods-fifo-moving-weighted-average/)
- [Corporate Finance Institute — Weighted average cost method](https://corporatefinanceinstitute.com/resources/accounting/weighted-average-cost-method/)
