# Pack sizes and units — research and implementation plan

Status: **plan only, nothing built.** Decisions needed at §7.

Two questions, and they have very different answers. One of them has a trap in it that would
cause silent stock drift — the exact failure this app exists to prevent.

---

## 1. Three findings first

### 1.1 You cannot currently sell half of anything. This is a live bug.

The database stores quantities as `numeric(12,3)`, so 0.5 litre has always been representable.
The Sell screen has no way to enter it. The cart has `−` and `+` buttons that step by exactly 1
and no numeric input:

```
src/app/(app)/sell/page.tsx:215   setQuantity(l.product_id, l.quantity - 1)
src/app/(app)/sell/page.tsx:225   setQuantity(l.product_id, l.quantity + 1)
```

So **any product whose unit is `kg` or `litre` is already broken** — 2.5 kg of beans or half a
litre of oil cannot be rung up at all. That is not a new feature request your question raises,
it is an existing defect your question exposes. It gets fixed regardless of what you decide
below.

### 1.2 `unit` is a Postgres enum, so it is a hard wall

```sql
create type public.product_unit as enum ('pc', 'kg', 'litre', 'packet');
```

Four values, fixed at migration time. There is no way for you to add "bar", "tray", "gunia" or
"crate" from inside the app — it needs a schema change and a redeploy every time. That is the
whole of problem 2, and it is straightforward to fix properly.

### 1.3 The pack-size question has two different answers

This is the part worth slowing down on. "Cooking oil in 5 L, 10 L and ½ L" can mean two
completely different things, and they need opposite data models:

| | **A — Sealed sizes** | **B — Measured from bulk** |
|---|---|---|
| What it is | Factory-sealed 1 L, 5 L, 10 L bottles | One 20 L drum, poured into the customer's container |
| Where stock lives | Three independent counts | **One pool**, measured in litres |
| Selling a 5 L | Reduces 5 L stock by 1. Touches nothing else | Reduces the pool by 5 |
| Can you make one from another? | No. You cannot decant a sealed bottle | Yes — that is the point |
| Restocking | Buy 12 × 1 L, separately buy 6 × 5 L | Buy 20 L, once |
| Industry model | Loyverse variants — separate SKU, separate stock, grouped for display | Odoo units of measure — a reference unit plus conversion ratios |

**Building the wrong one drifts stock silently.** Model sealed bottles as one pool and selling a
5 L quietly eats five 1 L bottles that are still sitting on the shelf. Model a bulk drum as
three separate products and the drum's litres live in three counts that can never reconcile.

Most Kenyan dukas that sell cooking oil have **both** at once: branded sealed bottles on the
shelf *and* loose oil measured out of a drum. So the plan below builds both, as two clearly
separate mechanisms you choose between per product. **I need you to confirm which of these you
actually do** — see §7.1. I could not source Kenyan loose-selling practice reliably, and you
know your shop far better than a search does.

---

## 2. Problem 2 — units you can define yourself

Straightforward, and it should land first because everything else reads more clearly with it.

**Drop the enum, store text, and keep a per-shop unit list to drive the picker.**

```sql
create table public.units (
  id            uuid primary key,
  shop_id       uuid not null references public.shops,
  code          text not null,          -- "kg", "gunia", "tray"
  label         text not null,          -- "Kilogram", "Sack", "Tray of 30"
  is_fractional boolean not null default false,
  sort_order    int not null default 100,
  unique (shop_id, lower(code))
);

alter table public.products alter column unit type text using unit::text;
```

**No foreign key from `products.unit` to `units`, deliberately.** An FK would recreate exactly
the two-row ordering bug I fixed for opening stock: a product created offline referencing a unit
created in the same session could be pushed before the unit row exists — a foreign-key
violation, which the sync engine treats as permanent and parks. Storing the code as text means a
unit can never be "missing" and a product can never fail to sync because of one. The `units`
table exists only to populate the picker and to answer "does this unit allow fractions".

