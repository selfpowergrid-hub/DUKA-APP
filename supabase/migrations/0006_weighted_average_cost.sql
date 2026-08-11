-- =====================================================================
-- Weighted-average cost.
-- =====================================================================
-- `products.buying_price` was OVERWRITTEN with the latest purchase price on
-- every restock, and every valuation read that figure. So restocking unga at a
-- higher price instantly revalued every packet already on the shelf, and
-- damage recorded last week was costed at this week's price.
--
-- That is "latest cost", which is not a recognised valuation method. This
-- moves to a moving weighted average — the standard recommendation for small
-- retail, because it is stable and needs no cost layering:
--
--   new_avg = (old_qty × old_avg + received_qty × received_price)
--             ÷ (old_qty + received_qty)
--
-- After this, `products.buying_price` means "what a unit of this costs me on
-- average", not "what I paid last time". What was actually paid on any given
-- delivery is still recorded on that restock's stock_movements row, so no
-- information is lost — the two questions simply stop being conflated.
--
-- Computed inside the stock trigger rather than in an RPC so it holds for
-- every path that can ever insert a movement, and is atomic with the quantity
-- update it depends on.
--
-- Safe to re-run. Existing rows keep their current value as the opening
-- average, which is the best estimate available — there is no purchase history
-- to recompute a true average from.
-- =====================================================================

create or replace function public.apply_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Both assignments read the OLD row: in SQL every SET expression sees the
  -- pre-update values, so `quantity` on the right-hand side is the quantity
  -- BEFORE this movement — exactly what the weighted average needs.
  update public.products p
     set quantity = p.quantity + new.delta,
         buying_price = case
           when new.reason in ('restock', 'opening')
                and new.buying_price is not null
                and new.delta > 0
           then round(
                  (greatest(p.quantity, 0) * p.buying_price + new.delta * new.buying_price)
                  / (greatest(p.quantity, 0) + new.delta)
                , 2)
           -- Sales, damage, loss and recounts do not change unit cost. Under
           -- weighted average, taking stock out leaves the average untouched.
           else p.buying_price
         end,
         updated_at = now()
   where p.id = new.product_id
     and p.shop_id = new.shop_id;

  if not found then
    raise exception 'product % not found in shop %', new.product_id, new.shop_id;
  end if;

  return new;
end;
$$;

-- =====================================================================
-- sync_movement must stop overwriting the average with the latest price.
-- =====================================================================
-- The trigger above now owns unit cost entirely. Leaving the old overwrite in
-- place would clobber the freshly-computed average immediately after the
-- trigger set it, which is the exact bug this migration exists to remove.
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

  -- No buying_price update here any more: apply_stock_movement() has already
  -- folded this delivery's price into the product's weighted average.

  return v_id;
end;
$$;
grant execute on function public.sync_movement(jsonb) to authenticated;
