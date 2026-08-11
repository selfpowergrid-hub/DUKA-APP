# Running Duka Lite in a chemist — implementation plan

## Verdict

The money half transfers unchanged. The stock half does not, and the gap is not polish: pharmacy
stock has two properties duka stock does not, and **both are safety issues rather than
conveniences**.

1. **Every unit has a death date.** The app tracks how many you have, never which ones expire
   when. Today it would let you sell expired medicine without a murmur.
2. **Every unit came from a batch.** When a recall lands, the question is "did I sell any of
   batch XYZ" — and there is currently no way to answer it.

Everything else on the list is real but not blocking.

## Scope, as decided

| Question | Answer | Consequence |
|---|---|---|
| Controlled/scheduled drugs? | **No** — OTC and ordinary POM only | No statutory controlled-drugs register. Saves the single strictest piece of work. |
| VAT-registered / eTIMS? | **Not yet** | Stays out, as it already is. Sale records stay structured so tax lines could be added later without rework. |
| Partial packs? | **Yes, routinely** | FEFO must allocate at the *base unit* level, so 10 tablets from a strip still come from a specific batch. |

## What already transfers

Cash/M-Pesa split, Closing and drawer variance · credit and the whole debt lifecycle · refunds ·
weighted-average cost · offline-first · low-stock alerts · product photos (more useful here —
similar boxes are a dispensing hazard) · `group_name` for 250mg vs 500mg · **portions**, which
already model "10 tablets from a strip of 30" as one stock pool with named measures.

## The design

Batches fit the two patterns this codebase already proves, so nothing needs redesigning.

**Stock is already an append-only ledger with a derived answer** (`stock_movements` →
`products.quantity`). **Debt already does derived allocation** (FIFO, oldest first, computed at
read time, never stored). A batch is those two combined:

- `product_batches` — batch number and expiry. The *identity* of a delivery.
- `stock_movements.batch_id` — every movement says which batch it moved.
- Quantity per batch is **derived** by summing that batch's movements, exactly as total quantity
  already is. No new source of truth, nothing that can desync.
- Dispensing allocates **FEFO** — first-expiry-first-out — which is `allocate()` from `debt.ts`
  with the sort key changed from oldest-charge to nearest-expiry.

A sale already sends an array of movements to `sync_sale`, so a sale spanning two batches is
simply two movements. The server needs no new transaction shape.

### Opt-in per product

`products.track_batches`. A chemist also sells cotton wool and soap, and forcing a batch number on
those would train staff to type rubbish into the field that matters. When it is on, restock and
opening stock **require** a batch number and expiry date.

### Partial packs

A portion consumes `factor` of the base unit, and `sale_items.base_quantity` already records how
much base stock left. FEFO allocates against base quantity, so ten tablets from a strip of thirty
still resolve to a specific batch with a specific expiry. This falls out of the existing model
rather than needing new machinery.

### Expired stock

Never silently dispensed. FEFO skips expired batches, and selling from one requires an explicit
override that is recorded — because "we knowingly sold it" and "the system let us" are different
facts, and only one of them is defensible.

## Order of work

1. **Batches, expiry, FEFO dispensing** — the foundation. Comparable in size to the debt lifecycle.
2. **Expiry alerts** — "expiring within 90 days" on Products and Reports; a hard guard on expired
   stock at the till. Small once 1 exists.
3. **Batch traceability** — given a batch number, which sales touched it. Small; the join already
   exists once `batch_id` is on movements.
4. **POM flag and dispensing record** — prescriber, patient, prescription reference, captured at
   the till for products flagged prescription-only.

Deliberately excluded, and why: **controlled-drugs register** (not stocked), **eTIMS/VAT** (below
threshold, and an external integration that deserves its own project), **patient clinical
records** (that is a different system with different obligations, not a POS feature).

## A caveat worth keeping in the file

The regulatory shape here — PPB registration, POM record-keeping, recall handling — is described
from general knowledge, not from the current statute. Anything that has to satisfy an inspector
should be confirmed with the superintendent pharmacist before it is relied on. The software design
above is sound regardless of the regulatory detail; what may change is which fields are mandatory.
