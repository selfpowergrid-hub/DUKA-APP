# Debt lifecycle — implementation plan

Plan only. Nothing built yet.

Covers: part-payment at the till, the full chase-to-settlement lifecycle, and a hard guarantee
that no record is lost on the way.

---

## 0. What already exists

Worth stating plainly so this plan is about the gaps, not a rebuild. Shipped and tested:

| Requirement you listed | Status |
|---|---|
| Record a debt at the moment of payment, when it is neither cash nor M-Pesa | **Built** — "On credit (deni)" is the third button on the payment step |
| Select the debtor from a list | **Built** — searchable by name or phone, showing what each already owes |
| Register a customer if they are not on the list | **Built** — inline, without leaving the sale |
| Partial repayment of a debt, any amount, any number of times | **Built** — cash or M-Pesa, with "leaves X owing" |
| Ageing, so you know who is overdue | **Built** — 0–7 / 8–30 / 31–60 / 60+, sorted by age |
| Write-offs | **Built** — owner-only, kept visibly in the ledger |

**Three real gaps**, which is what the rest of this document is:

1. **Part-payment at the till** — "pay 200 now, owe 300". Not possible today.
2. **Reminding people** — no mechanism of any kind exists. This is the biggest gap.
3. **Records can be lost.** There is one path that destroys a record permanently, and I built
   it. See §3.

## 0.1 Decisions taken

- Part-payment: **one tap for the attendant, two events in the ledger.**
- Reminders: **WhatsApp and SMS opened from the phone**, every send logged. No gateway, no
  credentials, no per-message cost.
- Credit-giving: **any attendant.** Limits warn; they do not block.

---

# 1. Part-payment at the till

## 1.1 The flow

On the credit step, one optional field: *"Paying something now?"* with the cash / M-Pesa toggle
already used elsewhere.

```
Sale total            KES 500
Paying now            KES 200   [Cash] [M-Pesa]
─────────────────────────────
Wanjiku will owe      KES 300
(she already owes 1,000 → 1,300 after this)
```

The attendant does one thing. The ledger records two, because they are genuinely two facts:
goods worth 500 left the shop on credit, and 200 came back immediately.

Guard rails:
- Paying **the full amount** is not a credit sale at all — the screen should say so and send
  them to the ordinary Cash/M-Pesa button rather than writing a debt that settles itself.
- Paying **more than the total** is refused here. Overpayment is meaningful against an existing
  balance, but as change due at the till it is a typo.

## 1.2 Why it is two events, not two columns

The obvious alternative is `sales.amount_paid_now` + `paid_now_method`, which means rewriting
`sales_payment_shape` — the constraint that currently guarantees a cash sale is a cash sale, and
the single most load-bearing check in the schema. That buys no capability the ledger does not
already give, and it puts the app's central money guarantee back on the table.

Recording a charge and a payment instead reuses paths that are already proven: allocation, ageing,
Closing arithmetic and the idempotency guarantees all work unchanged, because to them this is
simply a customer who paid promptly.

## 1.3 The one schema change it does need

Both events must reach the server **in the same transaction as the sale**. A payment that lands
while its charge does not would show the customer in credit, and the reverse would overstate the
debt — briefly, but visibly, and on the screen the shop trusts.

`sync_sale` already writes the charge atomically. It gains an optional immediate payment
alongside it, in the same transaction, in the same single outbox entry.

One constraint relaxation is worth making at the same time:

```sql
-- A payment may now carry the sale it was made against.
-- Not required — a later repayment still has sale_id null.
(kind = 'payment' and payment_method is not null and ...)   -- sale_id no longer forced null
```

Without this, Closing cannot tell *"paid at the till"* apart from *"old debt repaid today"*.
Both raise expected cash identically, so the money is right either way — but filing today's
part-payment under "old debt repaid" is a small lie on the one screen that exists to stop
small lies. It also makes a part-payment traceable back to the sale it belongs to.

---

# 2. The chase: reminders and follow-up

Nothing here exists today. This is the "managed all the way" half of your request.

## 2.1 The lifecycle, and where the app is currently silent

```
credit given ──▶ ageing ──▶ ?????? ──▶ repayment ──▶ settled
     ✅            ✅         GAP          ✅           ✅
                             │
                    remind · promise · chase · escalate
```

The app can currently tell an owner *who* to chase and *how overdue* they are, and can record
money when it arrives. Everything between those two points is unassisted.

## 2.2 Reminders: deep links, not a gateway

Tapping **Remind** on a debtor offers WhatsApp, SMS, or Call. The message is pre-filled with the
shop name, the amount, and how long it has been outstanding:

