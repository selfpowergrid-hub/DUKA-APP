-- =====================================================================
-- Duka Lite — v1 schema, constraints, triggers, RLS, sync RPCs
-- =====================================================================
-- Design rules encoded here:
--   * every table carries shop_id and is isolated by RLS, never by the client
--   * ids for anything a phone can create offline are CLIENT-GENERATED uuids,
--     so re-syncing the same row is a primary-key conflict and therefore a no-op
--   * products.quantity is a trigger-maintained cache of stock_movements;
--     nothing outside this file may write it
--   * nothing is ever hard-deleted (no DELETE policy exists on any table)
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.payment_method as enum ('cash', 'mpesa');
create type public.product_unit   as enum ('pc', 'kg', 'litre', 'packet');
create type public.movement_reason as enum ('sale', 'restock', 'adjustment', 'damage');
create type public.user_role      as enum ('owner', 'attendant');

-- ---------------------------------------------------------------------
-- shops
-- ---------------------------------------------------------------------
create table public.shops (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- users — extends auth.users with shop + role
-- ---------------------------------------------------------------------
create table public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  shop_id    uuid not null references public.shops (id) on delete restrict,
  role       public.user_role not null default 'attendant',
  full_name  text,
  created_at timestamptz not null default now()
);
create index users_shop_idx on public.users (shop_id);

-- Helpers. SECURITY DEFINER so that RLS policies on other tables can read the
-- caller's row in public.users without recursing into public.users' own policies.
create or replace function public.current_shop_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.shop_id from public.users u where u.id = auth.uid();
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select u.role from public.users u where u.id = auth.uid();
$$;

-- coalesce is load-bearing. For a caller with no row in public.users this
-- returns NULL, and `if not NULL then raise` never fires — an authorization
-- guard that silently falls open. Never let this function return NULL.
create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(public.current_user_role() = 'owner', false);
$$;

revoke execute on function public.current_shop_id()   from public;
revoke execute on function public.current_user_role() from public;
grant  execute on function public.current_shop_id()   to authenticated;
grant  execute on function public.current_user_role() to authenticated;
grant  execute on function public.is_owner()          to authenticated;

-- ---------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------
create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops (id) on delete restrict,
  name                text not null check (length(btrim(name)) between 1 and 120),
  unit                public.product_unit not null default 'pc',
  buying_price        numeric(12,2) not null default 0 check (buying_price  >= 0),
  selling_price       numeric(12,2) not null default 0 check (selling_price >= 0),
  quantity            numeric(12,3) not null default 0,   -- trigger-maintained, do not write
  low_stock_threshold numeric(12,3) not null default 0 check (low_stock_threshold >= 0),
  is_active           boolean not null default true,      -- soft delete
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index products_shop_active_idx on public.products (shop_id, is_active);
create index products_shop_name_idx   on public.products (shop_id, lower(name));
create index products_updated_idx     on public.products (shop_id, updated_at);
create unique index products_shop_name_unique
  on public.products (shop_id, lower(btrim(name))) where is_active;

-- ---------------------------------------------------------------------
-- sales  (id is a client uuid — this is what makes sync idempotent)
-- ---------------------------------------------------------------------
create table public.sales (
  id              uuid primary key,
  shop_id         uuid not null references public.shops (id) on delete restrict,
  user_id         uuid not null references public.users (id) on delete restrict,
  total           numeric(12,2) not null check (total > 0),
  payment_method  public.payment_method not null,
  amount_tendered numeric(12,2),
  mpesa_code      text,
  business_date   date not null,          -- Africa/Nairobi day, decided on the device
  created_at      timestamptz not null,   -- device clock at point of sale
  synced_at       timestamptz not null default now(),
  constraint sales_payment_shape check (
    (payment_method = 'cash'
       and amount_tendered is not null
       and amount_tendered >= total
       and mpesa_code is null)
    or
    (payment_method = 'mpesa'
       and mpesa_code is not null
       and length(btrim(mpesa_code)) between 1 and 32
       and amount_tendered is null)
  )
);
create index sales_shop_date_idx    on public.sales (shop_id, business_date);
create index sales_shop_created_idx on public.sales (shop_id, created_at);

