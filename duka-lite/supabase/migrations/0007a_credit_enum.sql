-- =====================================================================
-- Customer debt, part A — the credit payment method.
-- =====================================================================
-- Separate file for the same reason 0003a was: a new enum value cannot be
-- USED in the transaction that adds it, and 0007b's rewritten
-- `sales_payment_shape` constraint references 'credit'. Run this, then 0007b.
--
-- Safe to re-run.
-- =====================================================================

alter type public.payment_method add value if not exists 'credit';
