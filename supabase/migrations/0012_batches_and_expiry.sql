-- =====================================================================
-- Batches and expiry dates — what a chemist needs that a duka does not.
-- =====================================================================
-- Safe to re-run. No new enum values, so no a/b split.
--
-- Two properties separate pharmacy stock from grocery stock, and both are
-- safety matters rather than conveniences:
--
--   1. Every unit has a death date. "83 in stock" is not a useful answer when
--      40 of them expire in March. Without this the app will happily dispense
--      expired medicine and say nothing.
--   2. Every unit came from a delivery. When a recall lands, the question is
--      "did we sell any of batch XYZ", and nothing here could answer it.
--
-- The design adds no new source of truth. Stock is already an append-only
-- ledger with a derived total; a batch's quantity is derived the same way, by
-- summing that batch's movements. Dispensing allocates FEFO — first expiry
-- first out — which is the FIFO allocation the debt ledger already uses with
-- the sort key changed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Opt in per product
-- ---------------------------------------------------------------------
-- A chemist also sells cotton wool, soap and razor blades. Forcing a batch
-- number onto those trains staff to type rubbish into the one field that has
-- to be trustworthy, so it is off by default and turned on per product.
alter table public.products
  add column if not exists track_batches boolean not null default false;

-- Prescription-only. Carried now because it costs nothing and the dispensing
-- record that needs it is the next piece of work; the till can already warn.
alter table public.products
  add column if not exists is_pom boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. The batch
-- ---------------------------------------------------------------------
create table if not exists public.product_batches (
  id           uuid primary key,
  shop_id      uuid not null references public.shops (id) on delete restrict,
  product_id   uuid not null references public.products (id) on delete restrict,
  -- As printed on the carton. Free text on purpose: manufacturers use every
  -- format there is, and normalising it would lose the thing being matched
  -- against a recall notice.
  batch_no     text not null check (length(btrim(batch_no)) between 1 and 60),
  -- The whole point. A date, not a timestamp: cartons print months, and
  -- pretending to an accuracy the packaging does not have is worse than none.
  expiry_date  date not null,
  note         text,
  created_at   timestamptz not null,
  updated_at   timestamptz not null,
  synced_at    timestamptz not null default now(),

  -- The same batch number of the same product, received twice, is the same
  -- batch. Two rows would split its quantity and let half of it hide from an
  -- expiry report.
  constraint product_batches_unique unique (product_id, batch_no)
);

create index if not exists product_batches_expiry_idx
  on public.product_batches (shop_id, expiry_date);
create index if not exists product_batches_product_idx
  on public.product_batches (shop_id, product_id, expiry_date);

alter table public.product_batches enable row level security;

drop policy if exists product_batches_select on public.product_batches;
create policy product_batches_select on public.product_batches
  for select to authenticated using (shop_id = public.current_shop_id());

-- An attendant receiving a delivery must be able to record it. The batch is
-- transcribed off the carton in front of them; making it owner-only would mean
-- deliveries wait, and stock sitting unrecorded is how expiry tracking dies.
drop policy if exists product_batches_insert on public.product_batches;
create policy product_batches_insert on public.product_batches
  for insert to authenticated
  with check (shop_id = public.current_shop_id());

-- Correcting a mistyped expiry has to be possible — a wrong date is more
-- dangerous than no date, because it will be trusted.
drop policy if exists product_batches_update on public.product_batches;
create policy product_batches_update on public.product_batches
  for update to authenticated
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
-- No DELETE: a batch with movements against it is part of the audit trail.

-- ---------------------------------------------------------------------
-- 3. Movements say which batch they moved
-- ---------------------------------------------------------------------
-- Nullable, because every movement recorded before today has no batch and
-- backfilling a guess would be inventing history. Products that do not track
-- batches keep writing NULL for ever, which is correct rather than missing.
alter table public.stock_movements
  add column if not exists batch_id uuid references public.product_batches (id) on delete restrict;

create index if not exists stock_movements_batch_idx
  on public.stock_movements (batch_id) where batch_id is not null;

