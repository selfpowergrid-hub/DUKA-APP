-- =====================================================================
-- The M-Pesa confirmation code becomes OPTIONAL.
-- =====================================================================
-- Safe to re-run. No new enum values, so no a/b split.
--
-- Why the requirement was wrong, despite the code being genuinely useful:
--
-- Requiring it does not produce more codes. It produces fewer RECORDED SALES.
-- The customer's SMS has not arrived, or their phone is dead, or the queue is
-- four deep — and the attendant's only ways forward were to not record the sale
-- at all, or to record it as cash. The first loses the sale entirely; the
-- second corrupts the cash/M-Pesa split, which is the one thing this app exists
-- to keep straight. A blocking field aimed at accuracy was quietly producing
-- the two least accurate outcomes available.
--
-- So the code stays first-class and prompted for, and the CONTROL moves from a
-- block to visibility: Closing shows exactly which M-Pesa sales have no code
-- and therefore cannot be ticked off against the Safaricom statement. An owner
-- who can see "3 of today's 11 M-Pesa sales have no code" has something they
-- can act on. An attendant blocked at the till just works around the app.
--
-- What is deliberately NOT relaxed: a cash sale still may not carry a code, a
-- credit sale still may not, and an M-Pesa sale still may not carry a tendered
-- amount. Those are shape errors, not missing information.
-- =====================================================================

alter table public.sales drop constraint if exists sales_payment_shape;
alter table public.sales add constraint sales_payment_shape check (
  (payment_method = 'cash'
     and amount_tendered is not null
     and amount_tendered >= total
     and mpesa_code is null)
  or
  (payment_method = 'mpesa'
     -- The code may now be absent. When present it must still be sane: a blank
     -- string is not a code, and storing '' would make "has a code" untestable
     -- everywhere downstream. The client sends NULL rather than ''.
     and (mpesa_code is null or length(btrim(mpesa_code)) between 1 and 32)
     and amount_tendered is null)
  or
  (payment_method = 'credit'
     and customer_id is not null
     and amount_tendered is null
     and mpesa_code is null)
);

-- ---------------------------------------------------------------------
-- The same relaxation for a debt repayment made by M-Pesa
-- ---------------------------------------------------------------------
-- Identical reasoning: a debtor who sends money and cannot produce the code is
-- still a debtor who paid, and refusing to record that is worse than recording
-- it without the reference. `payment_method is not null` stays load-bearing —
-- a CHECK only rejects on FALSE, so a NULL method would otherwise sail through
-- the branch meant to stop it and land in neither column at Closing.
alter table public.debt_entries drop constraint if exists debt_entry_shape;
alter table public.debt_entries add constraint debt_entry_shape check (
  (kind = 'charge'
     and sale_id is not null
     and payment_method is null
     and mpesa_code is null)
  or
  (kind = 'payment'
     and payment_method is not null
     and payment_method in ('cash', 'mpesa')
     and (payment_method = 'mpesa' or mpesa_code is null))
  or
  (kind = 'writeoff'
     and sale_id is null
     and payment_method is null
     and mpesa_code is null)
  or
  (kind = 'reversal'
     and sale_id is not null
     and payment_method is null
     and mpesa_code is null)
);
