# Refunds — implementation plan

**Status:** decisions made, building now. Supersedes §1 of `BACKLOG.md`.

## Why this is the last real hole

An attendant will mis-key a sale. Today that sale stands for ever: it still counts toward
expected cash, so the drawer reads short by exactly the mistake — and **a shortfall the owner
cannot explain is indistinguishable from theft**, which is the single thing this app exists to
tell apart. Stock can already be corrected with an `adjustment` movement. The money cannot.

Every other ledger here is append-only and correctable. Sales are append-only and *not*
correctable, which makes them the exception that breaks the guarantee.

## The four decisions

| Question | Decision | Consequence |
|---|---|---|
| Who may refund? | **Owner only**, enforced by RLS | An attendant cannot fix their own mis-key unaided. Accepted: refunding a customer who never returned is a named theft pattern, and permission beats detection. |
| Whole sale or per line? | **Whole sale only** | Covers the common case — a sale rung up wrong is re-rung correctly straight after. Per-line can be added later without changing the data shape. |
| Refunding an M-Pesa sale? | **Cash out of the drawer**, said plainly | No Daraja by design, so the app cannot send M-Pesa. Closing lowers expected **cash**, not expected M-Pesa. |
| Refunding a credit sale? | **Reverse the debt, no cash moves** | They never paid. If they had part-paid more than they kept, the existing FIFO allocation turns the excess into credit automatically. |

## Data model

### `refunds`

One row per refunded sale. **`unique (sale_id)`** is load-bearing: it is what "whole sale only"
means in the database, and it independently blocks the double-refund vector — refunding the same
sale twice and pocketing the second. Idempotent replay still works, because replay carries the
same `id` and is absorbed by `on conflict (id) do nothing`; a *second, different* refund of the
same sale raises, which is correct and surfaces in Settings.

| column | why |
|---|---|
| `sale_id` | The sale being reversed. Never edited or deleted — a refund is a new record that points at the original. |
| `user_id` | Who authorised it. A refund flow without an attributable person is a new hole, not a fix. |
| `settled_as` | `cash` or `credit`. Where the money physically went, not how the sale was paid — an M-Pesa sale settles as `cash`. |
| `reason` | `mis_key` / `returned` / `damaged`. A reason code, not free text, so it can be counted. |
| `amount` | Denormalised from the sale so Closing never has to join to answer "what went out today". |

### Enum additions (why `0009a` is separate)

- `movement_reason` gains **`return`** — deliberately not `restock`, which would corrupt "what
  did I spend on stock this month", and not `adjustment`, which would lose the meaning.
- `debt_entry_kind` gains **`reversal`** — deliberately **not** `writeoff`. A write-off is a loss
  the owner chose to absorb; a reversal is goods coming back, which is not a loss at all.
  Conflating them would silently inflate the bad-debt figure that the Debts screen exists to
  make honest.

A new enum value cannot be used in the transaction that adds it, and `0009b`'s rewritten
`debt_entry_shape` constraint references `'reversal'`. Same a/b split as `0003` and `0007`.

## Stock

Goods coming back is a **movement**, positive delta, reason `return`. When they come back
damaged, that is *two* movements: `return +qty` then `damage −qty`.

The two-movement form is deliberate. A single no-op would record that stock did not change while
losing both facts — that goods came back, and that they were written off. The shrink report then
picks up the damage, which is where it belongs.

`mis_key` and `returned` produce `return +qty` only: in a mis-key nothing physically left the
shop, so the stock decrement was simply wrong.

## Money

```
Expected cash   = cash sales + cash repayments + cash taken at till − CASH REFUNDS
Expected M-Pesa = M-Pesa sales + M-Pesa repayments + M-Pesa at till     (refunds never touch this)
```

Closing shows refunds as **their own line, never netted into sales**. `Sales 12,400 · Refunds
−800 · Net 11,600` is the honest shape; a single `11,600` hides exactly the thing the owner most
wants to see. That is the same rule credit already follows.

## Where the UI lives

**Closing**, not the till. Two reasons: it is owner-only, and Closing is where a mis-key is
actually noticed — the drawer disagrees and the owner goes looking. Closing already has a date
picker, so refunding yesterday's sale needs no new navigation.

The refund screen asks two questions and no more: **why** (mis-key / returned / damaged) and
then confirms **where the money goes**, computed rather than chosen, so the attendant cannot
misfile which column is short.

## Order of work

1. `0009a` / `0009b`, verified against PGlite before anything is built on them
2. Types, Dexie v7, sync push/pull
3. `refundSale()` — one outbox entry carrying refund + movements + reversal
4. Closing: the day's sales, the refund flow, the refunds line
5. Reports: refunds in the period
6. Tests at every layer, then docs
