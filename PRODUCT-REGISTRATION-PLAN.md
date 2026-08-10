# Product registration & stock intake — research and implementation plan

Status: **plan only, nothing built.** Decisions needed at §6 before I start.

The trigger for this was the New Product screen: you register a product and it lands at
**0 in stock**. It is immediately wrong, it shows up in the low-stock list as if it had run
out, and the only way to fix it is to leave the screen and go to Restock. Every POS I looked
at captures the count on the registration form itself.

---

## 1. What other POS systems capture

Compared against the add-item form in **Loyverse** (the reference worth caring about — it is
free, offline-capable, and widely used by Kenyan dukas), **Square for Retail**, and the item
master fields that show up consistently across inventory guidance.

| Field | Loyverse | Square | Duka Lite today |
|---|---|---|---|
| Name | required | required | ✅ |
| Category | required | yes | ❌ |
| Sold by (unit vs weight) | required | yes | ✅ (`pc/kg/litre/packet`) |
| Selling price | optional | yes | ✅ |
| Cost / buying price | optional | yes | ✅ |
| SKU | optional, auto-generated | yes | ❌ |
| Barcode | optional | yes | ❌ *(out of scope)* |
| Track stock (on/off) | toggle | — | ❌ (always on) |
| **In-stock quantity** | **on the form** | **on the form** | **❌ — the gap** |
| Low stock threshold | optional | reorder point | ✅ |
| Available for sale | checkbox | yes | ✅ (`is_active`) |
| Tax | optional | yes | ❌ *(out of scope)* |

Two findings beyond the obvious one:

**Stock adjustments are a first-class workflow, not an afterthought.** Square ships six reason
codes — *stock received, inventory recount, damage, theft, loss, restock return*. Loyverse has a
whole Stock Adjustments screen. This app has `adjustment` and `damage` in the database enum and
enforced by a check constraint — **and no screen anywhere can create either one.** That is dead
capability. Today, if the count is wrong or a crate of milk spoils, an attendant cannot correct
it at all. The README claims mistakes are "corrected with a compensating adjustment movement";
right now that is not something the app can actually do.

**Perishables need dating.** Guidance for Kenyan retail is consistent that FIFO and expiry
tracking matter most in a warm climate, and this shop's own seed list is full of short-life
goods — milk, bread, eggs. Full batch tracking is a large feature and I am *not* proposing it
(see §6.3), but it is the one genuine omission worth naming.

---

## 2. What I propose to build

### Tier 1 — the actual ask

**A. Opening stock on the registration form.**
New optional field, *Opening stock*, with the unit shown inline (`packet`, `kg`…). Defaults to
empty; empty means zero and the product is created exactly as it is today, so nothing regresses.
Below it, a live read-out: `40 packet × KES 175 = KES 7,000 of stock`. That figure is the single
best typo-catcher on the form — a duka owner knows immediately whether their shelf is worth
seven thousand shillings or seventy thousand.

The count is **never written to `products.quantity` directly.** It creates a stock movement, the
same as everything else, so the ledger stays the only source of truth and the existing
`quantity = 0` insert policy stays exactly as it is.

**B. A new `opening` movement reason.**
Not a reuse of `restock`. Opening stock is *"what was already on the shelf when I started using
this app"* — it is not a purchase on a date, and folding it into restock would corrupt any
future answer to "what did I spend on stock this month". The seed file currently fakes this with
`reason = 'restock', note = 'Opening stock'`, which is the same admission in a weaker form.

**C. A Stock adjustment screen.** `/products/adjust`
Pick a product → see current count → choose a reason → enter the number.

| Reason | Direction | Prompt |
|---|---|---|
| Recount | either | "What did you actually count?" — enters an absolute figure, app derives the delta |
| Damage / spoilt | negative | "How many are damaged?" |
| Loss / theft | negative | "How many are missing?" |