`is_fractional` is what drives §4: `pc` steps by whole numbers, `kg` and `litre` open a numeric
pad.

**Seeded defaults** (editable, deletable, and you can add any others):

`pc` · `packet` · `kg` · `g` · `litre` · `ml` · `bar` · `tin` · `tray` · `crate` · `dozen` ·
`bale` · `sack` · `roll` · `bunch` · `sachet` · `bottle` · `metre`

Adding a unit works like adding a category does now — type it on the product form, it is created
inline, it appears for every product afterwards.

---

## 3. Problem 1A — sealed pack sizes

Rina 1 L, Rina 5 L and Rina 10 L are **already three products today**, and that is not the wrong
model — it is the same thing Loyverse does. What is missing is that nothing ties them together,
so they scatter across the grid and read as unrelated.

The fix is presentational, not structural:

```sql
alter table public.products add column group_name text;   -- "Rina cooking oil"
```

One nullable text column. No new table, no FK, no sync ordering risk — same reasoning as units.

- **Sell** — grouped products sort together and each tile shows its size prominently.
- **Products / Low stock / Restock** — grouped rows cluster under one heading, so "Rina" tells
  you 1 L is down to 2 while 10 L has 8.
- **Stock stays completely independent.** Selling a 5 L touches nothing else. That is the
  guarantee that makes this shape safe.

I am **not** proposing a group tile that expands to show sizes, at least not first. It saves grid
space but costs a tap on the busiest screen in the app, and 12 oil tiles is a smaller problem
than a slower till. Worth revisiting if the grid actually gets cluttered in use.

---

## 4. Problem 1B — measured selling from one pool

This is the mechanism that does not exist today in any form.

A product opts in by setting a **base unit** and one or more **portions**:

```
Rina bulk oil    base unit: litre    stock: 20
  portions:  ½ litre    factor 0.5   KES 120
             1 litre    factor 1     KES 220
             5 litres   factor 5     KES 1,050
```

Selling 3 × "½ litre" writes **one stock movement of −1.5 litre**, and the sale line reads
`½ litre × 3`, not `1.5 litre` — the receipt has to say what the customer actually bought.

```sql
create table public.product_portions (
  id         uuid primary key,
  shop_id    uuid not null references public.shops,
  product_id uuid not null references public.products on delete cascade,
  name       text not null,             -- "½ litre"
  factor     numeric(12,4) not null check (factor > 0),
  price      numeric(12,2) not null check (price >= 0),
  sort_order int not null default 100
);

alter table public.sale_items
  add column portion_name   text,
  add column portion_factor numeric(12,4),
  add column base_quantity  numeric(12,3);   -- what actually left the pool
```

`sale_items.quantity` keeps meaning "how many portions", `base_quantity` is what the ledger
moved. The stock movement always uses base units. Prices live on the portion, not the product,
because ½ litre × 2 is almost never the price of 1 litre in a real shop.

**Rounding.** Base quantities are `numeric(12,3)`. Factors like 0.5, 0.25 and 5 are exact.
A factor of ⅓ would round at the third decimal and accumulate drift of roughly a millilitre per
sale — negligible, and the recount screen is the escape hatch. I would keep factors to exact
decimals and not offer fractions like ⅓ in the UI.

**Restocking a measured product** happens in base units: you receive 20 litres, not "40 halves".
The restock screen already works in the product's unit, so this needs no change beyond wording.

---

## 5. What changes on the Sell screen

This is where both problems surface, and it needs the most care because it is the one screen
whose speed is the product.

1. **Tap the quantity to type it.** The `−` / `+` buttons stay exactly as they are — for `pc`
   goods they are still the fastest thing. The number between them becomes a tap target that
   opens a numeric entry. This alone fixes finding 1.1.
