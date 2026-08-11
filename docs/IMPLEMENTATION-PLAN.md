# Duka Lite — Implementation Plan

Derived from `duka-lite-build-prompt.pdf`. Stack is fixed (Next.js App Router + TS, Tailwind,
Supabase/Postgres/Auth + RLS, PWA, Dexie/IndexedDB, Vercel). Scope is fixed. This plan only
decides *how*, never *what*.

> **Status: built.** The app is in the repository root. See its
> [README](../README.md) for setup and verification. Three decisions changed during the
> build; they are recorded at the bottom under *Deviations from this plan*.

---

## 1. The three hard problems

Everything else is CRUD. These are the parts that will actually decide whether the app works.

### 1.1 Idempotent sync
The definition of done is "watch everything sync exactly once". Guarantees:

- Every locally-created row gets a **client-generated UUIDv4 as its real primary key** — sales,
  sale_items, stock_movements. No server-generated ids for anything created offline.
- Sync pushes a whole sale as **one atomic unit** via a Postgres RPC, not three separate
  upserts. A partial push (sale lands, movements don't) would corrupt stock permanently.
  ```
  rpc sync_sale(p_sale jsonb, p_items jsonb, p_movements jsonb) returns sales.id
    -- SECURITY INVOKER so RLS still applies
    -- INSERT ... ON CONFLICT (id) DO NOTHING on all three tables
    -- sets synced_at = now()
    -- returns the id whether inserted or already present
  ```
  Re-running it with the same payload is a no-op. That is the whole idempotency story: PK
  conflict + `DO NOTHING` + one transaction.
- The client only deletes the outbox entry after the RPC returns success. Crash between RPC
  commit and outbox delete → replay → no-op. Safe.

### 1.2 Stock quantity that is correct offline
The brief says quantity is derived from movements and never edited directly. Split
responsibility:

- **Server**: `products.quantity` is a materialised cache maintained by an `AFTER INSERT`
  trigger on `stock_movements` (`quantity = quantity + NEW.delta`). No client ever writes it.
  A `recompute_product_quantity(product_id)` function exists for repair.
- **Client**: displayed qty = `product.quantity` (last value pulled from server) **+ sum of
  deltas of movements still sitting in the outbox**. Never mutate the cached server value
  locally.
- Ordering rule in the sync loop: push outbox → on success, **pull affected product rows in
  the same cycle** → only then clear those outbox entries. This avoids the window where a
  movement is neither in the outbox nor in the pulled server quantity.

### 1.3 Offline auth
Supabase Auth cannot issue a session with no network. Therefore:

- First login **must** be online. After that the session is persisted (localStorage) and the
  app boots from the cached session with no network call.
- The route guard checks *cached session + a `session_shop` record in Dexie* (shop_id, user_id,
  role) — it never awaits `getUser()` on boot.
- Token refresh is attempted only when online; an expired refresh token while offline does
  **not** log the attendant out mid-shift. It shows "Offline · sign in when back online" and
  keeps the till usable; sync simply fails until a real session returns.
- Consequence to accept: a phone that has never logged in online cannot be used. Documented in
  the setup steps.

---

## 2. Data model

Seven tables as specified: `shops`, `users`, `products`, `stock_movements`, `sales`,
`sale_items`, `cash_counts`.

```
shops(id uuid pk, name text not null, created_at timestamptz default now())

users(id uuid pk references auth.users on delete cascade,
      shop_id uuid not null references shops,
      role text not null check (role in ('owner','attendant')),
      full_name text, created_at)

products(id uuid pk, shop_id uuid not null references shops,
         name text not null,
         unit text not null check (unit in ('pc','kg','litre','packet')),
         buying_price  numeric(12,2) not null check (>= 0),
         selling_price numeric(12,2) not null check (>= 0),
         quantity      numeric(12,3) not null default 0,   -- trigger-maintained
         low_stock_threshold numeric(12,3) not null default 0,
         is_active boolean not null default true,          -- soft delete only
         created_at, updated_at)
  index (shop_id, is_active), index (shop_id, name)

stock_movements(id uuid pk,                                 -- client uuid
                shop_id, product_id, user_id,
                delta numeric(12,3) not null,                -- signed
                reason text not null check (reason in ('sale','restock','adjustment','damage')),
                buying_price numeric(12,2),                  -- restock only
                sale_id uuid null references sales,
                created_at, synced_at)
  index (shop_id, product_id, created_at)

sales(id uuid pk,                                            -- client uuid
      shop_id, user_id,
      total numeric(12,2) not null check (> 0),
      payment_method payment_method not null,                -- enum cash|mpesa
      amount_tendered numeric(12,2) null,
      mpesa_code text null,
      created_at timestamptz not null,                       -- client clock
      synced_at timestamptz null,
      constraint payment_shape check (
        (payment_method = 'cash'  and amount_tendered is not null and mpesa_code is null) or
        (payment_method = 'mpesa' and mpesa_code is not null and amount_tendered is null)))
  index (shop_id, created_at)

sale_items(id uuid pk, sale_id uuid references sales on delete cascade,
           shop_id, product_id,
           product_name text not null,      -- denormalised: receipt truth at sale time
           unit_price numeric(12,2) not null,
           quantity numeric(12,3) not null check (> 0),
           line_total numeric(12,2) not null)
  index (sale_id)

cash_counts(id uuid pk, shop_id, user_id, business_date date not null,
            counted_amount numeric(12,2) not null,
            created_at, synced_at,
            unique (shop_id, business_date))            -- upsert, last write wins
```

Notes:
- Money as `numeric(12,2)`; formatting to `KES 1,250` (no decimals) is presentation-only.
- `created_at` for offline rows is the **client clock** — a wrong phone clock puts a sale on
  the wrong day. Mitigation: on first sync, store `server_now - device_now` skew and warn the
  owner on the Closing screen if skew > 5 minutes. Not a blocker, just visible.
- `business_date` is derived client-side in `Africa/Nairobi` (UTC+3, no DST) — never from the
  DB server's timezone.

### RLS
Every table: `enable row level security`, plus `force row level security`.

The recursion trap: policies on `users` that query `users` deadlock. Solution — one
`SECURITY DEFINER STABLE` helper:

```sql
create function public.current_shop_id() returns uuid
language sql security definer stable set search_path = public as $$
  select shop_id from public.users where id = auth.uid()
$$;
```

Then per table: `using (shop_id = public.current_shop_id())` for select, and the same as
`with check` for insert/update. `users` itself gets a plain `id = auth.uid()` self-read policy
plus an owner-read policy scoped by `current_shop_id()`.

Owner-only additions (checked via a parallel `current_role()` helper): create/edit products,
create attendants, view other users' cash counts. Attendants can insert sales/movements/cash
counts and read products. **No delete policy on any table** — soft delete only.

---

## 3. Local store (Dexie)

```
db.products        id, shop_id, name, is_active, [shop_id+is_active]
db.sales           id, created_at, business_date, payment_method
db.sale_items      id, sale_id
db.stock_movements id, product_id, created_at
db.cash_counts     id, business_date
db.outbox          ++seq, kind, entity_id, attempts, next_attempt_at
db.meta            key                       -- session_shop, last_pull_at, clock_skew
```

Outbox entry: `{ kind: 'sale' | 'restock' | 'adjustment' | 'cash_count' | 'product_upsert',
payload, attempts, next_attempt_at, last_error }`.

**Sync engine** (`lib/sync/engine.ts`), a single module with no React in it:
- Triggers: `online` event, app foreground (`visibilitychange`), a 30s timer while online, and
  immediately after any local write.
- Push loop: take due outbox entries in `seq` order, call the matching RPC, delete on success.
  On failure increment `attempts`, `next_attempt_at = now + min(2^attempts, 300)s`. After 8
  attempts flag it as stuck and surface it (a stuck sale must never be silently dropped).
- Pull: `products` + today's `sales`/`sale_items`/`cash_counts` where `updated_at > last_pull_at`,
  written into Dexie inside one transaction.
- Pending count exposed via Dexie `liveQuery` → the `Online / Offline · N pending` pill.
- Every entry point is fire-and-forget. **No UI code ever awaits the engine.**

---

## 4. PWA

- **Serwist** (maintained successor to `next-pwa`, works with App Router / Turbopack).
- Precache the app shell + all four routes; `NetworkOnly` for `*.supabase.co` (never cache API
  responses — Dexie is the cache).
- Manifest: `display: standalone`, portrait, 192/512 icons, theme colour.
- `app/offline/tsx` fallback is only for a cold visit to an unprecached URL; normal operation
  never sees it.

---

## 5. Screens & UI contract

Shared primitives built once, in `components/ui/`:
- `<Money value>` → `KES 1,250`, `Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 })`.
- Semantic colour tokens fixed in `tailwind.config`: `cash` (green family), `mpesa` (a distinct
  blue/teal family). Used *only* for those two meanings, everywhere, no exceptions.
- `<TapTarget>` enforcing `min-h-12 min-w-12` (48px); base font 16px; no CSS below 16px on
  interactive text.
- Nav labels: **Sell** · **Products** · **Closing**. *(Originally bilingual, per the brief's UI
  rules. Changed to English-only on request — see Deviations.)*

| Screen | Route | Key points |
|---|---|---|
| Login | `/login` | Email + password. Online-only, states that plainly. Redirects to `/sell`. |
| Products / Bidhaa | `/products` | List with qty + low-stock badge, add/edit form, deactivate (soft). Owner-only writes. |
| Restock | `/products/restock` | Product picker → qty received + buying price → one `restock` movement. |
| Low stock | `/products/low-stock` | `quantity <= low_stock_threshold`, active only. |
| Sell / Uza | `/sell` | Tile grid + search-as-you-type over Dexie. Tap adds/increments. Cart with qty edit + remove. Running total pinned, large. Checkout = two big buttons, Cash vs M-Pesa, **inline pages not modals**. Cash → tendered → change due in huge type. M-Pesa → free-text code, stored unvalidated. |
| Closing / Kufunga | `/closing` | Date picker defaulting to today. Cash / M-Pesa / Total / txn count. Cash count box → Expected vs Counted vs Difference (green at zero, red otherwise). List of the day's M-Pesa codes. Print stylesheet + Web Share API plain-text summary. |

Checkout write path (the ≤1s, zero-network requirement):

```
one Dexie transaction:
  put sale, put sale_items[], put stock_movements[], push outbox entry
→ clear cart, navigate to a success line, engine.kick() (unawaited)
```

No `await fetch` anywhere on that path.

---

## 6. Phases

Sequenced exactly as the brief mandates.

**Phase 0 — Scaffold (½ day).** Next.js + TS + Tailwind, Supabase local dev
(`supabase init/start`), folder structure, colour tokens, `<Money>`, lint/format. No features.

**Phase 1 — SQL migration + RLS → STOP.** Single `supabase/migrations/0001_init.sql`:
enums, seven tables, constraints, indexes, quantity trigger, `current_shop_id()` /
`current_role()`, all RLS policies, and the `sync_sale` RPC. Delivered for review; **no
application code written until it's approved**, per the brief's step 1.

**Phase 2 — Offline data layer.** Dexie schema, outbox, sync engine, auth gate + cached
session, connectivity pill, Serwist PWA. Proven by a scripted test: write 10 sales offline,
go online, assert exactly 10 rows server-side after a forced double-flush.

**Phase 3 — Login.** Email/password, session persistence, role load into Dexie, route guard,
sign-out that clears Dexie.

**Phase 4 — Products.** List, add/edit, deactivate, restock, low-stock. Full offline read.
Verifies the movements→quantity path before any money depends on it.

**Phase 5 — Sell.** The tile grid, cart, both checkout paths. Measure checkout latency in
airplane mode; budget is 1000ms tap-to-cart-cleared and it should land near 100ms.

**Phase 6 — Closing.** Aggregations computed from Dexie (must work offline — not a server
view), cash count upsert, M-Pesa code list, print CSS, Web Share text.

**Phase 7 — Seed + DoD.** 20 real duka products (Unga Jogoo 2kg, Omo 500g, Blue Band 250g,
Kasuku 500ml, Sukari 1kg, Royco 10g, Blue Band, Kimbo 500g, Mumias Sugar 2kg, Sunlight bar,
Colgate 75ml, Dettol 100ml, Bread 400g, Milk 500ml, Eggs tray, Rice 1kg, Beans 1kg,
Cooking oil 1L, Salt 1kg, Matchbox) via a SQL seed + a local Dexie seed for demo. Then the
airplane-mode checklist end to end on a real phone.

After each screen: a short "built / deliberately left out" note, as the brief requires.

---

## 7. Out of scope — enforced, not just avoided

Credit sales · customers/loyalty · suppliers/POs · barcode · multi-branch · discounts ·
returns/refunds · VAT/eTIMS · Daraja/STK Push · receipt printers · charts/dashboards ·
dark mode · multi-currency · CSV · SMS.

Two of these will *feel* necessary during the build. Flagging now rather than building:
- **Returns/refunds** — an attendant will mis-key a sale. v1 answer: the sale stands and the
  owner reconciles by eye; a `damage`/`adjustment` movement fixes stock only. Not building a
  void flow without your say-so.
- **Daraja** — the manually-typed M-Pesa code is exactly the control the owner wants, and it
  works offline. No API.

## 8. Open questions — resolved as built

These were flagged before the build and decided by the defaults proposed here. Each is a
one-line change if you want it the other way.

1. **How do attendants get accounts?** Owner self-signs-up, which creates the shop. Owner then
   invites an attendant by email from Settings; that email is claimed at signup and the person
   joins the shop automatically. **No service-role key is used**, so there is no server-side
   secret anywhere in the deployment — it is a `pending_invites` table plus an owner-only
   `SECURITY DEFINER` RPC. One screen outside the four listed.
2. **Can an attendant see Closing?** Yes — attendants can view the day and enter the cash
   count; only owners can create or edit products. To make Closing owner-only, tighten the
   `sales_select` policy to `public.is_owner()`.
3. **One device or several?** Several. Client UUIDs already handle it; `cash_counts` is unique
   per `(shop_id, business_date)` and last write wins, which is verified by a test.

## 9. Deviations from this plan

Three things changed once the code met reality.

1. **Serwist → a hand-written service worker.** `@serwist/next` 9.x targets Next 14/15 and this
   is Next 16. Rather than take a build-plugin version risk on the component that decides
   whether a shop can sell, `public/sw.js` is ~90 lines of auditable cache rules: cache-first
   for immutable hashed assets, network-first with a 3s timeout for navigations, and Supabase
   never cached at all.
2. **`/products/[id]` → `/products/edit?id=…`.** A dynamic segment is server-rendered on
   demand, so the service worker cannot precache it — editing a product would have failed with
   no internet. A static route with a query string is cached once and works for every product
   offline. **Every route in the build is now static**, which is what makes a cold start in
   aeroplane mode work.
3. **UI copy is English-only.** The brief's UI rules asked for "every label in English with the
   common Kiswahili term where it helps" — `Uza (Sell)`, `Bidhaa (Products)`, `Kufunga
   (Closing)`. Removed on request. This is a deliberate departure from the brief, not an
   oversight; the seed product names (`Unga Jogoo 2kg`, `Sukari Mumias 1kg`) are unchanged,
   since those are what the stock is actually called on the shelf.
4. **The sync commit is one transaction, not two.** The plan said "re-pull products, then clear
   the outbox". Done as two separate IndexedDB writes, that leaves a window where a movement is
   counted twice (server has it, outbox still has it). The server fetch happens first, then the
   new quantities and the outbox removal commit together, so the UI only ever observes a
   consistent pair.

## 10. What was verified, and how

`npm run verify` runs lint, typecheck, both suites, and a production build.

- **23 schema checks** (`test/schema.test.mjs`) run the real migration against a real Postgres
  (PGlite/WASM) and assert the payment-shape constraints, RLS isolation across two shops, that
  no client can write `products.quantity`, that a sale cannot be deleted — and that replaying
  `sync_sale` five times leaves exactly one sale, one line, one movement, and stock decremented
  exactly once.
- **30 offline checks** (`test/offline.test.ts`) run the real Dexie layer against an in-memory
  IndexedDB with no network and no Supabase — the aeroplane-mode state — covering checkout,
  derived stock, the cash/M-Pesa split, the cash-count difference, and the outbox contents.
  Checkout measures ~3ms against the 1000ms budget.

Not yet verified, and needing a real device: the install-to-homescreen flow, the service worker
cold start with the radio off, and the Web Share sheet into WhatsApp. These need a phone and a
live Supabase project; the manual checklist for them is in the README.
