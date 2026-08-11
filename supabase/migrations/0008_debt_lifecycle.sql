-- =====================================================================
-- Debt lifecycle — part-payment at the till, and the chase.
-- =====================================================================
-- No new enum values, so this is a single file rather than a split a/b pair.
-- Safe to re-run. Run after 0007b.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A payment may now name the sale it was made against.
-- ---------------------------------------------------------------------
-- Still optional: a repayment weeks later has sale_id null, exactly as before.
-- What this enables is telling "paid at the till" apart from "old debt repaid
-- today". Both raise expected cash identically, so the money was already
-- right — but filing a part-payment made thirty seconds ago under "old debt
-- repaid" is a small lie on the one screen that exists to stop small lies.
-- It also makes a part-payment traceable back to the sale it belongs to.
alter table public.debt_entries drop constraint if exists debt_entry_shape;
alter table public.debt_entries add constraint debt_entry_shape check (
  (kind = 'charge'
     and sale_id is not null
     and payment_method is null
     and mpesa_code is null)
  or
  -- `payment_method is not null` remains load-bearing: a CHECK only rejects on
  -- FALSE, and a NULL comparison would let a repayment with no method through
  -- the constraint meant to stop it.
  (kind = 'payment'
     and payment_method is not null
     and payment_method in ('cash', 'mpesa')
     and (payment_method = 'cash' or mpesa_code is not null))
  or
  (kind = 'writeoff'
     and sale_id is null
     and payment_method is null
     and mpesa_code is null)
);

-- ---------------------------------------------------------------------
-- 2. The chase
-- ---------------------------------------------------------------------
create table if not exists public.debt_reminders (
  id              uuid primary key,
  shop_id         uuid not null references public.shops (id) on delete restrict,
  customer_id     uuid not null references public.customers (id) on delete restrict,
  user_id         uuid not null references public.users (id) on delete restrict,
  channel         text not null check (channel in ('whatsapp', 'sms', 'call', 'in_person')),
  -- What they owed at the moment they were chased. Without this you cannot
  -- later see that someone was reminded at 1,000 and has since grown to 1,800,
  -- which is the single most useful thing a reminder history can tell you.
  balance_at_time numeric(12,2) not null check (balance_at_time >= 0),
  -- "nitalipa Ijumaa". A broken promise is a far stronger signal than age
  -- alone, and it is the moment to stop extending more credit.
  promised_date   date,
  note            text,
  created_at      timestamptz not null,
  synced_at       timestamptz not null default now()
);
create index if not exists debt_reminders_customer_idx
  on public.debt_reminders (shop_id, customer_id, created_at);
create index if not exists debt_reminders_promise_idx
  on public.debt_reminders (shop_id, promised_date);

alter table public.debt_reminders enable row level security;

drop policy if exists debt_reminders_select on public.debt_reminders;
create policy debt_reminders_select on public.debt_reminders
  for select to authenticated using (shop_id = public.current_shop_id());

-- An attendant may chase a debt: they are usually the one who sees the
-- customer. Same reasoning as letting them create the customer in the first
-- place — the alternative pushes the interaction back off the system.
drop policy if exists debt_reminders_insert on public.debt_reminders;
create policy debt_reminders_insert on public.debt_reminders
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());
-- No UPDATE, no DELETE. "I reminded you on Tuesday" is only worth anything if
-- it cannot be edited afterwards.

-- ---------------------------------------------------------------------
-- 3. Shop-level settings: the reminder message template
-- ---------------------------------------------------------------------
alter table public.shops
  add column if not exists reminder_template text;

-- =====================================================================
-- sync_sale — now able to record a part-payment taken at the till.
-- =====================================================================
-- A part-payment is THREE rows: the sale, its charge, and the payment. All
-- three go in one transaction. A payment that landed while its charge did not
-- would show the customer in credit; the reverse would overstate the debt.
-- Briefly, but visibly, and on the screen the shop trusts.
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

    -- Money handed over at the counter, in the same breath as the sale.
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

-- =====================================================================
-- sync_debt_reminder
-- =====================================================================
create or replace function public.sync_debt_reminder(p_reminder jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id   uuid := (p_reminder ->> 'id')::uuid;
  v_shop uuid := public.current_shop_id();
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  insert into public.debt_reminders (
    id, shop_id, customer_id, user_id, channel,
    balance_at_time, promised_date, note, created_at
  )
  values (
    v_id,
    v_shop,
    (p_reminder ->> 'customer_id')::uuid,
    auth.uid(),
    p_reminder ->> 'channel',
    (p_reminder ->> 'balance_at_time')::numeric,
    nullif(p_reminder ->> 'promised_date', '')::date,
    nullif(btrim(coalesce(p_reminder ->> 'note', '')), ''),
    (p_reminder ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  return v_id;
end;
$$;
grant execute on function public.sync_debt_reminder(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant select on public.debt_reminders to authenticated;
grant insert (id, shop_id, customer_id, user_id, channel,
              balance_at_time, promised_date, note, created_at)
  on public.debt_reminders to authenticated;

grant update (name, reminder_template) on public.shops to authenticated;