> Habari Wanjiku, hii ni Duka ya Wilson. Deni yako ni KES 1,000 tangu 15 Juni. Asante.

*(Message text is a template the owner can edit; the default is bilingual-friendly because a
debt reminder is the one message where tone decides whether you keep the customer.)*

Why deep links rather than an SMS gateway:

- **Free.** A gateway costs roughly KES 1 per message. A shop with forty debtors chased weekly is
  paying real money to ask for money.
- **No credentials, no server job, no delivery-status handling.** The scope difference is large.
- **WhatsApp is where the conversation already is**, and it shows whether the message was read.
- It works from the phone that is already in the owner's hand.

The cost is that reminders are manual. Given a shop with tens of debtors rather than thousands,
that is the right trade — and the automation this replaces is the part most likely to be turned
off after the first month of charges.

## 2.3 Logging is what makes it *management*

An unrecorded reminder is a conversation nobody can refer back to. *"I told you last week"* is
only useful if it is true and checkable.

Every reminder writes an append-only row: who, when, which channel, and **what the balance was at
the time**. That last field matters — it is how you later see that someone was reminded at 1,000
and is now at 1,800.

## 2.4 Promise to pay

The single highest-value addition, and cheap: when someone says *"nitalipa Ijumaa"*, record it.

That turns the debtors list from a static ranking into a **work queue**:

```
Chase today
  Otieno        KES 450    promised Friday — 3 days ago       ← broken promise
  Mama Njoki    KES 1,500  never reminded, 34 days old
  Wanjiku       KES 1,000  reminded Tuesday, no promise
Later
  …
```

A broken promise is a far stronger signal than age alone, and it is the moment a shopkeeper
should stop extending more credit. Sorting by it puts the right name at the top of the list.

## 2.5 A statement the customer can see

One button: share this customer's ledger as plain text over WhatsApp. Most disputes about a duka
debt are disputes about the *amount*, and a paper book cannot be shared. This is nearly free
given the ledger already exists, and it is the honest counterpart to chasing someone: they can
check the figure.

---

# 3. Nothing lost on the way

You asked for this explicitly, so I audited it rather than asserting it. Four paths can lose a
record today. One of them is a hole I introduced.

## 3.1 `Discard` permanently destroys a record — the real hole

```ts
export async function discardOutboxEntry(seq: number): Promise<void> {
  await db.outbox.delete(seq);      // gone. no archive, no undo.
}
```

I added this so a shop could clear a permanently-rejected item (a duplicate name, a write RLS
refused) instead of being stuck forever. But it does not distinguish a rejected *category* from
a rejected *credit sale*. Discarding the latter means the sale and the debt exist on that one
phone and **will never reach the server** — on the owner's device, the debt simply does not
exist. That is exactly the failure you are asking to rule out.

**Fix, in three parts:**

1. **Archive, never delete.** Discarded entries move to a local `discarded_entries` store with
   the reason and timestamp. They remain viewable and **re-queueable** once the underlying
   problem (a renamed product, a promoted user) is fixed.
2. **Money-bearing kinds cannot be discarded casually.** For `sale` and `debt_entry`, discarding
   requires an explicit confirmation naming the amount — "this removes a KES 500 sale from the
   shop's records" — rather than a single tap.
3. **Nothing is discardable before it has been exported.** See 3.3.

## 3.2 Pruning is safe for debt, but breaks one link

`pruneOldLocalData()` deletes local `sales`, `sale_items`, `stock_movements` and `cash_counts`
older than 69 days. It correctly **never touches `debt_entries` or `customers`** — a debt older
than 69 days is exactly the debt that matters most, and the ledger is retained in full.

One consequence to accept knowingly: a charge older than the window keeps its amount and date
(both stored on the entry) but its `sale_id` points at a sale this device no longer holds. The
balance is unaffected. Only "show me the original sale" degrades, and only offline — the server
still has it. The customer statement should therefore be built from the ledger, not by joining
back to sales.

## 3.3 A phone that dies takes unsynced records with it

Inherent to offline-first, and unfixable in general — but the exposure can be made visible and
recoverable:

- **Show unsynced money, loudly.** The debtors list and Closing should say *"3 records on this
  device have not reached the server"* rather than leaving it to the small sync pill.
- **An export escape hatch.** One button that shares every unsynced record as plain text over
  WhatsApp — to the owner's own number if they like. It is ugly, and it means a broken phone
  costs an afternoon of retyping instead of losing the debts entirely.
- Sign-out already refuses while anything is queued. That stays.

## 3.4 What the guarantee actually becomes

