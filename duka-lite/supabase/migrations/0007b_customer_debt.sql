-- =====================================================================
-- Customer debt, part B — customers, the debt ledger, and credit sales.
-- =====================================================================
-- Why this exists, in one paragraph: 90%+ of Kenyan dukas sell on credit, and
-- FinAccess puts the default rate on shopkeeper goods-and-services credit at
-- roughly 45% — the worst of any credit type measured in the country, worse
-- than digital loan apps (18%), mobile banks (13%) and family (9%). Recorded
-- on paper, in a book that gets lost. So this is not a bookkeeping feature; it
-- is a loss-prevention feature, and it is built to make EXPOSURE visible, not
-- merely to record it accurately.
--
-- The ledger is append-only and the ALLOCATION of payments to debts is derived
-- FIFO at read time, never stored. That is the same shape `stock_movements`
-- already uses for stock: an event log plus a derived answer. It gives the
-- balance-forward simplicity a shopkeeper wants ("Wanjiku owes 3,200") with
-- the open-item accuracy ageing needs ("oldest 47 days"), and it is idempotent
-- and offline-convergent for free, since a pure function of an ordered event
-- list has no state that can desync.
--
-- Run AFTER 0007a. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Customers. Deliberately minimal: this is NOT a CRM. No loyalty, no
-- marketing, no purchase history. The original brief was right to exclude
-- customers as a feature — it is debt that needs them, and only barely.
-- ---------------------------------------------------------------------
create table if not exists public.customers (
  id           uuid primary key,
  shop_id      uuid not null references public.shops (id) on delete restrict,
  name         text not null check (length(btrim(name)) between 1 and 120),
  -- How you actually chase a debt: a phone call or a WhatsApp message.
  phone        text check (phone is null or length(btrim(phone)) between 3 and 20),
  credit_limit numeric(12,2) check (credit_limit is null or credit_limit >= 0),
  is_active    boolean not null default true,
  note         text,
  created_at   timestamptz not null,
  updated_at   timestamptz not null default now()
);
create index if not exists customers_shop_idx on public.customers (shop_id, is_active);
create unique index if not exists customers_shop_phone_unique
  on public.customers (shop_id, btrim(phone)) where phone is not null;
create index if not exists customers_shop_name_idx on public.customers (shop_id, lower(name));

alter table public.customers enable row level security;

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select to authenticated using (shop_id = public.current_shop_id());

-- Attendants may add a customer: refusing credit at the counter because the
-- owner is not there to create the record would push the sale back into the
-- paper book, which is the thing being replaced.
drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert to authenticated with check (shop_id = public.current_shop_id());

drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers
  for update to authenticated
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

-- ---------------------------------------------------------------------
-- The debt ledger. Append-only, like stock_movements.
--   charge   (+) goods taken on credit — always tied to a sale
--   payment  (-) money coming back     — has its own payment method
--   writeoff (-) the owner giving up   — an explicit, visible decision
-- ---------------------------------------------------------------------
do $$ begin
  create type public.debt_entry_kind as enum ('charge', 'payment', 'writeoff');
exception when duplicate_object then null;
end $$;

create table if not exists public.debt_entries (
  id             uuid primary key,
  shop_id        uuid not null references public.shops (id) on delete restrict,
  customer_id    uuid not null references public.customers (id) on delete restrict,
  user_id        uuid not null references public.users (id) on delete restrict,
  kind           public.debt_entry_kind not null,
  -- Always positive; `kind` carries the direction. A signed amount plus a kind
  -- is two sources of truth for one fact, and they can disagree.
  amount         numeric(12,2) not null check (amount > 0),
  sale_id        uuid references public.sales (id) on delete cascade,
  payment_method public.payment_method,
  mpesa_code     text,
  note           text,
  -- So Closing can find repayments without scanning timestamps.
  business_date  date not null,
  created_at     timestamptz not null,
  synced_at      timestamptz not null default now(),
  constraint debt_entry_shape check (
    (kind = 'charge'
       and sale_id is not null
       and payment_method is null
       and mpesa_code is null)
    or
    -- A repayment is money arriving, so it must say WHERE it arrived, or
    -- Closing cannot put it in the right column.
    --
    -- `payment_method is not null` is load-bearing, not redundant with the
    -- IN below. A CHECK constraint only REJECTS a row when it evaluates to
    -- FALSE — a NULL result passes. With payment_method NULL, `IN ('cash',
    -- 'mpesa')` yields NULL, so this branch was NULL, the other two were
    -- FALSE, and `FALSE OR NULL OR FALSE` is NULL. A repayment with no
    -- payment method sailed straight through the constraint meant to stop it,
    -- and would have landed in neither the cash nor the M-Pesa column at
    -- Closing. Making the guard explicit turns NULL into FALSE.
    (kind = 'payment'
       and sale_id is null
       and payment_method is not null
       and payment_method in ('cash', 'mpesa')
       and (payment_method = 'cash' or mpesa_code is not null))
    or
    (kind = 'writeoff'
       and sale_id is null
       and payment_method is null
       and mpesa_code is null)
  )
);
-- Applied explicitly as well as in the CREATE above, so a database that
-- already ran an earlier version of this file picks up the corrected
-- constraint rather than keeping the one with the NULL hole.
alter table public.debt_entries drop constraint if exists debt_entry_shape;
alter table public.debt_entries add constraint debt_entry_shape check (
  (kind = 'charge'
     and sale_id is not null
     and payment_method is null
     and mpesa_code is null)
  or
  (kind = 'payment'
     and sale_id is null
     and payment_method is not null
     and payment_method in ('cash', 'mpesa')
     and (payment_method = 'cash' or mpesa_code is not null))
  or
  (kind = 'writeoff'
     and sale_id is null
     and payment_method is null
     and mpesa_code is null)
);

