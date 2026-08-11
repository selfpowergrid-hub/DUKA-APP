-- =====================================================================
-- Which migrations has this database actually had?
-- =====================================================================
-- Paste into the Supabase SQL editor and run. One row per migration,
-- reporting whether the thing that migration exists to create is present.
--
-- It checks for the ARTEFACT, not for a bookkeeping row, so it tells the
-- truth about a database whose migrations were pasted by hand — which is
-- exactly the situation it is for. Read-only; safe to run any time.
--
-- Anything reporting MISSING: run that file from supabase/migrations/.
-- 0002-0008 are all safe to re-run, so when in doubt, run it.
-- =====================================================================

with checks as (

  select '0001_init' as migration, 'core tables, RLS, sync_sale' as adds,
         to_regclass('public.sales') is not null
     and to_regclass('public.products') is not null as applied

  union all
  -- 0002 closed a guard that fell open: current_user_role() returns NULL for a
  -- caller with no users row, so `NULL = 'owner'` is NULL, so `if not
  -- is_owner()` never fired. Two markers because the fix was in two places, and
  -- either one alone can be present for unrelated reasons.
  --
  -- Note: 0001_init.sql in this repo has since had the fix folded in, so a
  -- database created from it TODAY legitimately reports ok without ever
  -- running 0002. Only a database created from the original 0001 reports
  -- MISSING here — which is the case this row exists to catch.
  select '0002_fix_owner_guard', 'owner guard cannot fall open',
         coalesce(
           (select pg_get_functiondef(p.oid) ilike '%coalesce%'
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='is_owner' limit 1), false)
     and coalesce(
           (select pg_get_functiondef(p.oid) ilike '%is distinct from true%'
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='create_attendant' limit 1), false)

  union all
  select '0003a_stock_intake_enums', 'movement reasons: opening, loss',
         exists (select 1 from pg_enum e
                   join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'movement_reason' and e.enumlabel = 'opening')
     and exists (select 1 from pg_enum e
                   join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'movement_reason' and e.enumlabel = 'loss')

  union all
  select '0003b_stock_intake', 'categories, track_stock, sync_new_product',
         to_regclass('public.categories') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='products'
                    and column_name='track_stock')

  union all
  select '0004_units_groups_portions', 'shop units, pack groups, portions',
         to_regclass('public.units') is not null
     and to_regclass('public.product_portions') is not null

  union all
  select '0005_reporting', 'cost at time of sale, report indexes',
         exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='sale_items'
                    and column_name='unit_cost')

  union all
  -- The weighted average lives inside the stock trigger, so there is no column
  -- to look for. `greatest(` appears only in the averaging expression.
  select '0006_weighted_average_cost', 'moving weighted-average cost',
         coalesce(
           (select pg_get_functiondef(p.oid) ilike '%greatest(%'
              from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'apply_stock_movement'
             limit 1),
           false)

  union all
  select '0007a_credit_enum', 'payment method: credit',
         exists (select 1 from pg_enum e
                   join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'payment_method' and e.enumlabel = 'credit')

  union all
  select '0007b_customer_debt', 'customers, debt_entries ledger',
         to_regclass('public.customers') is not null
     and to_regclass('public.debt_entries') is not null

  union all
  select '0008_debt_lifecycle', 'part-payment at till, reminders, promises',
         to_regclass('public.debt_reminders') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='shops'
                    and column_name='reminder_template')
     and exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='sync_debt_reminder')

  union all
  select '0009a_refund_enums', 'movement reason: return, debt kind: reversal',
         exists (select 1 from pg_enum e
                   join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'movement_reason' and e.enumlabel = 'return')
     and exists (select 1 from pg_enum e
                   join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'debt_entry_kind' and e.enumlabel = 'reversal')

  union all
  select '0009b_refunds', 'refunds table, owner-only, sync_refund',
         to_regclass('public.refunds') is not null
     and exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='sync_refund')

  union all
  -- No table or column to look for: 0010 only RELAXES two check constraints.
  -- Detected by behaviour instead — can an M-Pesa sale exist without a code?
  -- pg_get_constraintdef is the honest way to ask without writing a row.
  select '0010_optional_mpesa_code', 'M-Pesa confirmation code is optional',
         coalesce(
           (select pg_get_constraintdef(c.oid) not ilike '%mpesa_code IS NOT NULL%'
              from pg_constraint c
              join pg_class t on t.oid = c.conrelid
              join pg_namespace n on n.oid = t.relnamespace
             where n.nspname='public' and t.relname='sales'
               and c.conname='sales_payment_shape'
             limit 1),
           false)

  union all
  select '0011_product_images', 'product photos',
         to_regclass('public.product_images') is not null
     and exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='sync_product_image')

  union all
  select '0012_batches_and_expiry', 'batches, expiry dates, FEFO dispensing',
         to_regclass('public.product_batches') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='stock_movements'
                    and column_name='batch_id')
     and exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='products'
                    and column_name='track_batches')

  union all
  select '0013_expenses', 'running costs, and the drawer effect',
         to_regclass('public.expenses') is not null
     and exists (select 1 from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='public' and p.proname='sync_expense')
)

select
  migration,
  case when applied then 'ok' else '>>> MISSING - run this file' end as status,
  adds as "what it adds"
from checks
order by migration;
