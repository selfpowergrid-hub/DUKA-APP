-- =====================================================================
-- Expenses — what the shop spends that is not stock.
-- =====================================================================
-- Safe to re-run. No new enum values, so no a/b split.
--
-- Two things this is for, and the second one matters more than the first.
--
--   1. The trading account becomes a real profit and loss account. Revenue
--      less cost of goods was only ever half the picture; rent and wages are
--      the other half, and a shop cannot tell whether it is actually making
--      money without them.
--
--   2. THE DRAWER. When the owner takes 2,000 out of the till to pay for
--      transport, the drawer is 2,000 short at Closing — and a shortfall
--      nobody can explain is indistinguishable from theft, which is the exact
--      ambiguity this whole app exists to remove. Recording an expense as
--      "paid from the till" lowers expected cash by that amount, so the count
--      balances and the money is accounted for rather than merely missing.
--
-- Deliberately NOT a category here: buying stock. That already flows through
-- restock movements into cost of goods sold, and recording it again as an
-- expense would count the same shilling twice and understate profit.
-- =====================================================================

create table if not exists public.expenses (
  id            uuid primary key,
  shop_id       uuid not null references public.shops (id) on delete restrict,
  user_id       uuid not null references public.users (id) on delete restrict,

  category      text not null check (category in (
                  'rent', 'salaries', 'transport', 'utilities',
                  'licences', 'airtime', 'repairs', 'other'
                )),
  amount        numeric(12,2) not null check (amount > 0),

  -- Where the money physically came from. This is what decides whether the
  -- drawer should be lighter tonight, so it is required rather than inferred:
  -- 'till_cash' reduces expected cash, 'mpesa' reduces expected M-Pesa, and
  -- 'other' (the owner's own pocket, or a bank transfer) touches neither
  -- while still counting against profit.
  paid_from     text not null check (paid_from in ('till_cash', 'mpesa', 'other')),

  note          text,
  business_date date not null,

  -- Append-only, corrected by voiding rather than editing. A mistyped amount
  -- has to be fixable — an expense stuck at 20,000 instead of 2,000 would
  -- wreck every report after it — but the original must stay visible, because
  -- an expense that can be silently rewritten is an expense nobody can audit.
  voided_at     timestamptz,
  void_reason   text,

  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  synced_at     timestamptz not null default now()
);

create index if not exists expenses_day_idx on public.expenses (shop_id, business_date);

alter table public.expenses enable row level security;

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated using (shop_id = public.current_shop_id());

-- Owner only, for the same reason refunds are: money leaving with no goods
-- coming in is the least verifiable transaction in the app. A fake expense —
-- "transport, 500" — and 500 in the pocket is the same theft pattern as a
-- phantom refund, and permission beats detection when the cash is already gone.
drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check (
    shop_id = public.current_shop_id()
    and user_id = auth.uid()
    and public.is_owner()
  );

-- Update exists ONLY to void. The column grant below is what enforces that:
-- amount, category and date cannot be changed by any client, whatever the
-- policy says.
drop policy if exists expenses_void on public.expenses;
create policy expenses_void on public.expenses
  for update to authenticated
  using (shop_id = public.current_shop_id() and public.is_owner())
  with check (shop_id = public.current_shop_id() and public.is_owner());
-- No DELETE. A voided expense stays in the record.

-- =====================================================================
-- sync_expense — record, or void an existing one.
-- =====================================================================
create or replace function public.sync_expense(p_expense jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid := (p_expense ->> 'id')::uuid;
  v_shop uuid := public.current_shop_id();
  v_void timestamptz := nullif(p_expense ->> 'voided_at', '')::timestamptz;
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  -- Checked here as well as in the policy: this function is SECURITY DEFINER,
  -- so the policy alone would not be doing the work it appears to do.
  if public.is_owner() is distinct from true then
    raise exception 'only an owner can record or void an expense';
  end if;

  insert into public.expenses (
    id, shop_id, user_id, category, amount, paid_from,
    note, business_date, voided_at, void_reason, created_at, updated_at
  )
  values (
    v_id, v_shop, auth.uid(),
    p_expense ->> 'category',
    (p_expense ->> 'amount')::numeric,
    p_expense ->> 'paid_from',
    nullif(btrim(coalesce(p_expense ->> 'note', '')), ''),
    (p_expense ->> 'business_date')::date,
    v_void,
    nullif(btrim(coalesce(p_expense ->> 'void_reason', '')), ''),
    (p_expense ->> 'created_at')::timestamptz,
    (p_expense ->> 'updated_at')::timestamptz
  )
  on conflict (id) do update
    -- Only the void fields. Amount, category, date and who recorded it are
    -- fixed for ever once written; a replay carrying different figures is
    -- ignored rather than trusted.
    set voided_at   = excluded.voided_at,
        void_reason = excluded.void_reason,
        updated_at  = excluded.updated_at,
        synced_at   = now()
    where public.expenses.updated_at <= excluded.updated_at;

  return v_id;
end;
$$;

grant execute on function public.sync_expense(jsonb) to authenticated;

grant select on public.expenses to authenticated;
grant insert (id, shop_id, user_id, category, amount, paid_from,
              note, business_date, voided_at, void_reason, created_at, updated_at)
  on public.expenses to authenticated;
-- The narrow update grant is the real guarantee: whatever a client sends, only
-- these three columns can move.
grant update (voided_at, void_reason, updated_at) on public.expenses to authenticated;