create index if not exists debt_entries_customer_idx
  on public.debt_entries (shop_id, customer_id, created_at);
create index if not exists debt_entries_date_idx
  on public.debt_entries (shop_id, business_date);
create index if not exists debt_entries_sale_idx on public.debt_entries (sale_id);

alter table public.debt_entries enable row level security;

drop policy if exists debt_entries_select on public.debt_entries;
create policy debt_entries_select on public.debt_entries
  for select to authenticated using (shop_id = public.current_shop_id());

drop policy if exists debt_entries_insert on public.debt_entries;
create policy debt_entries_insert on public.debt_entries
  for insert to authenticated
  with check (
    shop_id = public.current_shop_id()
    and user_id = auth.uid()
    -- Writing off a debt is forgiving money. Owner only.
    and (kind <> 'writeoff' or public.is_owner())
  );
-- No UPDATE and no DELETE policy, exactly like sales and stock_movements: the
-- ledger is append-only. A mistaken entry is corrected by another entry, so
-- the correction is itself visible.

-- ---------------------------------------------------------------------
-- Credit sales
-- ---------------------------------------------------------------------
alter table public.sales
  add column if not exists customer_id uuid references public.customers (id) on delete restrict;
create index if not exists sales_customer_idx on public.sales (shop_id, customer_id);

-- The most load-bearing constraint in this schema gains a third branch.
-- Cash and M-Pesa are unchanged; credit adds "no money moved, and we know who
-- owes it". A credit sale with no customer is the paper book's worst failure —
-- a debt owed by nobody — so the constraint forbids it outright.
alter table public.sales drop constraint if exists sales_payment_shape;
alter table public.sales add constraint sales_payment_shape check (
  (payment_method = 'cash'
     and amount_tendered is not null
     and amount_tendered >= total
     and mpesa_code is null)
  or
  (payment_method = 'mpesa'
     and mpesa_code is not null
     and length(btrim(mpesa_code)) between 1 and 32
     and amount_tendered is null)
  or
  (payment_method = 'credit'
     and customer_id is not null
     and amount_tendered is null
     and mpesa_code is null)
);