-- ---------------------------------------------------------------------
-- 4. sync_batch — register or correct a batch
-- ---------------------------------------------------------------------
-- Idempotent on id like everything else, and additionally collapses on
-- (product_id, batch_no): two devices receiving the same delivery offline
-- would otherwise create two batches holding half the stock each.
create or replace function public.sync_batch(p_batch jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id      uuid := (p_batch ->> 'id')::uuid;
  v_shop    uuid := public.current_shop_id();
  v_product uuid := (p_batch ->> 'product_id')::uuid;
  v_no      text := btrim(p_batch ->> 'batch_no');
  v_existing uuid;
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  if not exists (
    select 1 from public.products p where p.id = v_product and p.shop_id = v_shop
  ) then
    raise exception 'that product does not belong to this shop';
  end if;

  -- Same product, same batch number, already known: reuse it and return the id
  -- the server considers canonical, so the caller can point its movements at
  -- the surviving row.
  select b.id into v_existing
    from public.product_batches b
   where b.product_id = v_product and b.batch_no = v_no;

  if v_existing is not null then
    update public.product_batches
       set expiry_date = (p_batch ->> 'expiry_date')::date,
           note        = nullif(btrim(coalesce(p_batch ->> 'note', '')), ''),
           updated_at  = (p_batch ->> 'updated_at')::timestamptz,
           synced_at   = now()
     where id = v_existing
       -- Never let a stale device overwrite a corrected expiry date.
       and public.product_batches.updated_at <= (p_batch ->> 'updated_at')::timestamptz;
    return v_existing;
  end if;

  insert into public.product_batches (
    id, shop_id, product_id, batch_no, expiry_date, note, created_at, updated_at
  )
  values (
    v_id, v_shop, v_product, v_no,
    (p_batch ->> 'expiry_date')::date,
    nullif(btrim(coalesce(p_batch ->> 'note', '')), ''),
    (p_batch ->> 'created_at')::timestamptz,
    (p_batch ->> 'updated_at')::timestamptz
  )
  on conflict (id) do nothing;

  return v_id;
end;
$$;

grant execute on function public.sync_batch(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Movements carry batch_id through the existing sync paths
-- ---------------------------------------------------------------------
-- sync_sale already accepts an array of movements, so a sale spanning two
-- batches is simply two movements and needs no new transaction shape. Only the
-- column list changes.
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
  v_paid     jsonb := p_sale -> 'immediate_payment';
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
    id, shop_id, product_id, user_id, delta, reason, sale_id, batch_id, created_at
  )
  select
    (m ->> 'id')::uuid, v_shop_id,
    (m ->> 'product_id')::uuid, auth.uid(),
    (m ->> 'delta')::numeric,
    'sale'::public.movement_reason,
    v_sale_id,
    nullif(m ->> 'batch_id', '')::uuid,
    (m ->> 'created_at')::timestamptz
  from jsonb_array_elements(p_movements) as m
  on conflict (id) do nothing;

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

    if v_paid is not null
       and v_paid <> 'null'::jsonb
       and coalesce((v_paid ->> 'amount')::numeric, 0) > 0
    then
      insert into public.debt_entries (
        id, shop_id, customer_id, user_id, kind, amount,
        sale_id, payment_method, mpesa_code, business_date, created_at
      )
      values (
        (v_paid ->> 'id')::uuid,
        v_shop_id, v_customer, auth.uid(), 'payment',
        (v_paid ->> 'amount')::numeric,
        v_sale_id,
        (v_paid ->> 'payment_method')::public.payment_method,
        nullif(btrim(coalesce(v_paid ->> 'mpesa_code', '')), ''),
        (p_sale ->> 'business_date')::date,
        (p_sale ->> 'created_at')::timestamptz
      )
      on conflict (id) do nothing;
    end if;
  end if;

  return v_sale_id;
end;
$$;
grant execute on function public.sync_sale(jsonb, jsonb, jsonb) to authenticated;

-- A standalone movement — restock, opening stock, damage — may also name a batch.
create or replace function public.sync_movement(p_movement jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id     uuid := (p_movement ->> 'id')::uuid;
  v_shop   uuid := public.current_shop_id();
  v_reason public.movement_reason := (p_movement ->> 'reason')::public.movement_reason;
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  -- Both guards carried forward from 0003b. A sale must go through sync_sale
  -- so its movements stay in the same transaction as the sale itself, and
  -- opening stock through sync_new_product so it cannot arrive before the
  -- product exists. Dropping either would reopen a hole this schema closed.
  if v_reason = 'sale' then
    raise exception 'sale movements must go through sync_sale';
  end if;
  if v_reason = 'opening' then
    raise exception 'opening stock must go through sync_new_product';
  end if;

  insert into public.stock_movements (
    id, shop_id, product_id, user_id, delta, reason,
    buying_price, total_cost, note, note_ref, batch_id, created_at
  )
  values (
    v_id, v_shop,
    (p_movement ->> 'product_id')::uuid,
    auth.uid(),
    (p_movement ->> 'delta')::numeric,
    v_reason,
    nullif(p_movement ->> 'buying_price', '')::numeric,
    nullif(p_movement ->> 'total_cost', '')::numeric,
    nullif(btrim(coalesce(p_movement ->> 'note', '')), ''),
    nullif(btrim(coalesce(p_movement ->> 'note_ref', '')), ''),
    nullif(p_movement ->> 'batch_id', '')::uuid,
    (p_movement ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  -- No buying_price update here: apply_stock_movement() has already folded this
  -- delivery's price into the product's weighted average (0006).

  return v_id;
end;
$$;
grant execute on function public.sync_movement(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant select on public.product_batches to authenticated;
grant insert (id, shop_id, product_id, batch_no, expiry_date, note, created_at, updated_at)
  on public.product_batches to authenticated;
grant update (expiry_date, note, updated_at) on public.product_batches to authenticated;