Worth being precise, because "no record is ever lost" is not something any offline-first app can
honestly promise:

> Once a record reaches the server it is permanent — the ledger is append-only, with no UPDATE
> or DELETE policy on any money table. Before it reaches the server it lives in one device's
> IndexedDB, and it can only leave that device by syncing. It is never deleted by pruning, never
> deleted by sign-out, and never silently deleted by Discard.

That is a guarantee I can actually enforce and test, which the current code cannot.

---

# 4. Schema

```sql
-- 0008_debt_lifecycle.sql

-- A payment may now name the sale it was made against, so a part-payment at
-- the till is distinguishable from a later repayment. Still optional.
alter table public.debt_entries drop constraint if exists debt_entry_shape;
alter table public.debt_entries add constraint debt_entry_shape check (
  (kind = 'charge'   and sale_id is not null and payment_method is null and mpesa_code is null)
  or
  (kind = 'payment'  and payment_method is not null
                     and payment_method in ('cash','mpesa')
                     and (payment_method = 'cash' or mpesa_code is not null))
  or
  (kind = 'writeoff' and sale_id is null and payment_method is null and mpesa_code is null)
);

-- The chase. Append-only, like every other ledger here.
create table public.debt_reminders (
  id               uuid primary key,
  shop_id          uuid not null references public.shops,
  customer_id      uuid not null references public.customers,
  user_id          uuid not null references public.users,
  channel          text not null check (channel in ('whatsapp','sms','call','in_person')),
  -- What they owed when reminded. Without it you cannot later see that someone
  -- was chased at 1,000 and has since grown to 1,800.
  balance_at_time  numeric(12,2) not null check (balance_at_time >= 0),
  promised_date    date,          -- "nitalipa Ijumaa"
  note             text,
  created_at       timestamptz not null,
  synced_at        timestamptz not null default now()
);
-- select/insert for the shop; no update, no delete.
```

`sync_sale` gains an optional `immediate_payment` written in the same transaction.
`sync_debt_reminder` mirrors `sync_debt_entry`. Locally, Dexie v6 adds `debt_reminders` and
`discarded_entries`.

**No new enum values**, so this is a single migration file rather than the split `a`/`b` pair.

---

# 5. Screens

| Screen | Change |
|---|---|
| **Sell → credit** | Optional "paying now" amount + cash/M-Pesa toggle, with a live "will owe" figure. Full payment steers to the ordinary buttons. |
| **Debts** | Split into **Chase today** and **Later**. Broken promises first, then never-reminded old debt, then by age. Unsynced-record banner. |
| **Customer** | Remind button (WhatsApp / SMS / Call), promise-to-pay capture, reminder history beside the money ledger, and share-statement. |
| **Closing** | Distinguish "paid at the till" from "old debt repaid". Both already count correctly toward expected cash. |
| **Settings** | Editable reminder message template. Discarded-items archive with re-queue. |
| **Reports** | Reminders sent, promises made, promises kept — the only honest measure of whether chasing works. |

---

# 6. Tests

The three that matter most, each reproducing a specific way this could go wrong:

- **Part-payment arithmetic.** A 500 sale with 200 paid leaves exactly 300 owing; expected cash
  rises by exactly 200; total sales counts 500 once. Replaying the sync writes one charge and
  one payment, never two.
- **Nothing lost.** Discarding a credit sale archives rather than deletes it and it remains
  re-queueable; pruning never removes a debt entry; sign-out stays blocked while anything is
  queued; a ledger with charges older than the prune window still computes the right balance.
- **Chase ordering.** A broken promise outranks an older debt with no promise. A reminder logs
  the balance at the time, and a later reminder shows the growth.

Plus the standing suites: responsive coverage of the new screens, and the existing money rules,
which must not move.

---

# 7. Order of work

1. **Discard archive + the "nothing lost" guarantees** (§3). It is a live hole, it is small, and
   everything after this adds more records worth not losing.
2. **Part-payment at the till** (§1). Smallest of the features; one constraint relaxation and one
   optional field.
3. **Reminders and promise-to-pay** (§2). The largest piece and the biggest behaviour change.
4. **Statement sharing and the reports block.** Cheap once the ledger work above is done.

Steps 1 and 2 are roughly a day between them. Step 3 is the substantial one.

---

## Open question I did not want to assume

**Should the reminder message be in Swahili, English, or both?** You asked for English-only in
the interface, and I have kept that everywhere. But a debt reminder is not interface text — it is
a message from a shopkeeper to a neighbour, and the register is different. My instinct is a
Swahili-leaning default that the owner can edit, with the template stored per shop. Say the word
and I will make it plain English instead.
