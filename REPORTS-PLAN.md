# Reports — research findings and implementation plan

Status: **plan only, nothing built.** Decisions at §7.

---

## 1. What the research actually says

I looked at what POS vendors and independent-retail operators recommend, rather than what is
easy to build. Two findings dominate.

### 1.1 The list is short, and everyone agrees on it

Across vendor guidance the same five or six reports appear, with a clear cadence:

| Report | Question it answers | Cadence |
|---|---|---|
| End-of-day reconciliation (Z-report) | Did the drawer match the sales? | **Daily** |
| Sales summary vs the same day last week | Was today normal? | **Daily**, 5 minutes |
| Top sellers / slow movers | What deserves shelf space? | **Weekly** |
| Cash variance by person | Who is short, and is it a pattern? | **Weekly**, compiled from daily |
| Inventory shrink | What left without being sold? | **Weekly** |
| Gross margin | What actually makes money? | **Monthly** |

Two pieces of operator guidance are worth repeating verbatim, because they shape the design more
than the list does:

> "Run one Z per day at the same time so your daily numbers stay comparable — the enemy of clean
> reporting is a close that happens whenever we remember."

> "Reports nobody owns are reports nobody reads."

That second one is why I am **not** proposing a reports menu with twelve entries. A duka owner
will not read twelve reports. The recommended rhythm is 5 minutes daily, 30 minutes weekly,
1 hour monthly — so the design should be **one screen with three periods**, showing the same
blocks at each, not a library.

### 1.2 Cash variance by person is the report this app is actually for

The brief's opening problem is: *"the owner cannot tell whether a shortfall is a keying error or
an attendant who pocketed cash."* The research is unambiguous that a **single day's variance
tells you nothing** — it is the pattern that convicts:

> "Cashier-level variance tracking is the most effective accountability tool available to a
> small store… over weeks, a pattern involving one specific employee becomes statistically
> obvious in a way that a single cash count never could."

With published thresholds: under ~KES 500 is rounding, recurring KES 1,500–5,000 warrants
investigation, and a small consistent daily shortfall compounds to roughly **KES 500,000 a
year** at duka scale.

**This is the single most valuable report I can add**, and Closing already collects the raw
material daily. It is also where the current data model falls down — see §2.3.

---

## 2. What this app can answer today, and three things it cannot

I checked the schema rather than assuming.

**Answerable now, with no schema change:** daily/weekly/monthly sales totals, the cash vs M-Pesa
split, transaction counts, average basket, top and slow movers by quantity and by value, sales
by attendant (`sales.user_id` is there), stock on hand and its value at *current* cost, low
stock, and every stock movement broken down by reason — restock, damage, loss, recount.

Three gaps, each with a real consequence:

### 2.1 Profit is approximate, and cannot be made accurate retrospectively

```sql
create table public.sale_items (
  ...
  unit_price   numeric(12,2),   -- what the customer paid
  quantity     numeric(12,3),
  line_total   numeric(12,2)
  -- there is no unit_cost
);
```

`sale_items` never records what the goods **cost** at the moment they were sold. Any margin
report has to use the product's *current* buying price — so the day you restock unga at a higher
price, every unga sale you ever made silently re-values, and last month's profit changes.

The fix is one column populated at checkout. **It cannot be backfilled** — the cost at the
moment of each past sale is genuinely gone. So margin reporting is exact from the day this ships
and approximate before it, and the screen should say so rather than quietly present a number
that moves.

### 2.2 The device only holds 14 days

```
src/lib/sync.ts:247   const since = new Date(Date.now() - 14 * 86_400_000)
```

Monthly reporting needs 31 days; month-vs-last-month needs ~62. Everything in this app is
computed from IndexedDB so it works with the radio off, and I want reports to keep that
property rather than becoming the one screen that needs signal.