Recount taking an *absolute* number rather than a delta matters: an attendant counting a shelf
knows "there are 14", not "there are 3 fewer than the system thinks". Making them do that
subtraction is how you get wrong data. `damage` already exists in the enum; recount maps to
`adjustment`; loss/theft needs one new enum value or can fold into `adjustment` with a note —
my recommendation is a distinct `loss` value, because "we miscounted" and "someone took it" are
different conversations for a shop owner and the brief exists to tell those apart.

**D. Restock screen improvements.**
- **Show the resulting total.** Currently shows "Currently 15 in stock" and the quantity
  received, but never `15 + 24 = 39`. One line, removes all doubt.
- **Enter total paid, or price per unit.** A duka owner is handed an invoice saying
  *"25 packets, KES 4,375"*, not *"KES 175 each"*. Let them type either and derive the other.
  This is the single most-used arithmetic in the shop and doing it in their head is where
  margin errors come from.
- **Backdate a delivery.** A date field defaulting to today. Stock received yesterday and
  entered this morning currently lands on the wrong day.
- **Optional note.** Free text — invoice number, who delivered. One column, no new tables.

### Tier 2 — worth it, cheap, say the word

- **Category** (`Flour`, `Sugar`, `Soap`, `Fresh`…). Loyverse makes this required. At 20
  products it is noise; at 150 it is the difference between a usable Sell grid and scrolling.
  Adds a filter row to Sell and Products. ~half a day.
- **Track stock toggle.** For things a duka sells with no meaningful count — airtime, a phone
  charge, a plastic bag. Currently they would sit permanently in the low-stock list, nagging.

---

## 3. Schema changes

```sql
-- 0003_stock_intake.sql
alter type public.movement_reason add value 'opening';
alter type public.movement_reason add value 'loss';

alter table public.stock_movements
  add column note_ref text,           -- invoice / delivery reference
  add column total_cost numeric(12,2); -- what was actually paid, when known

-- reason shape must learn the two new values
alter table public.stock_movements drop constraint movement_reason_shape;
alter table public.stock_movements add constraint movement_reason_shape check (
  (reason = 'sale'    and delta < 0 and sale_id is not null) or
  (reason = 'restock' and delta > 0 and sale_id is null)     or
  (reason = 'opening' and delta > 0 and sale_id is null)     or
  (reason = 'damage'  and delta < 0 and sale_id is null)     or
  (reason = 'loss'    and delta < 0 and sale_id is null)     or
  (reason = 'adjustment' and sale_id is null)   -- recount: either direction
);
```

Note `damage` gains `delta < 0`, which it should always have had — today the constraint would
happily accept damaging *positive* five packets into existence.

`ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older Postgres and the new
value is not usable in the same transaction that adds it. The migration therefore splits into
two files, `0003a` (enum) and `0003b` (constraint + columns), rather than one that fails on
first run. This is the kind of thing that only shows up when you actually run it, so it gets
run against PGlite before it goes anywhere near your database.

**Tier 2 additions, if approved:**

```sql
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops,
  name text not null,
  unique (shop_id, lower(name))
);
alter table public.products
  add column category_id uuid references public.categories,
  add column track_stock boolean not null default true;
