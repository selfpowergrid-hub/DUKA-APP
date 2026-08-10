-- =====================================================================
-- Duka Lite — demo seed
-- =====================================================================
-- Creates one shop with 20 realistic Kenyan duka products and opening stock.
--
-- Local dev:   supabase db reset   (runs migrations then this file)
-- Hosted:      paste into the SQL editor AFTER you have signed up, then set
--              v_shop_id below to your own shop id (select id from shops).
--
-- Opening stock is written as `restock` movements, never by touching
-- products.quantity — same rule the app follows.
-- =====================================================================

do $$
declare
  v_shop_id uuid;
  v_user_id uuid;
  v_prod_id uuid;
  r record;
begin
  -- Attach to the first existing shop, or make a demo one if the database is
  -- empty (fresh `supabase db reset` with no signups yet).
  select id into v_shop_id from public.shops order by created_at limit 1;
  if v_shop_id is null then
    insert into public.shops (name) values ('Duka ya Mama Njeri') returning id into v_shop_id;
  end if;

  select id into v_user_id from public.users where shop_id = v_shop_id order by created_at limit 1;

  for r in
    select * from (values
      -- name,                        unit,       buy,     sell,   opening, low
      ('Unga Jogoo 2kg',              'packet',   175.00,  200.00,   40,  8),
      ('Unga Pembe 2kg',              'packet',   170.00,  195.00,   30,  8),
      ('Sukari Mumias 1kg',           'packet',   145.00,  165.00,   50, 10),
      ('Sukari Kabras 2kg',           'packet',   290.00,  330.00,   20,  5),
      ('Mchele Pishori 1kg',          'packet',   180.00,  210.00,   25,  6),
      ('Maharagwe 1kg',               'kg',       130.00,  160.00,   30,  6),
      ('Omo 500g',                    'packet',    95.00,  120.00,   40, 10),
      ('Sunlight Bar 800g',           'pc',        90.00,  115.00,   25,  6),
      ('Blue Band 250g',              'pc',       140.00,  170.00,   20,  5),
      ('Kimbo 500g',                  'pc',       165.00,  195.00,   18,  4),
      ('Kasuku 500ml',                'pc',       130.00,  155.00,   24,  6),
      ('Mafuta Rina 1L',              'litre',    250.00,  290.00,   15,  4),
      ('Royco Mchuzi Mix 10g',        'pc',         8.00,   10.00,  100, 20),
      ('Chumvi Kensalt 1kg',          'packet',    30.00,   40.00,   30,  8),
      ('Maziwa Fresha 500ml',         'pc',        55.00,   65.00,   40, 12),
      ('Mkate Supa Loaf 400g',        'pc',        60.00,   70.00,   20,  6),
      ('Mayai (tray 30)',             'pc',       390.00,  450.00,    8,  2),
      ('Colgate 75ml',                'pc',       130.00,  160.00,   16,  4),
      ('Dettol 100ml',                'pc',       115.00,  145.00,   12,  3),
      ('Kiberiti (matchbox)',         'pc',         3.00,    5.00,  200, 40)
    ) as t(name, unit, buy, sell, opening, low)
  loop
    insert into public.products
      (shop_id, name, unit, buying_price, selling_price, low_stock_threshold)
    values
      (v_shop_id, r.name, r.unit, r.buy, r.sell, r.low)
    on conflict do nothing
    returning id into v_prod_id;

    -- Opening stock as a restock movement (the trigger sets products.quantity).
    if v_prod_id is not null and v_user_id is not null then
      insert into public.stock_movements
        (id, shop_id, product_id, user_id, delta, reason, buying_price, total_cost, note, created_at)
      values
        (gen_random_uuid(), v_shop_id, v_prod_id, v_user_id, r.opening, 'opening',
         r.buy, r.opening * r.buy, 'Opening stock', now());
    elsif v_prod_id is not null then
      -- No user yet (fresh reset): set the cache directly, this is seed data only.
      update public.products set quantity = r.opening where id = v_prod_id;
    end if;

    v_prod_id := null;
  end loop;

  raise notice 'Seeded shop %', v_shop_id;
end $$;
