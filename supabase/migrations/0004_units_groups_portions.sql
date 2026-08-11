-- =====================================================================
-- Units you can define yourself, pack-size groups, and measured selling.
-- =====================================================================
-- Three things, all driven by one real shop problem: cooking oil sold as
-- sealed 1L/5L/10L bottles AND poured by the half-litre from a drum.
--
--   1. products.unit stops being an enum. Four hard-coded values meant a
--      schema change and a redeploy every time a shop needed "tray" or "sack".
--   2. products.group_name clusters sealed pack sizes for display, while their
--      stock stays completely independent — selling a 5L must never touch the
--      1L count.
--   3. product_portions lets ONE pool of stock be sold in named measures.
--      A 20 litre drum sold as "½ litre" moves the ledger by 0.5 litre.
--
-- Safe to re-run. Run after 0003b.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Units
-- ---------------------------------------------------------------------
-- No foreign key from products.unit to this table, deliberately. An FK would
-- recreate the two-row ordering bug that sync_new_product exists to prevent:
-- a product created offline against a unit created in the same session could
-- be pushed first, hit a foreign-key violation, and be parked forever. Storing
-- the code as text means a unit can never go missing. This table exists only
-- to populate the picker and to answer "does this unit allow halves".
-- ---------------------------------------------------------------------
create table if not exists public.units (
  id            uuid primary key,
  shop_id       uuid not null references public.shops (id) on delete restrict,
  code          text not null check (length(btrim(code)) between 1 and 16),
  label         text not null check (length(btrim(label)) between 1 and 40),
  is_fractional boolean not null default false,
  sort_order    int not null default 100,
  created_at    timestamptz not null default now()
);
create unique index if not exists units_shop_code_unique
  on public.units (shop_id, lower(btrim(code)));
create index if not exists units_shop_idx on public.units (shop_id);

alter table public.units enable row level security;

drop policy if exists units_select on public.units;
create policy units_select on public.units
  for select to authenticated using (shop_id = public.current_shop_id());

drop policy if exists units_insert on public.units;
create policy units_insert on public.units
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and public.is_owner());

drop policy if exists units_update on public.units;
create policy units_update on public.units
  for update to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner())
  with check (shop_id = public.current_shop_id());

-- The enum goes. `using unit::text` preserves every existing value exactly.
-- public.product_unit is left in place but unused — dropping it would make
-- 0001 unre-runnable for no benefit.
alter table public.products alter column unit drop default;
alter table public.products alter column unit type text using unit::text;
alter table public.products alter column unit set default 'pc';
alter table public.products
  add constraint products_unit_not_blank check (length(btrim(unit)) between 1 and 16);

create or replace function public.seed_default_units(p_shop_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.units (id, shop_id, code, label, is_fractional, sort_order)
  select gen_random_uuid(), p_shop_id, d.code, d.label, d.frac, d.ord
  from (values
    ('pc',     'Piece',        false,  10),
    ('packet', 'Packet',       false,  20),
    ('bottle', 'Bottle',       false,  30),
    ('tin',    'Tin',          false,  40),
    ('bar',    'Bar',          false,  50),
    ('sachet', 'Sachet',       false,  60),
    ('kg',     'Kilogram',     true,   70),
    ('g',      'Gram',         true,   80),
    ('litre',  'Litre',        true,   90),
    ('ml',     'Millilitre',   true,  100),
    ('tray',   'Tray',         false, 110),
    ('crate',  'Crate',        false, 120),
    ('dozen',  'Dozen',        false, 130),
    ('bale',   'Bale',         false, 140),
    ('sack',   'Sack',         false, 150),
    ('roll',   'Roll',         false, 160),
    ('bunch',  'Bunch',        false, 170),
    ('metre',  'Metre',        true,  180)
  ) as d(code, label, frac, ord)
  on conflict do nothing;
$$;
grant execute on function public.seed_default_units(uuid) to authenticated;

-- Backfill every shop that already exists.
do $$
declare s record;
begin
  for s in select id from public.shops loop
    perform public.seed_default_units(s.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Pack-size grouping (the SEALED case)
-- ---------------------------------------------------------------------
-- Presentational only. Grouped products keep entirely separate stock —
-- that independence is what makes this shape safe.
alter table public.products add column if not exists group_name text;
create index if not exists products_group_idx on public.products (shop_id, group_name);

-- ---------------------------------------------------------------------
-- 3. Portions (the MEASURED case)
-- ---------------------------------------------------------------------
-- One pool of stock, sold in named measures. factor is how much of the
-- product's own unit a single portion consumes: "½ litre" -> 0.5.
create table if not exists public.product_portions (
  id         uuid primary key,
  shop_id    uuid not null references public.shops (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  factor     numeric(12,4) not null check (factor > 0),
  price      numeric(12,2) not null check (price >= 0),
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);
create index if not exists portions_product_idx on public.product_portions (product_id, sort_order);
create index if not exists portions_shop_idx on public.product_portions (shop_id);

alter table public.product_portions enable row level security;

drop policy if exists portions_select on public.product_portions;
create policy portions_select on public.product_portions
  for select to authenticated using (shop_id = public.current_shop_id());

drop policy if exists portions_insert on public.product_portions;
create policy portions_insert on public.product_portions
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and public.is_owner());

drop policy if exists portions_update on public.product_portions;
create policy portions_update on public.product_portions
  for update to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner())
  with check (shop_id = public.current_shop_id());

-- The only DELETE policy in this database. Portions are configuration, not
-- ledger: removing "½ litre" from the price list must not rewrite the sales
-- that were rung up at that measure, and it does not — sale_items keeps its
-- own copy of the portion name and factor.
drop policy if exists portions_delete on public.product_portions;
create policy portions_delete on public.product_portions
  for delete to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner());