-- ---------------------------------------------------------------------
-- sale_items — product name/price denormalised: a receipt records what was
-- actually charged, not what the product costs today
-- ---------------------------------------------------------------------
create table public.sale_items (
  id           uuid primary key,
  sale_id      uuid not null references public.sales (id) on delete cascade,
  shop_id      uuid not null references public.shops (id) on delete restrict,
  product_id   uuid not null references public.products (id) on delete restrict,
  product_name text not null,
  unit_price   numeric(12,2) not null check (unit_price >= 0),
  quantity     numeric(12,3) not null check (quantity > 0),
  line_total   numeric(12,2) not null check (line_total >= 0)
);
create index sale_items_sale_idx on public.sale_items (sale_id);
create index sale_items_shop_idx on public.sale_items (shop_id);

-- ---------------------------------------------------------------------
-- stock_movements — the ledger. products.quantity is derived from this.
-- ---------------------------------------------------------------------
create table public.stock_movements (
  id           uuid primary key,
  shop_id      uuid not null references public.shops (id) on delete restrict,
  product_id   uuid not null references public.products (id) on delete restrict,
  user_id      uuid not null references public.users (id) on delete restrict,
  delta        numeric(12,3) not null check (delta <> 0),  -- signed: sales are negative
  reason       public.movement_reason not null,
  buying_price numeric(12,2) check (buying_price >= 0),    -- restock only
  sale_id      uuid references public.sales (id) on delete cascade,
  note         text,
  created_at   timestamptz not null,
  synced_at    timestamptz not null default now(),
  constraint movement_reason_shape check (
    (reason = 'sale'   and delta < 0 and sale_id is not null) or
    (reason = 'restock' and delta > 0 and sale_id is null) or
    (reason in ('adjustment', 'damage') and sale_id is null)
  )
);
create index stock_movements_product_idx on public.stock_movements (shop_id, product_id, created_at);
create index stock_movements_sale_idx    on public.stock_movements (sale_id);

-- ---------------------------------------------------------------------
-- cash_counts — one per shop per day, upserted (last write wins)
-- ---------------------------------------------------------------------
create table public.cash_counts (
  id             uuid primary key,
  shop_id        uuid not null references public.shops (id) on delete restrict,
  user_id        uuid not null references public.users (id) on delete restrict,
  business_date  date not null,
  counted_amount numeric(12,2) not null check (counted_amount >= 0),
  created_at     timestamptz not null,
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  unique (shop_id, business_date)
);
create index cash_counts_shop_date_idx on public.cash_counts (shop_id, business_date);

-- =====================================================================
-- Triggers
-- =====================================================================

-- products.quantity is a cache of sum(stock_movements.delta). Only this
-- trigger maintains it; the RLS policy below forbids clients from changing it.
create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.products
     set quantity   = quantity + new.delta,
         updated_at = now()
   where id = new.product_id
     and shop_id = new.shop_id;

  if not found then
    raise exception 'product % not found in shop %', new.product_id, new.shop_id;
  end if;

  return new;
end;
$$;

create trigger stock_movements_apply
  after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- Repair hook: recompute a product's cached quantity from the ledger.
create or replace function public.recompute_product_quantity(p_product_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qty numeric(12,3);
begin
  select coalesce(sum(m.delta), 0) into v_qty
    from public.stock_movements m
   where m.product_id = p_product_id;

  update public.products
     set quantity = v_qty, updated_at = now()
   where id = p_product_id
     and shop_id = public.current_shop_id();

  return v_qty;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_touch_updated
  before update on public.products
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.shops           enable row level security;
alter table public.users           enable row level security;
alter table public.products        enable row level security;
alter table public.sales           enable row level security;
alter table public.sale_items      enable row level security;
alter table public.stock_movements enable row level security;
alter table public.cash_counts     enable row level security;

-- Deliberately NOT using FORCE ROW LEVEL SECURITY: the quantity trigger, the
-- signup trigger and the sync RPC helpers run as SECURITY DEFINER and must be
-- able to maintain rows that no client is allowed to touch. Clients only ever
-- connect as `authenticated`, which RLS constrains fully.

-- shops: read your own shop; only an owner may rename it.
create policy shops_select on public.shops
  for select to authenticated
  using (id = public.current_shop_id());

create policy shops_update on public.shops
  for update to authenticated
  using (id = public.current_shop_id() and public.is_owner())
  with check (id = public.current_shop_id());

-- users: everyone reads their own row; owners read the whole shop roster.
create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid());

create policy users_select_shop on public.users
  for select to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner());

create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and shop_id = public.current_shop_id());
-- NB: inserts into public.users happen through the signup trigger and the
-- owner-only create_attendant() RPC below, never directly from a client.

