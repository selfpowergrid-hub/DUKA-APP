-- =====================================================================
-- Dispensing records — who a prescription-only medicine actually went to.
-- =====================================================================
-- Safe to re-run. No new enum values, so no a/b split.
--
-- `products.is_pom` has existed since 0012 and warned at the till. A warning is
-- not a record. Selling a prescription-only medicine carries a record-keeping
-- obligation, and until now every sale in this app was anonymous: a POM sale
-- and a bar of soap left exactly the same trace.
--
-- The record attaches to the SALE, not to each line. A customer presents one
-- prescription and may take three items off it, and one record per sale is how
-- the paper register works too.
--
-- Deliberately NOT built here: any clinical record. Diagnosis, allergies and
-- dosage history belong to a patient record system with obligations this app
-- does not meet, and half a clinical record is worse than none.
-- =====================================================================

create table if not exists public.dispensing_records (
  id                uuid primary key,
  shop_id           uuid not null references public.shops (id) on delete restrict,
  -- One prescription per sale. A second record against the same sale would
  -- mean two prescriptions for one transaction, which is a mis-key rather
  -- than a real event.
  sale_id           uuid not null unique references public.sales (id) on delete restrict,
  -- Who handed it over. The app cannot verify anyone's qualification, so what
  -- it records is the auditable fact: this person dispensed it, at this time.
  user_id           uuid not null references public.users (id) on delete restrict,

  patient_name      text not null check (length(btrim(patient_name)) between 1 and 120),
  -- The prescriber, as written on the prescription. Free text: it may be a
  -- doctor, a clinic or a hospital, and forcing a format would mean staff
  -- typing whatever fits rather than what is written.
  prescriber        text not null check (length(btrim(prescriber)) between 1 and 120),
  -- Prescription number or reference, where there is one. Optional, because
  -- plenty of handwritten prescriptions carry none, and a required field with
  -- no real answer gets filled with rubbish.
  prescription_ref  text,
  patient_phone     text,
  note              text,

  business_date     date not null,
  created_at        timestamptz not null,
  synced_at         timestamptz not null default now()
);

create index if not exists dispensing_day_idx
  on public.dispensing_records (shop_id, business_date);
create index if not exists dispensing_patient_idx
  on public.dispensing_records (shop_id, patient_name);

alter table public.dispensing_records enable row level security;

drop policy if exists dispensing_select on public.dispensing_records;
create policy dispensing_select on public.dispensing_records
  for select to authenticated using (shop_id = public.current_shop_id());

-- Any user may record one, because whoever is at the counter is the person
-- dispensing, and making this owner-only would mean the record is written
-- later by someone who was not there — which is worse than useless.
drop policy if exists dispensing_insert on public.dispensing_records;
create policy dispensing_insert on public.dispensing_records
  for insert to authenticated
  with check (shop_id = public.current_shop_id() and user_id = auth.uid());
-- No UPDATE, no DELETE. A dispensing register that can be edited afterwards is
-- not a register.

grant select on public.dispensing_records to authenticated;
grant insert (id, shop_id, sale_id, user_id, patient_name, prescriber,
              prescription_ref, patient_phone, note, business_date, created_at)
  on public.dispensing_records to authenticated;

-- =====================================================================
-- sync_sale — now carries the prescription, in the same transaction.
-- =====================================================================
-- Same reasoning as the debt charge and the part-payment before it. A sale
-- that reached the server without its dispensing record would be a POM sale
-- with no record of who received it — precisely the gap this migration closes,
-- reopened by a dropped connection.
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
  v_disp     jsonb := p_sale -> 'dispensing';
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
    id, shop_id, product_id, user_id, delta, reason, sale_id, batch_id, created_at
  )
  select
    (m ->> 'id')::uuid, v_shop_id,
    (m ->> 'product_id')::uuid, auth.uid(),
    (m ->> 'delta')::numeric,
    'sale'::public.movement_reason,
    v_sale_id,
    nullif(m ->> 'batch_id', '')::uuid,
    (m ->> 'created_at')::timestamptz
  from jsonb_array_elements(p_movements) as m
  on conflict (id) do nothing;

  -- The prescription, if this sale carried one.
  if v_disp is not null and v_disp <> 'null'::jsonb then
    insert into public.dispensing_records (
      id, shop_id, sale_id, user_id, patient_name, prescriber,
      prescription_ref, patient_phone, note, business_date, created_at
    )
    values (
      (v_disp ->> 'id')::uuid,
      v_shop_id, v_sale_id, auth.uid(),
      btrim(v_disp ->> 'patient_name'),
      btrim(v_disp ->> 'prescriber'),
      nullif(btrim(coalesce(v_disp ->> 'prescription_ref', '')), ''),
      nullif(btrim(coalesce(v_disp ->> 'patient_phone', '')), ''),
      nullif(btrim(coalesce(v_disp ->> 'note', '')), ''),
      (p_sale ->> 'business_date')::date,
      (p_sale ->> 'created_at')::timestamptz
    )
    on conflict (id) do nothing;
  end if;

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