2. **Fractional units step sensibly.** For a `kg` or `litre` product, `+` steps by 0.5 rather
   than 1, and the keypad accepts decimals. For `pc`, whole numbers only.
3. **Portioned products show their portions instead of a single price.** Tapping the tile
   reveals `½ L · 1 L · 5 L` as three buttons; tapping one adds that portion. One extra tap, and
   only for products that need it.
4. **Stock shown in base units.** A portioned oil tile reads `12.5 litre left`, never
   "25 halves" — the shop thinks in what is in the drum.

---

## 6. Offline, sync and tests

Nothing here needs a new RPC. Both mechanisms ride the existing paths:

- `units` and `product_portions` sync like `categories` — plain upserts, owner-only, and a pull
  failure must never block sign-in (the bug the categories work already taught us).
- Portions are pushed with the product, so a new product with portions extends the existing
  `sync_new_product` bundle rather than adding a second outbox entry. Same one-transaction rule.
- The `unit` enum → text migration is one-way and touches `sync_new_product`'s cast. Low risk,
  but it is a real migration and gets run against PGlite before it goes near your database.

**Tests to add:**

- *Schema* — a portioned sale writes one movement in base units; `factor` must be positive;
  changing a product's unit does not orphan its stock; the enum→text migration preserves every
  existing value.
- *Offline* — selling 3 × ½ L moves stock by exactly 1.5; the sale line records the portion name
  and the base quantity; a `pc` product still refuses fractional quantities; a custom unit
  created offline round-trips.
- *The one that matters most* — a sealed-size group must prove **isolation**: selling the 5 L
  changes the 5 L count and provably leaves 1 L and 10 L untouched. That single assertion is the
  guard against the trap in §1.3.

---

## 7. Decisions I need

### 7.1 Which shape is your cooking oil? *(blocking — it decides the model)*

- **A — sealed only.** You buy and sell sealed 1 L / 5 L / 10 L bottles. Nothing is ever poured.
  → I build §2, §3 and the Sell fixes. Skip §4 portions entirely.
- **B — measured only.** You buy drums and pour to order. → §2, §4 and the Sell fixes.
- **C — both.** Sealed bottles on the shelf *and* a drum you measure from. → everything. This is
  what I would guess for a duka, and the two mechanisms do not interfere.

### 7.2 Which units do you actually need?

Tell me the ones you use and I will seed exactly those. The list in §2 is my guess, not research
— I would rather have your fifteen real ones than my eighteen plausible ones.

### 7.3 Do sizes need their own prices per portion, or a price per base unit?

Real shops usually charge more per litre for a smaller measure (½ L at 120 when 1 L is 220).
The plan assumes **a price per portion**, which supports that. Say so if your oil is priced
strictly per litre and I will simplify.

---

## 8. Suggested order

1. **The Sell quantity fix** — half a day, no schema change, fixes a live defect on its own.
2. **Custom units** — §2. Unblocks problem 2 completely.
3. **Group names** — §3. Small, presentational, zero risk to stock.
4. **Portions** — §4. The largest piece, and the only one that touches how stock is computed.

Steps 1–3 are independently useful and land quickly. Step 4 only happens if your answer to
§7.1 is B or C.

---

## Sources

- [Loyverse — How to use variants of items](https://help.loyverse.com/help/how-use-variants-items)
- [Loyverse — Managing stock with variants](https://loyverse.town/topic/1893-how-can-i-keep-track-of-stock-with-variants-of-an-item/)
- [Odoo 18 — Units of measure](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/configure/uom.html)
- [Microsoft Dynamics 365 — Manage units of measure](https://learn.microsoft.com/en-us/dynamics365/supply-chain/pim/tasks/manage-unit-measure)
- [Magestore — Tracking UoM inventory](https://www.magestore.com/blog/uom-inventory/)
- [MobiPOS — Unit of measurement, base and alternate UoM](https://www.mobi-pos.com/web/guide/settings/unit-of-measurement)