-- products: whole shop reads; owners write. `quantity` is excluded from the
-- column-level UPDATE grant at the bottom of this file, so no client can write
-- it under any policy — only the stock_movements trigger can.
create policy products_select on public.products
  for select to authenticated
  using (shop_id = public.current_shop_id());

create policy products_insert on public.products
  for insert to authenticated
  with check (shop_id = public.current_shop_id()
              and public.is_owner()
              and quantity = 0);

create policy products_update on public.products
  for update to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner())
  with check (shop_id = public.current_shop_id());

-- sales: the whole shop can read the day (the Closing screen needs it);
-- any signed-in staff member can record a sale as themselves.
create policy sales_select on public.sales
  for select to authenticated
  using (shop_id = public.current_shop_id());

create policy sales_insert on public.sales
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());
-- deliberately no UPDATE and no DELETE policy: a recorded sale is immutable.

create policy sale_items_select on public.sale_items
  for select to authenticated
  using (shop_id = public.current_shop_id());

create policy sale_items_insert on public.sale_items
  for insert to authenticated
  with check (shop_id = public.current_shop_id());

create policy movements_select on public.stock_movements
  for select to authenticated
  using (shop_id = public.current_shop_id());

create policy movements_insert on public.stock_movements
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());
-- no UPDATE/DELETE: the stock ledger is append-only. Mistakes are corrected
-- with a compensating 'adjustment' movement.

create policy cash_counts_select on public.cash_counts
  for select to authenticated
  using (shop_id = public.current_shop_id());

create policy cash_counts_insert on public.cash_counts
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());

create policy cash_counts_update on public.cash_counts
  for update to authenticated
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());

-- =====================================================================
-- Signup: creating an owner also creates their shop.
-- Attendants are created by an owner through create_attendant(), which
-- pre-seeds public.users so this trigger finds a shop waiting for them.
-- =====================================================================
create table public.pending_invites (
  email      text primary key,
  shop_id    uuid not null references public.shops (id) on delete cascade,
  role       public.user_role not null default 'attendant',
  full_name  text,
  created_at timestamptz not null default now()
);
alter table public.pending_invites enable row level security;
-- no policies: only SECURITY DEFINER functions touch this table.

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
  select * into v_invite from public.pending_invites
   where email = lower(new.email);

  if found then
    v_shop_id := v_invite.shop_id;
    v_role    := v_invite.role;
    v_name    := coalesce(v_invite.full_name, new.raw_user_meta_data ->> 'full_name');
    delete from public.pending_invites where email = v_invite.email;
  else
    -- self-signup: this person is an owner, give them a shop
    insert into public.shops (name)
    values (coalesce(nullif(btrim(new.raw_user_meta_data ->> 'shop_name'), ''), 'Duka'))
    returning id into v_shop_id;
    v_role := 'owner';
    v_name := new.raw_user_meta_data ->> 'full_name';
  end if;

  insert into public.users (id, shop_id, role, full_name)
  values (new.id, v_shop_id, v_role, v_name);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Owner invites an attendant by email; the row is claimed at first signup.
