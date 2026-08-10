-- =====================================================================
-- Product photos.
-- =====================================================================
-- Safe to re-run. No new enum values, so no a/b split.
--
-- Photos live in their OWN table rather than on `products`, and that is the
-- whole design decision. A fresh phone signing in pulls the catalogue before it
-- can sell anything; if the thumbnails rode on the product rows, that first
-- pull would carry a few megabytes over a 2G connection and the till would be
-- unusable until it finished. Split out, the catalogue arrives in kilobytes,
-- the shop starts selling, and the photos fill in behind it.
--
-- Stored as a data URL in a text column rather than in object storage. For
-- ~15KB thumbnails that is a deliberate trade: it rides the outbox and the
-- idempotent RPCs that already exist, so it is offline-correct and
-- replay-safe by construction, with no second sync path, no bucket policies
-- and no signed URLs. Postgres TOASTs the column out of line, so it costs the
-- products table nothing.
-- =====================================================================

create table if not exists public.product_images (
  -- The product IS the identity. One photo per product, replaced in place,
  -- which makes the upsert below trivially idempotent.
  product_id uuid primary key references public.products (id) on delete cascade,
  shop_id    uuid not null references public.shops (id) on delete restrict,
  user_id    uuid not null references public.users (id) on delete restrict,
  -- A `data:image/webp;base64,...` URL, already compressed on the device.
  -- The ceiling is enforced here as well as in the client because the client
  -- is the thing most likely to be wrong: a browser without WebP encoding
  -- silently falls back to PNG, which is far larger, and without this the
  -- first shop on an old handset would quietly fill their own database.
  data       text not null check (
               length(data) between 32 and 200000
               and data like 'data:image/%'
             ),
  width      integer,
  height     integer,
  bytes      integer,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  synced_at  timestamptz not null default now()
);

create index if not exists product_images_shop_idx on public.product_images (shop_id);

alter table public.product_images enable row level security;

drop policy if exists product_images_select on public.product_images;
create policy product_images_select on public.product_images
  for select to authenticated using (shop_id = public.current_shop_id());

-- An attendant may photograph stock. They are the one holding the product, and
-- the alternative is that photos never get taken. A wrong photo is visibly
-- wrong and costs nothing to replace, unlike a wrong price or a wrong count.
drop policy if exists product_images_write on public.product_images;
create policy product_images_write on public.product_images
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());

drop policy if exists product_images_update on public.product_images;
create policy product_images_update on public.product_images
  for update to authenticated
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

drop policy if exists product_images_delete on public.product_images;
create policy product_images_delete on public.product_images
  for delete to authenticated
  using (shop_id = public.current_shop_id());

-- =====================================================================
-- sync_product_image — upsert or clear, in one call.
-- =====================================================================
-- Unlike every other sync function here this one is last-write-wins rather
-- than insert-once, because a photo is a CORRECTION, not an event. Replacing a
-- bad photo has to actually replace it. That is safe precisely because a photo
-- carries no money: two devices racing produces one of two photos, and either
-- is fine, whereas two devices racing on a sale would produce a wrong total.
-- =====================================================================
create or replace function public.sync_product_image(p_image jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_product uuid := (p_image ->> 'product_id')::uuid;
  v_shop    uuid := public.current_shop_id();
  v_data    text := nullif(p_image ->> 'data', '');
begin
  if v_shop is null then
    raise exception 'no shop for current user';
  end if;

  -- Guard the product's ownership explicitly. RLS on product_images would stop
  -- a cross-shop write anyway, but the foreign key would fire first and
  -- surface as a constraint error the sync engine parks as permanent rather
  -- than as something the owner can read.
  if not exists (
    select 1 from public.products p
     where p.id = v_product and p.shop_id = v_shop
  ) then
    raise exception 'that product does not belong to this shop';
  end if;

  -- No data means the photo was removed on the device.
  if v_data is null then
    delete from public.product_images where product_id = v_product;
    return v_product;
  end if;

  insert into public.product_images (
    product_id, shop_id, user_id, data, width, height, bytes, created_at, updated_at
  )
  values (
    v_product, v_shop, auth.uid(), v_data,
    nullif(p_image ->> 'width', '')::integer,
    nullif(p_image ->> 'height', '')::integer,
    nullif(p_image ->> 'bytes', '')::integer,
    (p_image ->> 'created_at')::timestamptz,
    (p_image ->> 'updated_at')::timestamptz
  )
  on conflict (product_id) do update
    set data       = excluded.data,
        width      = excluded.width,
        height     = excluded.height,
        bytes      = excluded.bytes,
        user_id    = excluded.user_id,
        updated_at = excluded.updated_at,
        synced_at  = now()
    -- Ignore a replay that is older than what is already stored. Without this,
    -- a phone that was offline for a day would come online and overwrite a
    -- newer photo with its stale one.
    where public.product_images.updated_at <= excluded.updated_at;

  return v_product;
end;
$$;

grant execute on function public.sync_product_image(jsonb) to authenticated;

grant select, insert, update, delete on public.product_images to authenticated;
