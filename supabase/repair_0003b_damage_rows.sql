-- =====================================================================
-- Repair before 0003b: damage rows that do not reduce stock.
-- =====================================================================
-- Run this ONLY if 0003b_stock_intake.sql fails with:
--
--   ERROR: 23514: check constraint "movement_reason_shape" of relation
--   "stock_movements" is violated by some row
--
-- Why it happens. 0001 allowed a `damage` movement to carry ANY delta — its
-- branch was `reason in ('adjustment','damage') and sale_id is null`, with no
-- sign check at all. 0003b tightened damage to `delta < 0`, because damage
-- reduces stock; that is what the word means. So a damage row already in the
-- table with a POSITIVE delta blocks the upgrade, and Postgres will not tell
-- you which row it objected to.
--
-- Positive is the only shape that can be at fault: a zero delta is impossible
-- in either version, because the column itself carries `check (delta <> 0)`.
--
-- LOOK FIRST. This shows you the rows before anything is changed:
--
--   select m.id, p.name, m.delta, m.created_at, m.note
--     from public.stock_movements m
--     join public.products p on p.id = m.product_id
--    where m.reason = 'damage' and m.delta > 0
--    order by m.created_at;
--
-- What this does. It re-labels those rows as `adjustment` — the one reason that
-- legitimately carries either sign, and the honest description of "the count
-- was corrected". It does NOT delete anything and does NOT touch any delta:
--
--   * Stock is an append-only ledger. A row that has already moved a product's
--     quantity cannot be removed without rewriting history, and the quantity is
--     maintained by a trigger that would not un-apply it anyway.
--   * Keeping every delta means no product's count changes. Run it during
--     trading if you like; the shelf and the app stay in agreement.
--
-- It appends a note to each row it changes, so the record says a correction
-- happened rather than quietly reading as though it always had.
--
-- It RETURNS the rows it changed, so you can see exactly what moved. Running it
-- a second time returns nothing.
--
-- Verified by test/repair-0003b.test.mjs, which reproduces the failure against
-- a real Postgres and proves this fixes it.
-- =====================================================================

update public.stock_movements
   set reason = 'adjustment',
       note = case
                when coalesce(btrim(note), '') = ''
                then 'Was recorded as damage with a delta that did not reduce stock; '
                     || 're-labelled as a count correction so the 0003b constraint could apply.'
                else note || ' — was recorded as damage with a delta that did not reduce stock; '
                     || 're-labelled as a count correction so the 0003b constraint could apply.'
              end
 where reason = 'damage'
   and delta >= 0
returning id, product_id, delta, created_at, note;
