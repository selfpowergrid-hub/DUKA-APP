-- =====================================================================
-- Stock intake, part B — categories, track_stock, richer movements,
-- and the atomic product+opening-stock RPC.
-- =====================================================================
-- Run AFTER 0003a (the enum values it references must already be committed).
-- Safe to re-run; changes no existing data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Categories. Optional per product — a duka with 20 items does not need
-- them, one with 150 cannot find anything without them.
-- ---------------------------------------------------------------------
create table if not exists public.categories (
  id         uuid primary key,
  shop_id    uuid not null references public.shops (id) on delete restrict,
  name       text not null check (length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists categories_shop_name_unique
  on public.categories (shop_id, lower(btrim(name)));
create index if not exists categories_shop_idx on public.categories (shop_id);

alter table public.categories enable row level security;

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated
  using (shop_id = public.current_shop_id());

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and public.is_owner());

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner())
  with check (shop_id = public.current_shop_id());

-- ---------------------------------------------------------------------
-- products: category + the track_stock opt-out
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists category_id uuid references public.categories (id) on delete set null,
  -- Some things a duka sells have no meaningful count — airtime, a phone
  -- charge, a carrier bag. Without this they sit in the low-stock list
  -- forever, nagging about a number that means nothing.
  add column if not exists track_stock boolean not null default true;

create index if not exists products_category_idx on public.products (shop_id, category_id);

-- ---------------------------------------------------------------------
-- stock_movements: what was actually paid, and a reference
-- ---------------------------------------------------------------------
alter table public.stock_movements
  -- A duka owner is handed an invoice reading "25 packets, KES 4,375", not
  -- "KES 175 each". Store what they were actually told.
  add column if not exists total_cost numeric(12,2) check (total_cost is null or total_cost >= 0),
  add column if not exists note_ref text;

-- Reason shape, now covering the two new values.
-- `damage` gains `delta < 0`, which it should always have had: the old
-- constraint would happily accept damaging positive five packets into
-- existence.
alter table public.stock_movements drop constraint if exists movement_reason_shape;
alter table public.stock_movements add constraint movement_reason_shape check (
  (reason = 'sale'       and delta < 0 and sale_id is not null) or
  (reason = 'restock'    and delta > 0 and sale_id is null)     or
  (reason = 'opening'    and delta > 0 and sale_id is null)     or
  (reason = 'damage'     and delta < 0 and sale_id is null)     or
  (reason = 'loss'       and delta < 0 and sale_id is null)     or
  -- a recount can go either way; that is the whole point of a recount
  (reason = 'adjustment' and sale_id is null)
);

-- =====================================================================
-- sync_new_product — a product and its opening stock, atomically.
-- =====================================================================
-- Registering a product with opening stock is TWO rows, and they must never
-- be able to arrive separately: a movement pushed before its product exists
-- is a foreign-key violation, which the sync engine classifies as permanent
-- and parks. A transient ordering problem would become a stock movement that
-- never syncs.
--
-- Same shape as sync_sale: one transaction, ON CONFLICT DO NOTHING, replaying
-- is a no-op. SECURITY INVOKER (the default) so RLS still applies — the
-- products_insert policy still demands owner + quantity = 0, and the opening
-- quantity still arrives through the ledger trigger like every other movement.
-- =====================================================================
create or replace function public.sync_new_product(p_product jsonb, p_opening jsonb default null)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id   uuid := (p_product ->> 'id')::uuid;
  v_shop uuid := public.current_shop_id();
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  insert into public.products (
    id, shop_id, name, unit, buying_price, selling_price,
    low_stock_threshold, is_active, category_id, track_stock
  )
  values (
    v_id,
    v_shop,
    p_product ->> 'name',
    (p_product ->> 'unit')::public.product_unit,
    coalesce((p_product ->> 'buying_price')::numeric, 0),
    coalesce((p_product ->> 'selling_price')::numeric, 0),
    coalesce((p_product ->> 'low_stock_threshold')::numeric, 0),
    coalesce((p_product ->> 'is_active')::boolean, true),
    nullif(p_product ->> 'category_id', '')::uuid,
    coalesce((p_product ->> 'track_stock')::boolean, true)
  )
  on conflict (id) do nothing;

  -- Product already there means this is a replay, and its opening movement
  -- came with it in the same transaction. Re-inserting would double the stock.
  if not found then
    return v_id;
  end if;

  if p_opening is not null
     and p_opening <> 'null'::jsonb
     and coalesce((p_opening ->> 'delta')::numeric, 0) > 0
  then
    insert into public.stock_movements (
      id, shop_id, product_id, user_id, delta, reason,
      buying_price, total_cost, note, created_at
    )
    values (
      (p_opening ->> 'id')::uuid,
      v_shop,
      v_id,
      auth.uid(),
      (p_opening ->> 'delta')::numeric,
      'opening'::public.movement_reason,
      nullif(p_opening ->> 'buying_price', '')::numeric,
      nullif(p_opening ->> 'total_cost', '')::numeric,
      nullif(btrim(coalesce(p_opening ->> 'note', '')), ''),
      (p_opening ->> 'created_at')::timestamptz
    )
    on conflict (id) do nothing;
  end if;

  return v_id;
end;
$$;
grant execute on function public.sync_new_product(jsonb, jsonb) to authenticated;

-- =====================================================================
-- sync_movement — extended for the new reasons and cost fields.
-- =====================================================================
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
  if v_reason = 'sale' then
    raise exception 'sale movements must go through sync_sale';
  end if;
  if v_reason = 'opening' then
    raise exception 'opening stock must go through sync_new_product';
  end if;

  insert into public.stock_movements (
    id, shop_id, product_id, user_id, delta, reason,
    buying_price, total_cost, note, note_ref, created_at
  )
  values (
    v_id,
    v_shop,
    (p_movement ->> 'product_id')::uuid,
    auth.uid(),
    (p_movement ->> 'delta')::numeric,
    v_reason,
    nullif(p_movement ->> 'buying_price', '')::numeric,
    nullif(p_movement ->> 'total_cost', '')::numeric,
    nullif(btrim(coalesce(p_movement ->> 'note', '')), ''),
    nullif(btrim(coalesce(p_movement ->> 'note_ref', '')), ''),
    (p_movement ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  if found and v_reason = 'restock' and (p_movement ->> 'buying_price') is not null then
    update public.products
       set buying_price = (p_movement ->> 'buying_price')::numeric
     where id = (p_movement ->> 'product_id')::uuid
       and shop_id = v_shop;
  end if;

  return v_id;
end;
$$;
grant execute on function public.sync_movement(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Grants for the new columns and table
-- ---------------------------------------------------------------------
grant select on public.categories to authenticated;
grant insert (id, shop_id, name) on public.categories to authenticated;
grant update (name) on public.categories to authenticated;

grant insert (id, shop_id, name, unit, buying_price, selling_price,
              low_stock_threshold, is_active, category_id, track_stock)
  on public.products to authenticated;
grant update (name, unit, buying_price, selling_price,
              low_stock_threshold, is_active, category_id, track_stock)
  on public.products to authenticated;
-- `quantity` is still absent on purpose: only apply_stock_movement() writes it.