-- ---------------------------------------------------------------------
-- 4. sale_items remembers what the customer actually bought
-- ---------------------------------------------------------------------
-- A receipt has to read "½ litre × 3", not "1.5 litre". quantity stays the
-- number of portions; base_quantity is what left the pool and is what the
-- stock movement used.
alter table public.sale_items
  add column if not exists portion_name   text,
  add column if not exists portion_factor numeric(12,4) check (portion_factor is null or portion_factor > 0),
  add column if not exists base_quantity  numeric(12,3);

-- ---------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------

-- sync_sale, now carrying portion detail on each line. Stock movements are
-- unchanged: the client already sends deltas in base units.
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
  v_sale_id uuid := (p_sale ->> 'id')::uuid;
  v_shop_id uuid := public.current_shop_id();
begin
  if v_shop_id is null then
    raise exception 'no shop for current user';
  end if;

  insert into public.sales (
    id, shop_id, user_id, total, payment_method,
    amount_tendered, mpesa_code, business_date, created_at
  )
  values (
    v_sale_id, v_shop_id, auth.uid(),
    (p_sale ->> 'total')::numeric,
    (p_sale ->> 'payment_method')::public.payment_method,
    nullif(p_sale ->> 'amount_tendered', '')::numeric,
    nullif(btrim(coalesce(p_sale ->> 'mpesa_code', '')), ''),
    (p_sale ->> 'business_date')::date,
    (p_sale ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  if not found then
    return v_sale_id;
  end if;

  insert into public.sale_items (
    id, sale_id, shop_id, product_id, product_name, unit_price, quantity, line_total,
    portion_name, portion_factor, base_quantity
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
    nullif(i ->> 'base_quantity', '')::numeric
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

  return v_sale_id;
end;
$$;
grant execute on function public.sync_sale(jsonb, jsonb, jsonb) to authenticated;

-- The 0003b two-argument version must go before the three-argument one is
-- created. Postgres would keep both as overloads, and a two-argument call —
-- which is exactly what the client sends for a product with no portions —
-- then matches both and fails with "could not choose a best candidate
-- function". That breaks every product registration through PostgREST, not
-- just in tests.
drop function if exists public.sync_new_product(jsonb, jsonb);

-- sync_new_product, now text units, group name, and portions in the same
-- transaction as the product they belong to.
create or replace function public.sync_new_product(
  p_product  jsonb,
  p_opening  jsonb default null,
  p_portions jsonb default null
)
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
    low_stock_threshold, is_active, category_id, track_stock, group_name
  )
  values (
    v_id, v_shop,
    p_product ->> 'name',
    coalesce(nullif(btrim(p_product ->> 'unit'), ''), 'pc'),
    coalesce((p_product ->> 'buying_price')::numeric, 0),
    coalesce((p_product ->> 'selling_price')::numeric, 0),
    coalesce((p_product ->> 'low_stock_threshold')::numeric, 0),
    coalesce((p_product ->> 'is_active')::boolean, true),
    nullif(p_product ->> 'category_id', '')::uuid,
    coalesce((p_product ->> 'track_stock')::boolean, true),
    nullif(btrim(coalesce(p_product ->> 'group_name', '')), '')
  )
  on conflict (id) do nothing;

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
      (p_opening ->> 'id')::uuid, v_shop, v_id, auth.uid(),
      (p_opening ->> 'delta')::numeric, 'opening'::public.movement_reason,
      nullif(p_opening ->> 'buying_price', '')::numeric,
      nullif(p_opening ->> 'total_cost', '')::numeric,
      nullif(btrim(coalesce(p_opening ->> 'note', '')), ''),
      (p_opening ->> 'created_at')::timestamptz
    )
    on conflict (id) do nothing;
  end if;

  if p_portions is not null and p_portions <> 'null'::jsonb then
    insert into public.product_portions (id, shop_id, product_id, name, factor, price, sort_order)
    select
      (pt ->> 'id')::uuid, v_shop, v_id,
      pt ->> 'name',
      (pt ->> 'factor')::numeric,
      (pt ->> 'price')::numeric,
      coalesce((pt ->> 'sort_order')::int, 100)
    from jsonb_array_elements(p_portions) as pt
    on conflict (id) do nothing;
  end if;

  return v_id;
end;
$$;
grant execute on function public.sync_new_product(jsonb, jsonb, jsonb) to authenticated;

-- Replace a product's whole portion list in one transaction. The editor is a
-- list, so replace-all is the honest operation — anything else leaves orphans
-- when a row is removed offline.
create or replace function public.sync_portions(p_product_id uuid, p_portions jsonb)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_shop uuid := public.current_shop_id();
  v_keep uuid[];
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;
  if not exists (select 1 from public.products where id = p_product_id and shop_id = v_shop) then
    raise exception 'product not found in this shop';
  end if;

  select coalesce(array_agg((pt ->> 'id')::uuid), '{}')
    into v_keep
    from jsonb_array_elements(coalesce(p_portions, '[]'::jsonb)) as pt;

  delete from public.product_portions
   where product_id = p_product_id
     and shop_id = v_shop
     and not (id = any (v_keep));

  insert into public.product_portions (id, shop_id, product_id, name, factor, price, sort_order)
  select
    (pt ->> 'id')::uuid, v_shop, p_product_id,
    pt ->> 'name',
    (pt ->> 'factor')::numeric,
    (pt ->> 'price')::numeric,
    coalesce((pt ->> 'sort_order')::int, 100)
  from jsonb_array_elements(coalesce(p_portions, '[]'::jsonb)) as pt
  on conflict (id) do update
    set name = excluded.name,
        factor = excluded.factor,
        price = excluded.price,
        sort_order = excluded.sort_order;

  return coalesce(array_length(v_keep, 1), 0);
end;
$$;
grant execute on function public.sync_portions(uuid, jsonb) to authenticated;

-- New shops get the default unit list at signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid;
  v_role    public.user_role;
  v_name    text;
  v_invite  public.pending_invites%rowtype;
begin
  select * into v_invite from public.pending_invites where email = lower(new.email);

  if found then
    v_shop_id := v_invite.shop_id;
    v_role    := v_invite.role;
    v_name    := coalesce(v_invite.full_name, new.raw_user_meta_data ->> 'full_name');
    delete from public.pending_invites where email = v_invite.email;
  else
    insert into public.shops (name)
    values (coalesce(nullif(btrim(new.raw_user_meta_data ->> 'shop_name'), ''), 'Duka'))
    returning id into v_shop_id;
    v_role := 'owner';
    v_name := new.raw_user_meta_data ->> 'full_name';
    perform public.seed_default_units(v_shop_id);
  end if;

  insert into public.users (id, shop_id, role, full_name)
  values (new.id, v_shop_id, v_role, v_name);

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant select on public.units to authenticated;
grant insert (id, shop_id, code, label, is_fractional, sort_order) on public.units to authenticated;
grant update (code, label, is_fractional, sort_order) on public.units to authenticated;

grant select, delete on public.product_portions to authenticated;
grant insert (id, shop_id, product_id, name, factor, price, sort_order)
  on public.product_portions to authenticated;
grant update (name, factor, price, sort_order) on public.product_portions to authenticated;

grant insert (id, shop_id, name, unit, buying_price, selling_price,
              low_stock_threshold, is_active, category_id, track_stock, group_name)
  on public.products to authenticated;
grant update (name, unit, buying_price, selling_price,
              low_stock_threshold, is_active, category_id, track_stock, group_name)
  on public.products to authenticated;

grant insert (id, sale_id, shop_id, product_id, product_name, unit_price,
              quantity, line_total, portion_name, portion_factor, base_quantity)
  on public.sale_items to authenticated;