At duka scale — say 100 sales a day — 62 days is roughly 6,000 sales and 19,000 line items,
about 3 MB. That is nothing for IndexedDB. **Extending the window is the right answer**; a
server-side aggregation RPC would be faster to query but would make reports the only screen
that fails offline.

### 2.3 Cash variance cannot be attributed to a person

```sql
create table public.cash_counts (
  ...
  unique (shop_id, business_date)   -- ONE row per shop per day
);
```

One count per shop per day. If two attendants work a day, the variance belongs to the day, not
to either of them — and §1.2 says per-person patterns are the whole point. The app knows who
rang up every sale, but not who was responsible for the drawer when it came up short.

This is a genuine design limitation, not a missing query, and fixing it means **shift counts**:
count the drawer at handover, not only at closing. That is a real feature with real UI, so it is
a decision for you (§7.1), not something I should slip in.

What I *can* do without it, and would do regardless: **sales by attendant** (who rang up what,
and what share was cash) plus **variance by day**. If one attendant works most of the short
days, that is visible even without shift counts — it is weaker evidence, and the screen should
be honest that it is weaker.

---

## 3. What I propose to build

**One screen, `/reports`, with a Day / Week / Month switch.** Same blocks throughout, so the
owner learns one layout. Every figure computed from IndexedDB, so it works offline like
everything else.

### Blocks, and which periods show them

| Block | Day | Week | Month | What it shows |
|---|:--:|:--:|:--:|---|
| **Sales** | ● | ● | ● | Cash / M-Pesa / Total, transactions, average sale. Always split — never one blended figure. |
| **Compared with** | ● | ● | ● | Same day last week / previous week / previous month, with the difference. Research calls this the daily 5-minute check. |
| **Cash variance** | ● | ● | ● | Expected vs counted per day, and the running total. Green at zero, claret when short. The report this app exists for. |
| **By attendant** | ● | ● | ● | Sales rung up per person, and their cash share. |
| **Top sellers** | | ● | ● | By value and by quantity, top 10. |
| **Slow movers** | | ● | ● | Active stock with no sale in the period — the money sitting on the shelf. |
| **Gross margin** | | ● | ● | Revenue − cost, per product and overall. Flagged as approximate for sales before the cost column ships. |
| **Stock movement** | | ● | ● | Restocked / damaged / lost / recounted, valued. This is the shrink report. |
| **Stock value** | | | ● | What is on the shelf at buying price, and at selling price. |

Each period is shareable as plain text through the same Web Share path Closing already uses, so
it reaches WhatsApp — which is how a Kenyan shop owner actually reads anything.

### Deliberately not included

- **Charts.** The brief lists *charts and dashboards* as out of scope, and I am not overriding
  that on my own initiative. Everything above is figures and tables. If you want a simple
  7-day or 30-day bar row for the sales trend, say so — it is small, and it is the one place a
  picture genuinely beats a column of numbers. See §7.2.
- **Customer / basket analysis.** Needs customers, which are explicitly out of scope.
- **Void and refund exception reports.** These rank high in the research, but this app has no
  voids or refunds by design, so there is nothing to report on. Worth knowing that a whole
  category of loss-prevention reporting is unavailable *because* returns are out of scope.
- **Peak-hour analysis.** Cheap to compute and mildly interesting, but a duka owner already
  knows when their shop is busy. Skipping unless you want it.

---

## 4. Schema changes

Small.

```sql
-- 0005_reporting.sql

-- Cost at the moment of sale. Without it, restocking silently rewrites history.
alter table public.sale_items
  add column if not exists unit_cost numeric(12,2) check (unit_cost is null or unit_cost >= 0);

-- Reporting reads the whole period at once; these are the shapes it asks for.
create index if not exists sales_shop_user_date_idx
  on public.sales (shop_id, user_id, business_date);
create index if not exists movements_shop_reason_idx
  on public.stock_movements (shop_id, reason, created_at);
```

`unit_cost` is filled at checkout from the product's buying price and passed through
`sync_sale`. Null means "sold before this shipped" and the margin block says so explicitly
rather than treating null as zero cost — which would report a 100% margin and be worse than
useless.

