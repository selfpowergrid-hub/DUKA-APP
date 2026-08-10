# Backlog — agreed next, not built

Three things deliberately parked. Each is a **scope expansion beyond the original brief**, which
listed *returns or refunds*, *credit sales or customer debt*, and (implicitly) shift handling as
out of scope for v1. Recording that here so it stays a decision rather than drift.

Written while building the reports, because reports are what exposed the cost of not having
them — see the notes under each.

---

## 1. Returns and refunds

**Status: BUILT.** See the "Refunds" section of `duka-lite/README.md`, and `REFUNDS-PLAN.md`
for the four decisions that shaped it. Shipped as migration `0009a`/`0009b`: an append-only
`refunds` table, owner-only by RLS, whole-sale-only by `unique (sale_id)`, with an M-Pesa sale
refunded in cash and a credit sale reversed rather than paid out. The notes below are kept as
the record of what was decided and why.

### Why it matters more than it looks

An attendant will mis-key a sale. Today the sale stands for ever and there is no way to reverse
it. The stock can be corrected with an `adjustment` movement, but **the money cannot** — the
sale still counts toward cash expected at Closing, so the drawer will read short by exactly the
amount of the mistake, and the owner has no way to tell that shortfall apart from theft.

That is the app's central question being answered wrongly, which makes this more than a
convenience feature.

The reports made it concrete: void and refund exception reports rank near the top of every
independent-retail reporting guide, and **this app cannot produce one at all**, because it has
no concept of a void. A whole category of loss-prevention reporting is unavailable.

### Design notes for when we do it

- **Never delete or edit the original sale.** The ledger is append-only everywhere else and
  refunds must not be the exception. A refund is a *new* record that points at the original:
  a negative sale, or a `refunds` table with `original_sale_id`.
- **Stock returns via a movement**, reason `return`, positive delta — unless the goods came back
  damaged, in which case the attendant should be asked, and it becomes a `damage` movement
  instead. That question is the whole value of the screen.
- **Closing must show refunds as their own line**, not silently netted into sales. "Sales 12,400,
  refunds −800, net 11,600" is the honest shape; a single 11,600 hides the thing the owner most
  wants to see.
- **Refunds need a reason and an attributable person.** Phantom refunds — refunding a customer
  who never returned anything, and pocketing the cash — are a named theft pattern in the loss
  prevention literature. A refund flow without a reason code and a user id is a new hole, not a
  fix.
- **Partial refunds** of one line of a multi-line sale are the fiddly case. Worth deciding
  up front whether v1 of this is whole-sale-only.
- **Who may refund?** Owner-only is safest to start. RLS enforces it.

### Open question — now answered

Cash refund out of the drawer is straightforward. **An M-Pesa refund is not** — the money went
to a phone and this app has no Daraja integration by design.

**Answered: an M-Pesa sale is refunded in cash, and the screen says so explicitly.** Expected
cash drops, expected M-Pesa is untouched. The alternative — recording an M-Pesa transfer the app
cannot verify happened — is the same gap the manually-typed confirmation code exists to avoid.

Two further questions were raised and answered at the same time: **owner-only** refunds, enforced
by RLS rather than by hiding a button; and **whole-sale-only**, which per-line refunds can extend
later without changing the data shape.

---

## 2. Customer debt / credit sales

**Status: BUILT.** See the "Customer debt" section of `duka-lite/README.md`.

Shipped as `payment_method = 'credit'` plus an append-only `debt_entries` ledger with FIFO
allocation derived at read time, duka-tuned ageing buckets, credit limits as warnings rather
than blocks, and Closing/Reports accounting for credit and repayments on both the cash and
M-Pesa sides. The notes below are kept as the record of what was decided and why.

**The lifecycle is built too** (migration `0008`): part-payment at the till, an append-only
reminder log, promise-to-pay dates driving a *Chase today* queue, statement sharing, and a
discard archive so a rejected record is never destroyed. See the "Customer debt", "The chase"
and "Nothing gets lost" sections of `duka-lite/README.md`.