create or replace function public.create_attendant(p_email text, p_full_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop_id uuid := public.current_shop_id();
begin
  if v_shop_id is null then
    raise exception 'no shop for current user';
  end if;

  -- `is distinct from true` rather than `not ...`: a NULL guard falls open.
  if public.is_owner() is distinct from true then
    raise exception 'only an owner can add staff';
  end if;

  insert into public.pending_invites (email, shop_id, role, full_name)
  values (lower(btrim(p_email)), v_shop_id, 'attendant', p_full_name)
  on conflict (email) do update
    set shop_id = excluded.shop_id,
        role = excluded.role,
        full_name = excluded.full_name;
end;
$$;
grant execute on function public.create_attendant(text, text) to authenticated;

-- =====================================================================
-- sync_sale — the idempotency contract
-- =====================================================================
-- One transaction writes the sale, its lines and its stock movements.
-- Every insert is ON CONFLICT (id) DO NOTHING, so replaying the identical
-- payload after a dropped connection changes nothing and returns success.
-- SECURITY INVOKER (the default): RLS still applies to every row written.
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
    v_sale_id,
    v_shop_id,
    auth.uid(),
    (p_sale ->> 'total')::numeric,
    (p_sale ->> 'payment_method')::public.payment_method,
    nullif(p_sale ->> 'amount_tendered', '')::numeric,
    nullif(btrim(coalesce(p_sale ->> 'mpesa_code', '')), ''),
    (p_sale ->> 'business_date')::date,
    (p_sale ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  -- If the sale already existed, its lines and movements are already there
  -- too (they were written in the same transaction). Stop: re-inserting
  -- movements would double-count stock.
  if not found then
    return v_sale_id;
  end if;

  insert into public.sale_items (
    id, sale_id, shop_id, product_id, product_name, unit_price, quantity, line_total
  )
  select
    (i ->> 'id')::uuid,
    v_sale_id,
    v_shop_id,
    (i ->> 'product_id')::uuid,
    i ->> 'product_name',
    (i ->> 'unit_price')::numeric,
    (i ->> 'quantity')::numeric,
    (i ->> 'line_total')::numeric
  from jsonb_array_elements(p_items) as i
  on conflict (id) do nothing;

  insert into public.stock_movements (
    id, shop_id, product_id, user_id, delta, reason, sale_id, created_at
  )
  select
    (m ->> 'id')::uuid,
    v_shop_id,
    (m ->> 'product_id')::uuid,
    auth.uid(),
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

-- Restock / adjustment / damage: a single movement, same idempotency rule.
create or replace function public.sync_movement(p_movement jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id      uuid := (p_movement ->> 'id')::uuid;
  v_shop_id uuid := public.current_shop_id();
  v_reason  public.movement_reason := (p_movement ->> 'reason')::public.movement_reason;
begin
  if v_reason = 'sale' then
    raise exception 'sale movements must go through sync_sale';
  end if;

  insert into public.stock_movements (
    id, shop_id, product_id, user_id, delta, reason, buying_price, note, created_at
  )
  values (
    v_id,
    v_shop_id,
    (p_movement ->> 'product_id')::uuid,
    auth.uid(),
    (p_movement ->> 'delta')::numeric,
    v_reason,
    nullif(p_movement ->> 'buying_price', '')::numeric,
    nullif(btrim(coalesce(p_movement ->> 'note', '')), ''),
    (p_movement ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  -- A restock also updates the product's buying price, but only the first time
  -- this movement is applied.
  if found and v_reason = 'restock' and (p_movement ->> 'buying_price') is not null then
    update public.products
       set buying_price = (p_movement ->> 'buying_price')::numeric
     where id = (p_movement ->> 'product_id')::uuid
       and shop_id = v_shop_id;
  end if;

  return v_id;
end;
$$;
grant execute on function public.sync_movement(jsonb) to authenticated;

-- Cash count: idempotent by (shop_id, business_date).
create or replace function public.sync_cash_count(p_count jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_shop_id uuid := public.current_shop_id();
  v_id      uuid;
begin
  insert into public.cash_counts (
    id, shop_id, user_id, business_date, counted_amount, created_at, updated_at
  )
  values (
    (p_count ->> 'id')::uuid,
    v_shop_id,
    auth.uid(),
    (p_count ->> 'business_date')::date,
    (p_count ->> 'counted_amount')::numeric,
    (p_count ->> 'created_at')::timestamptz,
    now()
  )
  on conflict (shop_id, business_date) do update
    set counted_amount = excluded.counted_amount,
        user_id        = excluded.user_id,
        updated_at     = now()
  returning id into v_id;

  return v_id;
end;
$$;
grant execute on function public.sync_cash_count(jsonb) to authenticated;

-- =====================================================================
-- Grants — RLS does the real work, these just open the doors.
-- =====================================================================
grant usage on schema public to authenticated;
grant select                         on public.shops           to authenticated;
grant update (name)                  on public.shops           to authenticated;
grant select                         on public.users           to authenticated;
grant update (full_name)             on public.users           to authenticated;
grant select                         on public.products        to authenticated;
grant insert (id, shop_id, name, unit, buying_price, selling_price,
              low_stock_threshold, is_active)
                                     on public.products        to authenticated;
-- `quantity` is absent from this list on purpose: it is the derived stock cache
-- and only public.apply_stock_movement() may change it.
grant update (name, unit, buying_price, selling_price,
              low_stock_threshold, is_active)
                                     on public.products        to authenticated;
grant select, insert                 on public.sales           to authenticated;
grant select, insert                 on public.sale_items      to authenticated;
grant select, insert                 on public.stock_movements to authenticated;
grant select, insert, update         on public.cash_counts     to authenticated;
-- note: no DELETE granted anywhere, on purpose.
