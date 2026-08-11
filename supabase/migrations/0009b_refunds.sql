-- =====================================================================
-- Refunds — reversing a sale without ever editing it.
-- =====================================================================
-- Run AFTER 0009a. Safe to re-run.
--
-- A mis-keyed sale currently stands for ever: it still counts toward expected
-- cash, so the drawer reads short by exactly the mistake, and a shortfall the
-- owner cannot explain is indistinguishable from theft. That is this app's
-- central question being answered wrongly.
--
-- The fix keeps every existing guarantee: the sale is never edited or deleted,
-- and the refund is a NEW record pointing at it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The refund
-- ---------------------------------------------------------------------
create table if not exists public.refunds (
  id            uuid primary key,
  shop_id       uuid not null references public.shops (id) on delete restrict,
  -- The sale being reversed. Restrict, not cascade: deleting a sale is already
  -- impossible, and a refund must not become the thing that makes it possible.
  sale_id       uuid not null references public.sales (id) on delete restrict,
  -- Who authorised it. A refund flow without an attributable person is a new
  -- hole rather than a fix — refunding a customer who never returned and
  -- pocketing the cash is a named theft pattern, not a hypothetical.
  user_id       uuid not null references public.users (id) on delete restrict,
  amount        numeric(12,2) not null check (amount > 0),
  -- Where the money PHYSICALLY went back, which is not the same as how the
  -- sale was paid. An M-Pesa sale settles as 'cash', because this app has no
  -- Daraja by design and therefore cannot send M-Pesa. 'credit' means no cash
  -- moved at all: the debt was reversed instead.
  settled_as    text not null check (settled_as in ('cash', 'credit')),
  -- A code, not free text, so refunds can be counted by kind. Loss-prevention
  -- reporting is the point: a rising 'returned' count from one till is a
  -- pattern, and free text cannot be counted.
  reason        text not null check (reason in ('mis_key', 'returned', 'damaged')),
  note          text,
  business_date date not null,
  created_at    timestamptz not null,
  synced_at     timestamptz not null default now(),

  -- "Whole sale only" expressed in the database rather than trusted to the UI.
  -- It also independently blocks the double-refund vector: refunding the same
  -- sale twice and keeping the second. Idempotent replay is unaffected — a
  -- replay carries the same id and is absorbed by `on conflict (id) do
  -- nothing` below. A second, DIFFERENT refund of the same sale raises, which
  -- is correct, and surfaces to the owner in Settings.
  constraint refunds_one_per_sale unique (sale_id)
);

create index if not exists refunds_day_idx on public.refunds (shop_id, business_date);
create index if not exists refunds_sale_idx on public.refunds (shop_id, sale_id);

alter table public.refunds enable row level security;

drop policy if exists refunds_select on public.refunds;
create policy refunds_select on public.refunds
  for select to authenticated using (shop_id = public.current_shop_id());

-- Owner only, enforced here rather than by hiding a button. An attendant
-- cannot fix their own mis-key unaided; that cost is accepted deliberately,
-- because permission beats detection for a flow whose abuse is untraceable
-- once the cash is gone.
drop policy if exists refunds_insert on public.refunds;
create policy refunds_insert on public.refunds
  for insert to authenticated
  with check (
    shop_id = public.current_shop_id()
    and user_id = auth.uid()
    and public.is_owner()
  );
-- No UPDATE, no DELETE. Same append-only rule as every other ledger here.

-- ---------------------------------------------------------------------
-- 2. Stock movements: `return`, and damage that knows where it came from
-- ---------------------------------------------------------------------
-- Two changes, both deliberate:
--
--   `return` REQUIRES a sale_id. Goods only come back from somewhere, and the
--   link is what lets the stock history say "returned from the sale you
--   reversed" instead of leaving an unexplained +3 next to a mysterious -3.
--
--   `damage` may NOW carry a sale_id, where before it had to be null. A
--   damaged return is recorded as `return +qty` then `damage -qty`, and the
--   damage half is worth being traceable to the same sale. It stays optional,
--   so ordinary breakage on the shelf is unaffected.
alter table public.stock_movements drop constraint if exists movement_reason_shape;
alter table public.stock_movements add constraint movement_reason_shape check (
  (reason = 'sale'       and delta < 0 and sale_id is not null) or
  (reason = 'restock'    and delta > 0 and sale_id is null)     or
  (reason = 'opening'    and delta > 0 and sale_id is null)     or
  (reason = 'return'     and delta > 0 and sale_id is not null) or
  (reason = 'damage'     and delta < 0)                         or
  (reason = 'loss'       and delta < 0 and sale_id is null)     or
  -- a recount can go either way; that is the whole point of a recount
  (reason = 'adjustment' and sale_id is null)
);

