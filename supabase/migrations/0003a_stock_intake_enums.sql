-- =====================================================================
-- Stock intake, part A — new movement reasons
-- =====================================================================
-- This file exists separately from 0003b for one reason: a new enum value
-- cannot be USED in the same transaction that adds it. 0003b's check
-- constraint references 'opening' and 'loss', so those values must be
-- committed first. Run this file, then 0003b.
--
--   opening — what was already on the shelf when the shop started using the
--             app. Deliberately not 'restock': it is not a purchase on a date,
--             and folding it into restock would corrupt any future answer to
--             "what did I spend on stock this month".
--   loss    — missing or stolen. Deliberately not 'adjustment': "we miscounted"
--             and "someone took it" are different conversations for an owner,
--             and telling those apart is what this app is for.
--
-- Safe to re-run.
-- =====================================================================

alter type public.movement_reason add value if not exists 'opening';
alter type public.movement_reason add value if not exists 'loss';