```

---

## 4. The offline problem this creates

Registering a product with opening stock is **two rows** — a product and a movement — and they
must not be able to arrive separately.

Today `saveProduct` queues a `product` outbox entry and `recordMovement` queues a `movement`
entry. Two entries means the movement can be pushed while the product does not exist, which is
a foreign-key violation. Worse, my sync engine classifies FK violations as *permanent* and parks
them — so a transient ordering problem would become a stock movement that never syncs.

The fix is the same shape as `sync_sale`, which already solves exactly this problem for a sale
and its lines:

```sql
create function public.sync_new_product(p_product jsonb, p_opening jsonb)
returns uuid
-- one transaction: insert the product, then its opening movement,
-- both ON CONFLICT (id) DO NOTHING. Replaying is a no-op.
```

One outbox entry, one RPC, atomic, idempotent. **This is the part of the work most likely to
cause a real bug and it is where most of the test effort goes.**

---

## 5. Verification

Extending the existing suites, not inventing new ones:

- **Schema (`test:schema`)** — opening stock lands once and only once when `sync_new_product` is
  replayed five times; `damage` with a positive delta is rejected; recount in both directions
  produces the right final quantity; a product with opening stock is created at exactly the
  count entered.
- **Offline (`test:offline`)** — register a product with opening stock in aeroplane mode and
  assert **one** outbox entry, not two; derived stock is correct before any sync; a recount to
  an absolute figure produces the correct signed delta.
- **Responsive (`test:responsive`)** — the two new/changed screens at all three widths.
- Round-trip: register with opening 40 → sell 2 → restock 10 → recount to 45 → assert 45, and
  assert the ledger sums to 45 independently of the cached quantity.

---

## 6. Decisions I need from you

### 6.1 Three of these cross the brief's out-of-scope line

The brief says to stop and state the reasoning rather than build these, so I am stopping.

| Field | Why it is tempting | Why I am not building it unprompted |
|---|---|---|
| **Supplier / vendor** on restock | Square and Loyverse both capture it; "who did I buy this from" is a real question | The brief lists *suppliers or purchase orders* as explicitly forbidden. A supplier field is the thin end of that — it wants a supplier list, then supplier history, then orders. **Say the word and it is one text column, no table.** |
| **SKU / item code** | Standard on every item master | Only earns its keep with a scanner, and *barcode scanning* is out of scope. A code a human types is slower than the product name. **Recommend skipping.** |
| **Expiry date / batches** | The research is unambiguous that this matters most for exactly the goods this shop sells | Real batch tracking means one product has many quantities with many dates, which changes the stock model everywhere — Sell, Closing, the ledger. That is a feature, not a field. **Recommend a deliberate decision later, not a bolt-on now.** A cheap 80% version exists: one nullable `expiry_date` on the restock movement plus an "expiring soon" list beside Low stock. |

### 6.2 Pick a scope

- **A — Tier 1 only.** Opening stock, the adjustment screen, restock improvements. *This is what
  you asked for and I recommend it.*
- **B — Tier 1 + Tier 2.** Adds category and track-stock. Roughly half a day more.
- **C — Tier 1 + something from 6.1.** Tell me which and I will fold it in.

### 6.3 One thing I want to flag regardless of scope

The missing adjustment screen is arguably a bigger hole than the opening-stock field you spotted.
Opening stock is wrong *once*, at registration, and a restock papers over it. A shop with no way
to record damage or a recount drifts **permanently** — every spoilt loaf and every miscount is an
error the system can never absorb, and the stock figure decays until nobody trusts it. I would
build the adjustment screen even if you only wanted the opening-stock field.

---

## Sources

- [Loyverse — How to add items in the Back Office](https://help.loyverse.com/help/how-add-items-loyverse-back-office)
- [Loyverse — How to work with stock adjustments](https://help.loyverse.com/help/how-work-stock-adjustments)
- [Loyverse — Advanced inventory management](https://help.loyverse.com/help/advanced-inventory-management)
- [Square — View, receive and adjust inventory](https://squareup.com/help/au/en/article/6110-manage-inventory-with-the-retail-pos-app)
- [Square — Set and update unit costs](https://squareup.com/help/us/en/article/8262-set-unit-cost-with-square-for-retail-purchase-orders)
- [Shopify — Retail inventory management best practices](https://www.shopify.com/blog/retail-inventory-management)
- [NetSuite — What is item master data](https://www.netsuite.com/portal/resource/articles/inventory-management/item-master-data.shtml)
- [Tally — Inventory management techniques for small business in Kenya](https://tallysolutions.com/ssa/inventory/inventory-management-techniques-for-small-business-in-kenya/)
- [TechnoServe — Supporting duka owners in Kenya](https://www.technoserve.org/blog/a-day-in-the-life-supporting-duka-owners-in-kenya/)
- [DHL — Modern inventory solutions for Kenyan entrepreneurs](https://www.dhl.com/discover/en-ke/small-business-advice/business-innovation-trends/modern-inventory-solutions-for-kenyan-entrepreneurs)