**If you choose shift counts (§7.1)**, `cash_counts` also loses its
`unique (shop_id, business_date)` and gains a `shift_label` and a `closed_at`, with the
uniqueness moving to `(shop_id, business_date, shift_label)`. That is a bigger change and it
touches Closing, which is why it is a separate decision.

---

## 5. Sync change

Extend the pull window from 14 to 62 days, so month-vs-previous-month works offline. One
constant, plus pulling `sale_items` for the whole window rather than only recent sales.

Worth stating plainly: this makes the **first** sync after login heavier — a few thousand rows
instead of a few hundred. On 3G that is seconds, not minutes, and it happens once. Every later
sync is incremental. Reports beyond 62 days would need connectivity; I would rather cap the
window honestly than have the screen quietly show a wrong total for "last month".

---

## 6. Tests

- **Schema** — `unit_cost` survives a `sync_sale` replay without doubling; a null cost is
  reported as unknown rather than as zero.
- **Offline** — a fixed set of sales across three days produces exactly the expected totals,
  splits, per-attendant breakdown and top-seller order; a period with no sales reads zero
  everywhere rather than erroring; variance sums correctly across days including a day with no
  count at all.
- **The one that matters** — margin must never silently treat an unknown cost as zero profit or
  as 100% profit. That is the failure mode that would make an owner price something wrongly.
- **Responsive** — `/reports` at all three widths, which the existing suite picks up
  automatically once the route exists.

---

## 7. Decisions I need

### 7.1 Shift counts — the one real fork

- **A — Keep one count per day.** Simpler, no change to Closing. Variance is attributed to the
  *day*, and per-attendant evidence stays circumstantial. *Recommended if one person runs the
  till most days.*
- **B — Add shift counts.** Count the drawer at handover. Variance attaches to a person and a
  period, which is what the research says actually catches theft. Costs a change to Closing and
  a new "start/end shift" step for attendants — a real workflow change, not just a screen.

Given the brief's opening sentence is about telling keying errors apart from pocketed cash, **B
is the one that fulfils the original intent.** But it adds a daily ritual for the attendant, and
that is your call, not mine.

### 7.2 One chart, or none?

The brief forbids charts. A single bar row showing 7 or 30 days of sales is the one place a
picture beats numbers. **None** keeps the brief intact; **one** is genuinely useful. I will not
add it unprompted.

### 7.3 Scope of the first cut

- **A — Daily + Weekly + Monthly, all blocks.** As tabled in §3.
- **B — Start with Weekly.** The research calls it the highest-value cadence, and Closing
  already covers the daily need. Half the work; the other periods slot into the same screen
  later. *Recommended if you want it in front of a real shopkeeper sooner.*

---

## Sources

- [Markt POS — 5 essential POS reports for small market owners](https://www.marktpos.com/guide-essential-pos-reports-for-grocers)
- [NRS — 7 back-office reports every independent retailer should pull weekly](https://nrsplus.com/blog/7-back-office-reports/)
- [NRS — Cash drawer reconciliation and shrinkage prevention](https://nrsplus.com/blog/cash-drawer-reconciliation/)
- [NRS — Shift reconciliation from the back office](https://nrsplus.com/blog/shift-reconciliation-from-the-back-office/)
- [Posterita — Understanding the Z-report](https://www.posterita.com/blog/z-report-pos-end-of-day)
- [KORONA POS — Retail daily sales report template](https://koronapos.com/blog/retail-daily-sales-report-template/)
- [Business.com — Best POS reports for retail](https://www.business.com/articles/best-pos-reports-for-retail/)
- [Shopify — Types of shrinkage in retail](https://www.shopify.com/blog/retail-shrinkage)
- [Appriss Retail — Register discrepancies: causes and prevention](https://apprissretail.com/blog/getting-to-the-bottom-of-register-discrepancies/)
