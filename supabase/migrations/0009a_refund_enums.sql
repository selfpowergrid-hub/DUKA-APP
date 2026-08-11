-- =====================================================================
-- Refunds, part A — the two new enum values.
-- =====================================================================
-- Separate from 0009b for the same reason 0003a and 0007a were: a new enum
-- value cannot be USED in the transaction that adds it, and 0009b's rewritten
-- debt_entry_shape constraint references 'reversal'. Run this, then 0009b.
--
--   return   — goods coming back onto the shelf. Deliberately not 'restock':
--              that is a purchase on a date, and folding a return into it
--              would corrupt any answer to "what did I spend on stock this
--              month". Deliberately not 'adjustment' either, which would lose
--              the reason entirely.
--
--   reversal — a debt cancelled because the goods came back. Deliberately NOT
--              'writeoff': a write-off is a loss the owner chose to absorb,
--              and a reversal is not a loss at all. Recording one as the other
--              would silently inflate the bad-debt figure on the very screen
--              built to make that figure honest.
--
-- Safe to re-run.
-- =====================================================================

alter type public.movement_reason  add value if not exists 'return';
alter type public.debt_entry_kind  add value if not exists 'reversal';