-- =====================================================================
-- sync_sale — now able to record a credit sale and its charge atomically.
-- =====================================================================
-- A credit sale is TWO rows: the sale and its debt charge. They must reach the
-- server in one transaction, for exactly the reason opening stock and portions
-- must: a charge pushed before its sale exists is a foreign-key violation,
-- which the sync engine treats as permanent and parks — money owed to the
-- shop, stuck on one phone forever.
-- =====================================================================
create or replace function public.sync_sale(
  p_sale      jsonb,
  p_items     jsonb,
  p_movements jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_sale_id  uuid := (p_sale ->> 'id')::uuid;
  v_shop_id  uuid := public.current_shop_id();
  v_customer uuid := nullif(p_sale ->> 'customer_id', '')::uuid;
  v_method   public.payment_method := (p_sale ->> 'payment_method')::public.payment_method;
begin
  if v_shop_id is null then
    raise exception 'no shop for current user';
  end if;

  insert into public.sales (
    id, shop_id, user_id, total, payment_method,
    amount_tendered, mpesa_code, business_date, created_at, customer_id
  )
  values (
    v_sale_id, v_shop_id, auth.uid(),
    (p_sale ->> 'total')::numeric,
    v_method,
    nullif(p_sale ->> 'amount_tendered', '')::numeric,
    nullif(btrim(coalesce(p_sale ->> 'mpesa_code', '')), ''),
    (p_sale ->> 'business_date')::date,
    (p_sale ->> 'created_at')::timestamptz,
    v_customer
  )
  on conflict (id) do nothing;

  if not found then
    return v_sale_id;
  end if;

  insert into public.sale_items (
    id, sale_id, shop_id, product_id, product_name, unit_price, quantity, line_total,
    portion_name, portion_factor, base_quantity, unit_cost
  )
  select
    (i ->> 'id')::uuid, v_sale_id, v_shop_id,
    (i ->> 'product_id')::uuid,
    i ->> 'product_name',
    (i ->> 'unit_price')::numeric,
    (i ->> 'quantity')::numeric,
    (i ->> 'line_total')::numeric,
    nullif(btrim(coalesce(i ->> 'portion_name', '')), ''),
    nullif(i ->> 'portion_factor', '')::numeric,
    nullif(i ->> 'base_quantity', '')::numeric,
    nullif(i ->> 'unit_cost', '')::numeric
  from jsonb_array_elements(p_items) as i
  on conflict (id) do nothing;

  insert into public.stock_movements (
    id, shop_id, product_id, user_id, delta, reason, sale_id, created_at
  )
  select
    (m ->> 'id')::uuid, v_shop_id,
    (m ->> 'product_id')::uuid, auth.uid(),
    (m ->> 'delta')::numeric,
    'sale'::public.movement_reason,
    v_sale_id,
    (m ->> 'created_at')::timestamptz
  from jsonb_array_elements(p_movements) as m
  on conflict (id) do nothing;

  -- The charge rides in the same transaction as the sale it belongs to.
  if v_method = 'credit' then
    insert into public.debt_entries (
      id, shop_id, customer_id, user_id, kind, amount,
      sale_id, business_date, created_at
    )
    values (
      coalesce(nullif(p_sale ->> 'debt_entry_id', '')::uuid, gen_random_uuid()),
      v_shop_id, v_customer, auth.uid(), 'charge',
      (p_sale ->> 'total')::numeric,
      v_sale_id,
      (p_sale ->> 'business_date')::date,
      (p_sale ->> 'created_at')::timestamptz
    )
    on conflict (id) do nothing;
  end if;

  return v_sale_id;
end;
$$;
grant execute on function public.sync_sale(jsonb, jsonb, jsonb) to authenticated;

-- =====================================================================
-- sync_debt_entry — repayments and write-offs.
-- =====================================================================
-- Charges never come through here; they belong to a sale and ride with it.
-- Idempotent on the client-generated id, like everything else.
-- =====================================================================
create or replace function public.sync_debt_entry(p_entry jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id    uuid := (p_entry ->> 'id')::uuid;
  v_shop  uuid := public.current_shop_id();
  v_kind  public.debt_entry_kind := (p_entry ->> 'kind')::public.debt_entry_kind;
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;
  if v_kind = 'charge' then
    raise exception 'a charge belongs to its sale and must go through sync_sale';
  end if;

  insert into public.debt_entries (
    id, shop_id, customer_id, user_id, kind, amount,
    payment_method, mpesa_code, note, business_date, created_at
  )
  values (
    v_id,
    v_shop,
    (p_entry ->> 'customer_id')::uuid,
    auth.uid(),
    v_kind,
    (p_entry ->> 'amount')::numeric,
    nullif(p_entry ->> 'payment_method', '')::public.payment_method,
    nullif(btrim(coalesce(p_entry ->> 'mpesa_code', '')), ''),
    nullif(btrim(coalesce(p_entry ->> 'note', '')), ''),
    (p_entry ->> 'business_date')::date,
    (p_entry ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  return v_id;
end;
$$;
grant execute on function public.sync_debt_entry(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant select on public.customers to authenticated;
grant insert (id, shop_id, name, phone, credit_limit, is_active, note, created_at)
  on public.customers to authenticated;
grant update (name, phone, credit_limit, is_active, note) on public.customers to authenticated;

grant select on public.debt_entries to authenticated;
grant insert (id, shop_id, customer_id, user_id, kind, amount, sale_id,
              payment_method, mpesa_code, note, business_date, created_at)
  on public.debt_entries to authenticated;

grant insert (id, shop_id, user_id, total, payment_method, amount_tendered,
              mpesa_code, business_date, created_at, customer_id)
  on public.sales to authenticated;