The open question below — *should a credit sale reduce stock immediately?* — was answered yes,
and is asserted in `test:offline`: goods leave the shop on credit exactly as on a cash sale.

### Why it matters

Selling on credit — *"andika kwa deni"* — is normal in a duka, and today it has to be recorded
as either a cash sale (which makes the drawer read short and looks exactly like theft) or not at
all (which makes stock and sales disagree). Both corrupt the one number this app exists to
produce.

This is the same failure mode as refunds: the money side of the ledger is being forced to lie.

### Design notes for when we do it

- **`payment_method` gains `credit`.** The existing check constraint already enforces a shape
  per method, so a credit sale would carry neither `amount_tendered` nor `mpesa_code`, and would
  require a `customer_id`.
- **Credit is not cash.** Closing must show it as a third figure alongside Cash and M-Pesa, and
  it must **not** count toward expected cash in the drawer. Getting this wrong is exactly the
  ambiguity the app is built to remove.
- **A minimal customer record** — name and phone. Not loyalty, not marketing, not history
  beyond debt. The brief was right to exclude customers as a feature; it is debt that needs
  them, and only barely.
- **Repayment is its own event**, with its own date and payment method. It is cash arriving on a
  day that has no sale attached, so Closing needs a "debt repaid today" line or the drawer will
  read *over* by that amount.
- **A debtors list** — who owes what, how long it has been outstanding. That, not the sales
  screen, is the feature the owner will actually open every day.
- **Ageing matters.** "Owed 3,200" is far less useful than "owed 3,200, oldest 47 days".

### Open question — now answered

Should a credit sale reduce stock immediately? **Yes.** The goods have left the shop. Stock and
revenue therefore diverge in time, which is correct and is what the debt ledger exists to track.

### Left undone deliberately

- **Recurring / scheduled reminders.** The app has no background process and a PWA cannot
  reliably wake itself on Android. A reminder the owner believes is scheduled and which never
  fires is worse than no scheduling at all. The *Chase today* queue does the same job from the
  front: it is recomputed every time the screen opens.
- **Interest or late fees on debt.** Nothing in the research suggests dukas charge it, and
  building it would invite a practice the app should not encourage.
- **Delivery receipts for reminders.** Not knowable without a gateway. The UI says "the message
  was opened", never "delivered", because claiming more would make the log untrustworthy.

---

## 3. Shift-level cash counts

**Status:** raised by the reports research. Not agreed, not built.

`cash_counts` is currently `unique (shop_id, business_date)` — one count per shop per day. If two
attendants work a day, a variance belongs to the *day*, not to a person.

The loss-prevention research is unambiguous that per-cashier variance over weeks is what
actually catches theft, and that a single day's count proves nothing. Counting the drawer at
handover would make variance attributable — which is precisely the brief's opening problem.

The cost is a real workflow change: attendants would start and end a shift, not just close a
day. That is why it is parked rather than assumed.

Until then, the reports screen shows **sales by attendant** next to **variance by day** and is
explicit that this is weaker, circumstantial evidence.

---

## Ordering when we pick these up

Debt and refunds are now both built, so one remains.

**~~Refunds first.~~ Done.** It closes a live correctness hole: a mis-keyed sale reads as a shortfall for
ever, and the owner cannot tell that shortfall from theft — the app's central question answered
wrongly. It is also now cheaper than it was: the debt work established the pattern a refund
needs (an append-only correction that points at the original, shown as its own line at Closing
rather than netted into sales), and `debt_entries` already proves that a second money ledger can
sit alongside sales without confusing the drawer.

That prediction held, with one correction worth recording: a refund against a credit sale is
indeed not a cash movement, but it is **not** `writeoff`-shaped either. It needed its own kind,
`reversal`, because a write-off is a loss the owner absorbed and a reversal is goods coming back.
Folding them together would have inflated the bad-debt figure the Debts screen exists to keep
honest — the same class of mistake as booking a credit sale as cash, one level up.

**Shift counts** is what remains. It changes how attendants work day to day and so deserves to be
decided with a real shopkeeper in front of it.
