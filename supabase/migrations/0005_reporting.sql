-- =====================================================================
-- Reporting support.
-- =====================================================================
-- One column and two indexes. The column is the important part.
--
-- sale_items has never recorded what the goods COST at the moment they were
-- sold, only what the customer paid. Any margin report therefore had to use
-- the product's *current* buying price — so the day a shop restocks unga at a
-- higher price, every unga sale it ever made silently re-values and last
-- month's profit changes.
--
-- This cannot be backfilled. The cost at the moment of each past sale is gone.
-- Margin is exact from here on and approximate before it, and the reports
-- screen says which is which rather than quietly presenting a moving number.
--
-- Safe to re-run. Run after 0004.
-- =====================================================================

alter table public.sale_items
  add column if not exists unit_cost numeric(12,2)
    check (unit_cost is null or unit_cost >= 0);

comment on column public.sale_items.unit_cost is
  'Buying price per base unit at the moment of sale. NULL means the sale predates this column — report it as unknown, never as zero.';

-- Reporting reads a whole period at once and groups by person or by reason.
create index if not exists sales_shop_user_date_idx
  on public.sales (shop_id, user_id, business_date);
create index if not exists movements_shop_reason_idx
  on public.stock_movements (shop_id, reason, created_at);
create index if not exists sale_items_product_idx
  on public.sale_items (shop_id, product_id);

-- sync_sale, now carrying the cost of each line.
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

  return v_sale_id;
end;
$$;
grant execute on function public.sync_sale(jsonb, jsonb, jsonb) to authenticated;

grant insert (id, sale_id, shop_id, product_id, product_name, unit_price,
              quantity, line_total, portion_name, portion_factor, base_quantity,
              unit_cost)
  on public.sale_items to authenticated;