-- ---------------------------------------------------------------------
-- 3. A debt entry may now be a reversal
-- ---------------------------------------------------------------------
-- Shaped exactly like a charge — it points at a sale and moves no money —
-- but signed the other way when the balance is computed.
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
  or
  (kind = 'reversal'
     and sale_id is not null
     and payment_method is null
     and mpesa_code is null)
);

-- ---------------------------------------------------------------------
-- 4. sync_refund
-- ---------------------------------------------------------------------
-- The refund, the stock coming back, and any debt reversal land in ONE
-- transaction. A refund that reached the server without its return movement
-- would show money out and stock still gone; the reverse would show stock back
-- and the drawer still expecting the money. Both are briefly wrong on the one
-- screen the shop is meant to trust.
create or replace function public.sync_refund(
  p_refund    jsonb,
  p_movements jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid := (p_refund ->> 'id')::uuid;
  v_shop     uuid := public.current_shop_id();
  v_sale_id  uuid := (p_refund ->> 'sale_id')::uuid;
  v_settled  text := p_refund ->> 'settled_as';
  v_customer uuid;
  v_method   public.payment_method;
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  -- Checked here as well as in the RLS policy. This function is SECURITY
  -- DEFINER so that it can read the sale it is reversing, which means the
  -- policy alone would not be doing the work the policy appears to do.
  if public.is_owner() is distinct from true then
    raise exception 'only an owner can refund a sale';
  end if;

  select s.customer_id, s.payment_method
    into v_customer, v_method
    from public.sales s
   where s.id = v_sale_id and s.shop_id = v_shop;

  if not found then
    raise exception 'that sale does not belong to this shop';
  end if;

  insert into public.refunds (
    id, shop_id, sale_id, user_id, amount,
    settled_as, reason, note, business_date, created_at
  )
  values (
    v_id, v_shop, v_sale_id, auth.uid(),
    (p_refund ->> 'amount')::numeric,
    v_settled,
    p_refund ->> 'reason',
    nullif(btrim(coalesce(p_refund ->> 'note', '')), ''),
    (p_refund ->> 'business_date')::date,
    (p_refund ->> 'created_at')::timestamptz
  )
  on conflict (id) do nothing;

  -- Already applied. Returning early keeps a retry from re-inserting the
  -- movements, which would put the stock back twice.
  if not found then
    return v_id;
  end if;

  -- Goods coming back. A damaged return is two movements — `return` then
  -- `damage` — because a single no-op would record that stock did not change
  -- while losing both facts: that the goods came back, and that they were
  -- written off. The shrink report needs the second one.
  insert into public.stock_movements (
    id, shop_id, product_id, user_id, delta, reason, sale_id, created_at
  )
  select
    (m ->> 'id')::uuid, v_shop,
    (m ->> 'product_id')::uuid, auth.uid(),
    (m ->> 'delta')::numeric,
    (m ->> 'reason')::public.movement_reason,
    v_sale_id,
    (m ->> 'created_at')::timestamptz
  from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) as m
  on conflict (id) do nothing;

  -- A credit sale reversed moves no cash: they never paid. If they had
  -- part-paid at the till for more than they kept, the FIFO allocation turns
  -- the excess into credit toward their next purchase on its own.
  if v_settled = 'credit' then
    if v_method is distinct from 'credit' then
      raise exception 'only a credit sale can be settled as credit';
    end if;
    insert into public.debt_entries (
      id, shop_id, customer_id, user_id, kind, amount,
      sale_id, business_date, created_at
    )
    values (
      coalesce(nullif(p_refund ->> 'debt_entry_id', '')::uuid, gen_random_uuid()),
      v_shop, v_customer, auth.uid(), 'reversal',
      (p_refund ->> 'amount')::numeric,
      v_sale_id,
      (p_refund ->> 'business_date')::date,
      (p_refund ->> 'created_at')::timestamptz
    )
    on conflict (id) do nothing;
  elsif v_method = 'credit' then
    -- The opposite mistake: handing cash back for goods that were never paid
    -- for. Refused outright rather than left to the UI.
    raise exception 'a credit sale is reversed, not refunded in cash';
  end if;

  return v_id;
end;
$$;

grant execute on function public.sync_refund(jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant select on public.refunds to authenticated;
grant insert (id, shop_id, sale_id, user_id, amount,
              settled_as, reason, note, business_date, created_at)
  on public.refunds to authenticated;
