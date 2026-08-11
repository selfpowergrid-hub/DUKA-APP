# Duka Lite

A simple, offline-first Point of Sale for small retail shops in Kenya.

It exists to answer one question: **at any moment, how much should be in cash and how much
should be in M-Pesa?** Every screen serves that. Cash and M-Pesa are never blended into a
single figure without also showing the split.

Built for cheap Android phones on unreliable 3G. All reads come from IndexedDB, all writes go
to IndexedDB first, and nothing in the checkout path ever waits for the network.

---

## Setup

### 1. Supabase

Create a project at [supabase.com](https://supabase.com), then in **SQL Editor** run, in order:

1. `supabase/migrations/0001_init.sql` — schema, constraints, triggers, RLS, sync RPCs
2. `supabase/migrations/0002_fix_owner_guard.sql` — owner-check fix
3. `supabase/migrations/0003a_stock_intake_enums.sql` — new movement reasons
4. `supabase/migrations/0003b_stock_intake.sql` — categories, stock intake, `sync_new_product`
5. `supabase/migrations/0004_units_groups_portions.sql` — shop-defined units, pack groups, measured selling
6. `supabase/migrations/0005_reporting.sql` — cost at time of sale, reporting indexes
7. `supabase/migrations/0006_weighted_average_cost.sql` — moving weighted-average cost
8. `supabase/migrations/0007a_credit_enum.sql` — the `credit` payment method
9. `supabase/migrations/0007b_customer_debt.sql` — customers and the debt ledger
10. `supabase/migrations/0008_debt_lifecycle.sql` — part-payment at the till, reminders, promises
11. `supabase/migrations/0009a_refund_enums.sql` — `return` movement, `reversal` debt entry
12. `supabase/migrations/0009b_refunds.sql` — refunds, owner-only, `sync_refund`
13. `supabase/migrations/0010_optional_mpesa_code.sql` — the M-Pesa code becomes optional
14. `supabase/migrations/0011_product_images.sql` — product photos
15. `supabase/migrations/0012_batches_and_expiry.sql` — batches, expiry dates, FEFO dispensing
10. `supabase/seed.sql` — 20 realistic duka products with opening stock

**0003a/0003b, 0007a/0007b and 0009a/0009b must each be run as two separate statements**, not pasted
together: a new enum value cannot be used in the transaction that adds it, and the `b` file's
check constraint references the values the `a` file creates. Every file is safe to re-run.

In **Authentication → Providers → Email**, turn *Confirm email* **off** for testing (otherwise
you must click a confirmation link before the first sign-in).

With the Supabase CLI instead:

```bash
supabase start      # needs Docker
supabase db reset   # runs the migration, then the seed
```

### 2. The app

```bash
cp .env.example .env.local     # fill in URL + anon key from Supabase → Settings → API
npm install
npm run dev
```

Open http://localhost:3000, create the owner account at `/signup`, then run `supabase/seed.sql`
again so the products attach to your new shop.

### 3. Deploy

Push to a Git repo, import it on Vercel, and set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Nothing else is needed — there is no server-side secret.

The service worker only registers in a production build, so test offline behaviour against
`npm run build && npm start`, not `npm run dev`.

**Do not rebuild while a device has the app open.** A running page is using the previous
build, and `next build` deletes its route chunks — clicking through to a screen it has not
loaded yet then fails. The app now detects that and reloads itself once (see below), but a
build under a live till is still worth avoiding.

### Surviving a deploy

Two things make a new deploy safe for a shop that is mid-shift:

- `scripts/build-sw.mjs` stamps a fresh version into the service worker before every build.
  This is load-bearing: the SW deletes caches that do not match its version, and with the
  version hardcoded it deleted nothing — the previous build's app-shell HTML stayed cached for
  ever, and since navigations are network-first with a 3s timeout, a shop on a slow connection
  would be served that stale HTML pointing at chunks the server no longer has.
- An inline script in `app/layout.tsx` catches load failures and reloads once, clearing caches
  first. It is **inline, not a React component**, deliberately: a failed chunk stops React
  hydrating, so a recovery written as an effect is disabled by the very fault it exists to
  handle. It listens two ways, because the failures look different:
  - **thrown** errors and rejections, for JS chunks that fail to import;
  - **resource** errors in the capture phase, for a stylesheet or script that 404s. These throw
    nothing at all — a missing stylesheet renders the app as fully-working unstyled HTML with
    no error anywhere to react to, which is the nastiest version of this bug.

  The script contains **no regular expressions**, on purpose: it lives inside a JS template
  literal, which silently eats backslashes. An escaped `\.css` once became `.css(?|$)` — an
  invalid group — and the resulting SyntaxError killed the entire recovery script rather than
  just that one check. Plain string methods cannot fail that way.

  `npm run test:responsive` asserts it recovers from a thrown chunk error AND from a missing
  stylesheet, never loops, and ignores unrelated resource failures such as a broken image. That
  last assertion also guards the script as a whole: if it ever fails to parse, every one of
  those trials fails at once.

---

## Deploying

**Zero configuration.** The app is at the repository root, so Vercel (or anything else) detects
Next.js on its own and builds it. Import the repo, press Deploy, done — no Root Directory to set,
nothing to remember.

That layout is deliberate and worth not undoing. The app used to live in a `duka-lite/`
subdirectory with the planning documents at the root, and it cost four failed deployments to
learn why that is a trap:

- Vercel builds from the repository root by default. Finding no `package.json` there, it builds
  nothing and deploys an empty site — then reports **success** and serves `404: NOT_FOUND`. A
  failed build would have been far easier to diagnose than a successful one serving nothing.
- A root `vercel.json` cannot fix it. `buildCommand` and `installCommand` happily point into a
  subdirectory — the install runs, packages resolve, the log looks healthy — and then the build
  dies on `No Next.js version detected`, because Vercel's Next.js builder reads `package.json`
  **from the Root Directory** to identify the framework, and does that *before* the build command
  runs. `framework: "nextjs"` does not substitute for it.
- The Root Directory **setting** does work, but it lives on the Vercel project, not in the repo.
  Every fresh import silently resets it, and the resulting 404 looks identical each time with no
  hint that a dropdown is involved.

The planning documents now live in [`docs/`](docs/).

## Checking the database is up to date

Migrations here are pasted by hand, so there is no bookkeeping table to trust. Run
`supabase/check_migrations.sql` in the SQL editor: it reports one row per migration by looking
for the **artefact** that migration creates, so it tells the truth about a database whose
history nobody recorded. Read-only.

`npm run test:migration-check` proves that file discriminates — every row is tested against a
database that genuinely lacks that migration, not only against a fully migrated one. A checker
that reports `ok` for a migration the database never had is worse than no checker, because it
sends the owner away confident while the app writes to tables that do not exist.

Two things that are already handled and should not be re-solved:

- **The service worker.** `public/sw.js` is generated by `scripts/build-sw.mjs` and is
  deliberately not committed, because it carries a per-build version stamp. It is generated by
  the `build` script *before* `next build`, so it is in `public/` when Next packages it. A
  postbuild step would be missed.
- **Environment variables.** `.env.local` is committed (see the note in that file), and Next.js
  loads it during `next build`, so a deployment works without configuring anything. Both values
  are `NEXT_PUBLIC_` and are inlined into the browser bundle at build time — meaning **a changed
  key needs a rebuild, not just a restart**. If you later stop committing that file, set the two
  variables in the host's project settings instead.

Every route prerenders as static; the app talks to Supabase from the browser, so there is no
server-side runtime to configure.

---

## Verifying it works

```bash
npm run verify     # lint + typecheck + both test suites + production build
```

`npm run test:schema` runs the **real migration** against a real Postgres (PGlite/WASM) and
asserts the guarantees the money depends on — including replaying `sync_sale` five times and
proving stock only moves once. `npm run test:offline` runs the **real Dexie layer** against an
in-memory IndexedDB with no network at all, which is exactly the aeroplane-mode state.

Currently 96 schema checks, 160 offline checks and 32 colour checks, all passing. Checkout
measures ~3ms against a 1000ms budget.

```bash
npm run build && npm start -- -p 3100   # in one terminal
npm run test:responsive                 # in another
```

`test:responsive` drives a real browser at 390px, 820px and 1440px across eleven screens and
fails on horizontal overflow, any interactive element under 44px, or an uncaught error. It
leaves screenshots in `test/screenshots/`. It is not part of `npm run verify` because it needs
a server already running.

---

## Customer debt

Around 90% of Kenyan dukas sell on credit, and FinAccess puts the default rate on shopkeeper
goods-and-services credit at roughly **45%** — worse than digital loan apps (18%), mobile banks
(13%), family (9%) or banks (2%). It is the largest source of credit in the country and it is
tracked in a paper book that gets lost. So this is built as a **loss-prevention** feature, not a
bookkeeping one: it leads with exposure and ages every debt.

**The money rule outranks everything.** Credit is not a third place money lives:

```
Expected cash    = cash sales    + cash repayments + cash taken at the till on credit
Expected M-Pesa  = M-Pesa sales  + M-Pesa repayments + M-Pesa taken at the till on credit
Credit sales     = shown separately, counted in total sales, NOT money
```

A credit sale booked as cash makes the drawer read short — indistinguishable from theft, the
exact ambiguity this app exists to remove. A repayment left out makes it read over. Both
directions are asserted in `test:offline`, including that an M-Pesa repayment raises expected
M-Pesa and leaves expected cash untouched, and that its code appears in the Safaricom tick-off
list — an M-Pesa payment the owner cannot find looks like one that was never recorded.

**Allocation is derived, never stored.** `debt_entries` is an append-only ledger of charges,
payments and write-offs; payments are applied to charges **FIFO, oldest first**, computed at
read time. This is the same shape `stock_movements` uses for stock — an event log plus a
computed answer — and it buys three things at once: the interface stays balance-forward (one
number per customer, no manual allocation), ageing stays exact (which charges are still open and
how old), and it is idempotent and offline-convergent for free, because a pure function of an
ordered event list has no state that can desync. Ordering is `created_at` then `id`, so two
devices reach the same answer once synced.

**Ageing buckets are tuned for a duka**, not the standard 30/60/90. Credit here is extended
against a payday or the end of the week, so a debt surviving 30 days is already in trouble:
0–7 normal, 8–30 watch, 31–60 chase, 60+ at risk. Each bucket names a different action; buckets
that do not change what the owner does are decoration. The debtors list sorts by **age, not
amount** — age predicts default far better than size.

Credit limits are a **warning, never a block**. Two devices can each approve credit that
combined breaches a limit and neither can see the other — the same race as overselling. Refusing
a sale on a stale local balance would deny legitimate credit to someone who settled up on the
other till an hour ago, which is worse than the overshoot.

A credit sale is two rows — the sale and its charge — and they ride in **one outbox entry and
one server transaction**, for the same reason opening stock and portions do: a charge pushed
before its sale exists is a foreign-key violation the sync engine parks permanently, which would
be money owed to the shop stranded on one phone.

### Part-payment at the till

"Pay 200 now, owe 300" is the most common real transaction after plain cash. Without it the
attendant either books the whole 500 as debt — and the drawer reads 200 OVER — or takes the 200
off the books entirely. Either way the one screen that exists to remove ambiguity introduces it.

One optional field on the credit step produces **three rows in one transaction**: the sale, its
charge, and a payment. `debt_entries.sale_id` is now allowed on a payment, which is what lets
Closing distinguish *paid at the counter* from *old debt repaid today*. Both raise expected cash
identically — the money was never wrong either way — but filing a payment made thirty seconds
ago under "old debt repaid" is a small lie on the one screen whose whole job is to stop small
lies. A part-payment covering the entire sale is refused: that is a cash sale, and the UI says
so rather than writing a debt that settles itself.

### The chase

A list of everyone who owes you is not a work queue. Thirty names sorted by age tells the owner
nothing about which three to deal with before the shop gets busy, so they deal with none — which
is how a 45% default rate happens. Debts is therefore split into **Chase today** and everyone
else, and what does the splitting is the **promise**.

"Nitalipa Ijumaa" is a date. Friday either produced money or it did not, and a broken promise is
a far stronger signal than age alone — it is the moment to stop extending more credit, not yet
the moment to write the debt off. Broken promises sort to the top; someone who promised a future
day is deliberately left off today's list, because waiting is the correct action. Any payment
made after a promise retires it, whether or not it cleared the balance: they came back, which is
the behaviour the promise was tracking.

**The app never sends anything itself.** An SMS gateway costs per message, needs a sender ID and
stops working when the shop's balance runs out; the brief rules it out and is right to. Reminders
hand off to WhatsApp, the SMS composer or the dialler, on the number the owner already uses, and
leave the wording editable before it goes. The cost is that the app cannot know whether a message
was delivered — so `debt_reminders` records only what it honestly knows: that the message was
opened, when, by which channel, and **what was owed at that moment**. That last field is the point
of the table: without it you cannot see that someone was chased at KES 1,000 and has since grown
to KES 1,800. Reminders are append-only with no UPDATE or DELETE policy, because "I reminded you
on Tuesday" is worth nothing if it can be rewritten on Wednesday.

Kenyan numbers arrive as `0722…`, `+254722…`, `254722…` or bare `722…`; all four normalise, because
`wa.me` given anything else opens a blank chat, which reads to the owner as "the app is broken".

**Statements are plain text, shared through the OS sheet.** "I already paid you" is the argument
they settle, and settling it needs the dates and amounts rather than a total. Text costs nothing
to send and pastes into the app the owner is already in.

### Nothing gets lost

Discarding a stuck outbox entry used to delete it. For a rejected category that was harmless; for
a rejected credit sale it meant the sale and the debt existed on exactly one phone and would never
reach the server — on the owner's device the debt simply did not exist, and no shop can be asked
to notice that. Discarding now **archives**: the entry stays readable in Settings and can be
re-queued once the cause is fixed. Money entries get a confirmation naming the amount.

Settings also lists everything on the device that has not reached the server and can share it as
plain text. A phone that dies takes its unsynced records with it — that is inherent to working
offline and cannot be engineered away. What it can be is *recoverable*: one share turns a lost
phone into an afternoon of retyping rather than lost sales and lost debts.

## The three full reports

The Reports screen is a summary. Three drill-down reports sit behind it, each printable on its
own, each opening into the records underneath — because a total nobody can take apart is a total
nobody acts on. The selected period travels with the link, so a drill-down never silently reports
a different week from the one on screen.

**Products** — every product, not a top ten: what was on the shelf at the start, what came in,
what sold, what was lost, what is left, and what it made. Every row expands into the movements
behind it.

**Stock ledger** — one product's opening balance, every movement in order with a running balance,
then the closing balance. This is the screen that settles *"the shelf says 14 and the app says
20"*: not with a total, but by showing every event between the two so the owner can point at the
line where they diverged.

**Trading account** — sales, less refunds, less cost of goods = gross profit; then stock losses
and written-off debt = trading profit. Cost of goods and losses each open into their breakdown.

Two decisions in that last one are worth stating plainly:

- **It is not called a profit and loss account**, because it is not one. A P&L ends in net profit
  after rent, salaries, electricity and licences, none of which this app records. Inventing them
  would be worse than omitting them, and the screen says so rather than leaving the owner to
  assume. Everything it does show is measured.
- **Losses are valued at cost, not at retail.** Marking a damaged packet up to the price it might
  have fetched overstates the loss — the shop is out what it paid for it.

### How opening and closing stock are reconstructed

No snapshots and no month-end close. Every change is a movement, so both ends are derivable:

```
closing = quantity now − everything that moved after the period ended
opening = closing      − everything that moved during the period
```

A period from three months ago reconstructs as exactly as today does, for as long as the device
holds the movements.

"Quantity now" carries the one subtlety. `products.quantity` is maintained by the server trigger,
so it reflects only what has **synced** — on a phone that has been selling offline all morning it
is stale by exactly that morning's trade. The reports add the unsynced movements back, the same
way the till and the product list already do. The first version did not, and the tests caught it
reading zero: without that step the reports would disagree with the shelf whenever the shop was
offline, which is most of the time and precisely when they matter.

Each row also carries a `discrepancy`: `opening + received − sold − lost − remaining`. It should
always be zero, and if it is ever not, something wrote to `products.quantity` outside the movement
ledger. The report says so rather than quietly balancing the row.

## Batches and expiry (running this in a chemist)

The money half of this app transfers to a pharmacy unchanged. The stock half did not, and the gap
was a safety issue rather than a missing feature: **the app tracked how many you had and never
which ones expire when**, so it would dispense expired medicine without a murmur. It also could
not answer the only question that matters during a recall — did we sell any of batch XYZ.

`CHEMIST-PLAN.md` records the scoping decisions. What is built:

**A batch is a delivery**, identified by the number printed on the carton, carrying an expiry
date. Its remaining quantity is **derived** by summing the movements that name it — the same
shape `products.quantity` and the debt balance already use. No new source of truth, nothing that
can desync.

**Dispensing is FEFO — first expiry, first out.** Not FIFO: a carton received later can easily
expire sooner, and the risk being managed is the death date, not age. It is `allocate()` from the
debt ledger with the sort key changed, and it works in base units, so **ten tablets out of a strip
of thirty** still resolve to a specific batch. A sale bigger than one batch spans into the next.

**Expired stock is skipped entirely, not used last.** Selling expired medicine is not a lesser
option to fall back on, so if the only stock left is expired the allocator reports *none
available* and the till refuses — naming the product and telling the attendant to check the shelf.
The count still says 40; the sale still stops.

**Opt in per product.** A chemist also sells cotton wool and razor blades. Demanding a batch
number for those trains staff to type rubbish into the one field that has to be trustworthy.

**Stock that predates batch tracking stays sellable**, allocated only after every dated batch.
This matters more than it looks: without it, turning the feature on for a product already on the
shelf would make it unsellable, and the shop would simply turn it back off — losing expiry
tracking altogether, which is far worse than trading down old stock nobody dated.

**Returns go back to the batch they came from**, mirroring the original split if the sale spanned
two. Returning them to whichever batch expires first would put stock under a date that was never
on that carton.

The **Expiry screen** leads with expired stock as a standing instruction rather than a statistic,
then lists what is dying, soonest first. The bands are actions, not decoration: a wholesaler will
usually take stock back with three months of life and almost never with less than one, so 90 days
means *return it*, 30 days means *too late to return*, and expired means *pull it off the shelf*.

Also carried: `is_pom` for prescription-only products. The dispensing record that uses it —
prescriber, patient, prescription reference — is the next piece of work, along with batch
traceability in the UI. Controlled-drugs registers and eTIMS are deliberately out; see
`CHEMIST-PLAN.md` for why.

## Product photos

Optional, one per product, and shown as a 40px thumbnail on the Sell tile and the Products list.
They help most for loose goods, repackaged items, and an attendant who does not know the stock
yet.

Photos are the first thing in this app that could plausibly break the offline guarantee, so three
constraints shape the whole design:

**Compressed on the device, before anything is stored.** A phone camera photo is 3–5 MB; two
hundred of those is ~800 MB, which will not fit in IndexedDB and will never finish syncing on 2G.
Centre-cropped square and re-encoded to 256px WebP, the same photo is 10–20 KB — two hundred is
about 3 MB. An oversized file never exists inside the app at any point.

There is a hard 200 KB ceiling, enforced in the client **and** in the database. It never fires for
a healthy encode; it exists for the browser that cannot encode WebP and silently falls back to
PNG, which for a photograph can be an order of magnitude larger. Without it, the first shop on an
old handset would quietly fill their own database and nobody would find out until sync began
failing.

**Their own table, pulled last.** `product_images` is separate from `products` so a fresh phone
gets the catalogue in kilobytes and can sell immediately, with photos filling in behind it. If
they rode on the product rows, the first sync would carry megabytes before the till was usable.

**They must not cost till speed.** A photo card would roughly halve how many products fit on a
screen, so every sale would gain a scroll. A 40px inline thumbnail keeps tile height and density
exactly as they were, and a product with no photo renders precisely as it did before the feature
existed.

One layout detail worth recording, because the browser check caught it and review would not have:
the cart-count badge used to sit in the tile corner, reserving ~32px. On a tile also carrying a
thumbnail that squeezed **"Blue Band 250g" down to "Blue Band…"** — losing the pack size, which is
exactly the distinction a photo *cannot* convey. The badge now sits on the photo when there is
one, and only falls back to the corner when there is not.

**Last-write-wins, unlike everything else here.** Every money record is insert-once and
idempotent; a photo is a *correction*, so replacing a bad one has to actually replace it. That is
safe only because a photo carries no money — two devices racing produces one of two photos and
either is fine, where two devices racing on a sale would produce a wrong total. A stale replay is
still rejected by comparing `updated_at`, so a phone that was offline for a day cannot overwrite a
newer photo with the one it has been holding. Re-photographing the same product while offline
collapses to a single queued payload rather than four.

An attendant may take photos. They are the one holding the product, and the alternative is that
photos never get taken; a wrong photo is visibly wrong and costs nothing to replace, unlike a
wrong price or a wrong count.

## The M-Pesa confirmation code is optional

It was compulsory, and that was wrong — not because the code is unimportant, but because
**requiring it did not produce more codes. It produced fewer recorded sales.**

The customer's SMS has not arrived, or their phone is dead, or the queue is four deep. A blocking
field leaves the attendant two ways forward: don't record the sale, or record it as cash. The
first loses the sale entirely; the second corrupts the cash/M-Pesa split, which is the one thing
this app exists to keep straight. A field added for accuracy was reliably producing the two least
accurate outcomes available.

So the control moved from a **block** to **visibility**. The code is still prompted for, still
first-class, and Closing now reports exactly what cannot be verified:

- M-Pesa items with no code appear in the tick-off list as **No code**, not hidden from it
- A warning gives the count — "3 of these have no code, so they cannot be matched to the
  statement. The amount is still counted; only the proof is missing."
- The shared summary and the printout carry it too

"3 of today's 11 M-Pesa sales have no code" is something an owner can act on. An attendant
blocked at the till just works around the app, and then the owner has nothing at all.

**What did NOT change.** A blank code is still refused — storing `''` would make every downstream
"does it have a code" check quietly wrong, so the client sends `NULL`. A cash sale still may not
carry a code, a credit sale still may not, and an M-Pesa sale still may not carry a tendered
amount. Those are shape errors, not missing information, and the distinction is the whole point:
relax what is unknowable at the counter, keep everything that is simply incoherent.

The same relaxation applies to a debt repayment made by M-Pesa, for the same reason.

## Refunds

An attendant will mis-key a sale. Before this, that sale stood for ever: it still counted toward
expected cash, so the drawer read short by exactly the mistake — and **a shortfall the owner
cannot explain is indistinguishable from theft**, which is the one thing this app exists to tell
apart. Stock could already be corrected with an `adjustment`; the money could not. Sales were the
only ledger here that was append-only *and* uncorrectable.

**The sale is never edited or deleted.** A refund is a new record pointing at it, exactly as a
debt charge points at its sale.

Four decisions shaped it, and each one closes a hole rather than adding a feature:

- **Owner only, enforced by RLS** — not by hiding a button. Refunding a customer who never
  returned and pocketing the cash is a named theft pattern, so permission beats detection. The
  cost is real: an attendant alone at the counter cannot fix their own mis-key.
- **Whole sale only**, expressed as `unique (sale_id)`. That constraint independently blocks
  refunding the same sale twice and keeping the second payout. Idempotent replay is unaffected —
  a replay carries the same `id` and is absorbed by `on conflict (id) do nothing`.
- **An M-Pesa sale is refunded in CASH.** There is no Daraja by design, so the app cannot send
  M-Pesa, and it says so instead of implying otherwise. Expected **cash** drops; expected M-Pesa
  is untouched. Taking it off the M-Pesa side instead would leave the drawer reading over and the
  Safaricom statement disagreeing.
- **A credit sale is reversed, not paid out.** They never paid, so no cash moves — `sync_refund`
  refuses a cash settlement against a credit sale outright rather than leaving it to the UI. If
  they had part-paid more than they kept, the existing FIFO allocation turns the excess into
  credit toward their next purchase with no extra code.

**`reversal` is deliberately not `writeoff`.** A write-off is a loss the owner chose to absorb; a
reversal is goods coming back, which is not a loss at all. Recording one as the other would
inflate the bad-debt figure on the very screen built to make that figure honest.

**A damaged return is two movements**, `return +qty` then `damage −qty`. A single no-op would
record that stock did not change while losing both facts — that the goods came back, and that
they were written off — and the shrink report needs the second one.

**Closing shows refunds as their own line, never netted into sales.** `Sales 12,400 · Refunds
−800 · Net 11,600` is the honest shape; a single `11,600` hides exactly what the owner most wants
to see. Reports carries the refund exception block — count, value, share of sales, and a
breakdown by reason code. Reason is a code rather than free text precisely so it can be counted:
a climbing count on one reason is a pattern, and a single refund is not.

The UI lives on **Closing**, not the till. It is owner-only, and Closing is where a mis-key is
actually noticed — the drawer disagrees and the owner comes looking. The date picker already
there means refunding yesterday's sale needs no new navigation. The screen asks *why* and nothing
else: where the money goes is computed, never chosen, so nobody can misfile which column is short.

## Audit fixes

A full pass looking for correctness, logistical and security defects turned up ten real issues,
three of them capable of losing a shop's money silently. All ten are fixed and covered by tests
(`npm run test:offline`, `test:responsive`); nothing here needed a new migration.

### Inventory review fixes

**Stock is valued at a moving weighted average**, not the latest purchase price.
`products.buying_price` used to be overwritten on every restock, so restocking unga dearer
instantly revalued every packet already on the shelf and costed last week's damage at this
week's price. That is "latest cost", which is not a recognised valuation method. The average is
now folded in by the stock trigger — `(old_qty × old_avg + received × price) ÷ total` — so it
holds for every path that can insert a movement and is atomic with the quantity update it
depends on. What was actually paid on any given delivery is still on that restock's movement
row, so nothing is lost; the two questions simply stop being conflated.

**Stock movements are pulled back from the server.** They were pushed and never fetched, which
made the shrink report device-local: an attendant's damage and loss records were invisible on the
owner's phone, and a fresh device showed an empty history despite months of trade. Quantities
were always right — those ride on `products` — so the report rendered plausibly and was simply
missing rows.

**There is a per-product stock history screen.** Every sale, restock and adjustment has always
been written to `stock_movements` and nothing ever showed it, so an owner looking at "14 in
stock" and believing it should be 20 had no way to find out why. It also makes adjustments
trustworthy: a recount stops being a number that silently changed.

**Reports read by indexed date range and old local rows are pruned.** `buildReport` used to
`.toArray()` every sale and line item ever recorded and filter in JS — fine at a few thousand
rows, steadily worse after that on a cheap phone. `HISTORY_DAYS` bounded what was pulled but
nothing bounded what was kept.

**Cash-count ids are now deterministic** (`cashCountId(shopId, date)` in `store.ts`), derived
from the shop and the day rather than chosen at random. `sync_cash_count` resolves conflicts on
`(shop_id, business_date)`, not on `id` — a second device counting the same day used to generate
its own random id, which the server discarded in favour of whichever id arrived first. That
device's local row kept its own orphaned id, and the next pull added the server's canonical row
under a *third* id — two local rows for one day, and `dayTotals()` reading `.first()` with no
defined order between them. Every device now computes the same id up front, so there is nothing
left to reconcile: the row simply is the same row everywhere.

**The sync engine now recognises two failure shapes it used to retry forever.** An RLS refusal
(an attendant reaching an owner-only screen by direct URL, which RLS correctly blocks) and a
unique-constraint collision (two offline devices creating a product with the same name) both
used to retry with growing backoff, never resolving, while `describeSyncError()` translates
whichever is not covered into plain language on the Settings screen instead of a raw Postgres
string. Because `sync_sale` is one atomic transaction, any sale that referenced something stuck
this way got its own foreign-key violation and was parked too — money taken from a customer,
never reaching the server. A second, independent net: an entry that has failed
`MAX_ATTEMPTS` times is parked regardless of whether its error message is one this module
recognises, so an unanticipated permanent failure can no longer block every entry queued behind
it forever either. Settings now lists each stuck item individually with a **Discard** action.

**An attendant can no longer reach an owner-only form at all.** `/products/new` and
`/products/edit` only ever hid their entry points from attendants; nothing stopped a direct URL.
`useRequireOwner()` redirects before the form ever renders — the root-cause fix for the
RLS-retry scenario above, not just a treatment of its symptom.

**Selling more than is on hand is refused**, checked against this device's own view of stock
(current quantity plus anything still queued in its own outbox). This is deliberately a
single-device floor, not an attempt to prevent every cross-device race — two phones can still
both sell the last unit before either syncs, and that is not fixable without refusing to sell
offline at all, which would be worse. What this catches is the ordinary case: a mistyped
quantity, now that a cart line's number can be typed directly. The same floor applies to marking
stock damaged or lost; a recount is exempt, since overriding the count is what a recount is for.
There is still no database-level `quantity >= 0` constraint, on purpose — seeing negative stock
is honest data an owner can reconcile, while a hard floor would instead throw the whole sale
away on the exact cross-device race this paragraph already accepts as unfixable.

**A sale's total is always the sum of its own printed lines.** It used to be rounded once from
the raw, unrounded amounts — which can differ by a cent from the sum of the independently
rounded lines actually shown on the receipt. Now `total` is computed from the same rounded line
totals that get stored and displayed, so it is arithmetically impossible for the two to disagree.

Smaller fixes: a duplicate product name is now caught locally before it ever reaches the sync
queue; a reference-data pull failure (categories, units, portions, staff) can no longer discard
three already-successful results because a fourth, unrelated query failed; the Reports screen
names the signed-in user from their own session instead of "Unknown" when the shop roster has
not finished syncing; a custom unit can be marked as allowing halves when it is created, which
was previously impossible; and a same-day repeated M-Pesa code shows a non-blocking warning,
since a code entered twice is far more likely a mistake than a coincidence.

---

## Stock

Stock only ever moves through the ledger. `products.quantity` is a cache maintained by a
database trigger, and no client is granted permission to write it — so every count in the app
is explainable by a list of movements.

| Reason | Direction | Where it comes from |
|---|---|---|
| `opening` | + | The New product form. What was already on the shelf. |
| `restock` | + | Restock. A delivery. |
| `sale` | − | Checkout. |
| `adjustment` | ± | Adjust → Recount. |
| `damage` | − | Adjust → Damaged. |
| `loss` | − | Adjust → Lost or stolen. |

Three decisions worth knowing:

**Opening stock is its own reason, not a restock.** It is not a purchase on a date, and folding
it into restock would corrupt any future answer to "what did I spend on stock this month".

**A recount takes an absolute figure, not a difference.** Someone standing at a shelf knows
"there are 14", not "that is 3 fewer than the app thinks". The app does the subtraction. A
recount that matches records nothing at all rather than an empty movement.

**Registering a product with opening stock is one outbox entry, not two.** A product and its
opening movement must reach the server in a single transaction — a movement pushed before the
row it points at is a foreign-key violation, which the sync engine classifies as permanent and
parks. That would turn a transient ordering problem into stock that never syncs. `sync_new_product`
does both in one transaction, `ON CONFLICT DO NOTHING`, so replays are no-ops.

Products can opt out of stock tracking entirely (airtime, a carrier bag): they sell normally,
write no movements, and never appear in the low-stock list.

## Reports

One screen, three periods — Day, Week, Month — showing the same blocks throughout. Deliberately
not a menu of twelve reports: the operator guidance is blunt that *"reports nobody owns are
reports nobody reads"*, and the recommended rhythm is five minutes daily, thirty weekly, an hour
monthly. Everything is computed from IndexedDB, so reports work with the radio off like every
other screen.

Blocks: sales with the cash/M-Pesa split, a comparison against the previous period, **cash
variance day by day**, sales by attendant, top sellers, stock that did not move, gross profit,
stock movement by reason, and stock value.

Three decisions worth knowing:

**A day compares against the same weekday last week, not yesterday.** A duka's Saturday looks
nothing like its Tuesday, and comparing them manufactures alarm.

**Cash variance is the report this app exists for.** The brief's opening problem is telling a
keying error apart from a pocketed note, and the loss-prevention research is unanimous that a
single day's variance proves nothing — the pattern convicts. Closing has been collecting the raw
material all along; this is what reads it back.

**Unknown cost is never treated as zero.** `sale_items.unit_cost` records what goods cost at the
moment they were sold. Before that column existed the figure is genuinely gone and cannot be
backfilled, so those lines are excluded from margin and counted in a warning, rather than
reported as 100% profit. A product with any unpriced line shows no profit at all instead of a
wrong one. Both suites assert this — it is the failure that would make an owner misprice
something.

The device keeps **62 days** of activity so a 30-day report can be compared with the 30 before
it, entirely offline. Longer periods would need connectivity, so the screen does not offer them
rather than quietly showing a wrong total.

## Pack sizes and units

A shop sells cooking oil two different ways at once, and they need opposite models. Getting
this wrong drifts stock silently, which is the exact failure this app exists to prevent.

**Sealed sizes — separate products, one group.** Rina 1L, 5L and 10L are three products sharing
a `group_name`. They sort together and read as a family, and their **stock is completely
independent**: selling a 5L reduces the 5L count and provably touches nothing else. You cannot
decant a sealed bottle, so the counts must never be fungible. Both test suites assert that
isolation explicitly.

**Measured from bulk — one pool, named measures.** A 20 litre drum is one product with a base
unit of `litre` and portions:

```
½ litre   factor 0.5   KES 120
1 litre   factor 1     KES 220
5 litres  factor 5     KES 1,050
```

Selling 3 × ½ litre writes **one movement of −1.5 litre** and a sale line reading `½ litre × 3`.
`sale_items.quantity` counts portions; `base_quantity` records what left the pool. Prices live
on the portion, because ½ litre is almost never half the price of 1 litre in a real shop.

**Units are yours to define.** `unit` used to be a Postgres enum — four values, and a schema
change plus a redeploy to add "gunia" or "tray". It is now text backed by a per-shop `units`
table you can add to inline. There is deliberately **no foreign key** from `products.unit` to
that table: an FK would recreate the two-row ordering bug `sync_new_product` exists to prevent,
where a product syncs before the unit it references and gets parked forever.

Units flagged `is_fractional` (kg, litre, metre…) step by 0.5 on the till and accept decimals.
Everything else stays whole. **Tapping the quantity in the cart lets you type it** — before this,
a `kg` product could not be sold in fractions at all.

## Colour

The chrome is Claude's palette — ivory ground (`#FAF9F5`), warm slate text (`#1F1E1D`), an
`#F0EEE6` rail, and terracotta for primary actions. Every token lives in `globals.css`; nothing
in the app hardcodes a colour.

The money colours are deliberately **not** from that palette, and could not be. This app's
central rule is that cash and M-Pesa are never confusable, and a warm monochrome family cannot
carry that distinction. So cash stays green and M-Pesa stays blue, retuned to sit on ivory.

One conflict was worth solving properly. Claude's terracotta is a warm red-orange, and the
Difference figure on Closing turns red when the drawer is short — a terracotta button beside a
red-orange error is exactly the ambiguity a reconciliation screen cannot afford. A plain red
scored **dE 20.5** against the accent under simulated deuteranopia (red-green colour blindness,
~8% of men — and cash-green vs danger-red is precisely the pair that collapses under it). Danger
moved to a deep claret at **dE 29.7**, still 8.9:1 against white.

`npm run test:contrast` enforces all of it: every text pairing the UI actually renders against
WCAG AA, and every semantic pair for perceptual distance in CIE Lab, both normally sighted and
under simulated deuteranopia. It runs as part of `npm run verify`.

## Screen sizes

One breakpoint, at `lg` (1024px), because there are really only two ways to hold this app.

| | Phone / tablet-portrait | Desktop / tablet-landscape |
|---|---|---|
| Navigation | Tab bar pinned to the bottom, in thumb reach | Persistent left rail |
| Sell | One step at a time — Charge replaces the grid with the payment step | Grid never leaves; the whole sale happens in a column beside it |
| Running total | Pinned above the tab bar | In the cart panel |
| Closing | Single column, reading order | Figures and drawer count left, M-Pesa codes right |
| Product grid | 2 → 3 → 4 columns as width allows | 3 → 5 columns beside the cart |

Tap targets do not shrink on desktop. A shop counter often has a cheap touchscreen laptop on
it, and 48px is not wrong with a mouse either. Printing always collapses to one column — a
printer reports a wide viewport, so `.print-stack` overrides the desktop grid rather than
letting a Closing summary print in two columns with its M-Pesa list clipped at a scroll edge.

### Definition of done — the manual run

On a phone with aeroplane mode on:

1. Log in *(do this once with internet first — see "Offline auth" below)*
2. Sell three items, pay **Cash**, check the change
3. Sell two items, pay **M-Pesa**, enter a code like `SGH7X2K9LM`
4. Open **Products** — stock has dropped
5. Open **Closing** — cash and M-Pesa are separate; enter a cash count; see the difference
6. Turn the internet back on — the indicator goes `Offline · 5 pending` → `Online`
7. Check Supabase: five sales, five sets of lines, five movements. Exactly once.

---

## How it works

### Idempotent sync

Every row a phone can create — sales, sale lines, stock movements — carries a
**client-generated UUID as its real primary key**. A whole sale is pushed as one unit through
the `sync_sale` RPC, which inserts the sale, its lines and its movements in **one transaction**
with `ON CONFLICT (id) DO NOTHING`.

Three separate upserts would let a sale land while its stock movements didn't, corrupting stock
permanently. One RPC cannot. Replaying the same payload after a dropped connection is a no-op,
which is what makes "sync exactly once" true rather than hopeful.

An outbox entry is deleted only after the server confirms. A crash between confirm and delete
replays — and replaying is harmless, by construction.

### Stock that is right offline

`products.quantity` is a cache maintained by a database trigger on `stock_movements`. No client
is even *granted permission* to write that column. What a device displays is:

```
last quantity the server told us  +  deltas of movements still in this device's outbox
```

The local product row is never mutated. On a successful push, the sync loop fetches the
server's new quantities and commits them **in the same IndexedDB transaction** that clears the
outbox — so the UI never sees a movement counted twice or not at all.

### Offline auth

Supabase cannot mint a session with no network, so **the first sign-in on a device must be
online**. After that the app boots from a session cached in IndexedDB and never awaits the
network to decide who is signed in. An expired token while offline does not throw an attendant
out mid-shift: the till keeps working and sync resumes when a real session returns.

Signing out erases the local copy, so it is **blocked while sales are still waiting to sync**.

### Clock skew

Offline sales are timestamped by the phone. A phone with a wrong date files sales on the wrong
business day, which quietly corrupts the one number this app produces. The sync engine measures
the device/server gap and Closing warns when it exceeds five minutes. Business days are always
computed in `Africa/Nairobi`.

---

## Data model

`shops` · `users` · `products` · `stock_movements` · `sales` · `sale_items` · `cash_counts`

Enforced in the database, not the UI:

- A **cash** sale must have `amount_tendered` (≥ total) and a null `mpesa_code`.
  An **mpesa** sale must have `mpesa_code` and a null `amount_tendered`.
- Stock is append-only. There is **no DELETE policy on any table** — mistakes are corrected
  with a compensating `adjustment` movement, and products are soft-deleted via `is_active`.
- `quantity` is excluded from the column-level UPDATE grant on `products`.
- RLS scopes every table by `shop_id` through a `SECURITY DEFINER` helper, which is also what
  avoids the classic infinite recursion of policies on `users` that query `users`.

## Staff accounts

The owner signs up at `/signup`, which creates the shop. Attendants are invited by email from
**Settings**; when that person signs up with the same address they join the shop automatically
as an attendant. Owners manage products; attendants sell and count cash.

---

## Deliberately not built

Suppliers or purchase orders · barcode scanning · multi-branch · discounts or promotions ·
returns or refunds · VAT or eTIMS · M-Pesa Daraja / STK Push · receipt printers · charts and
dashboards · dark mode · multi-currency · CSV import/export · SMS gateway.

**Built since, on an explicit decision to expand scope:** credit sales, customers, and the debt
lifecycle. The brief excluded them; the owner asked for them; `BACKLOG.md` records the reasoning
so it stays a decision rather than drift. Loyalty is still out — the customer record exists
because debt needs somewhere to hang, and for no other reason.

Two of the remaining exclusions will feel necessary in use:

- **Returns/refunds.** The biggest gap, and the one most likely to bite. An attendant will
  mis-key a sale. Today that sale stands for ever: it still counts toward expected cash, so the
  drawer reads short by exactly the mistake — and a shortfall the owner cannot explain is
  indistinguishable from theft, which is the one thing this app exists to tell apart. An
  `adjustment` movement fixes the stock and nothing fixes the money. What is missing is not code
  but two decisions: **who may void**, and **whether a refund against a credit sale is a cash
  refund or a reversal of the charge**. Get those wrong and you have built a new way to steal.
- **Daraja / STK Push.** The manually-typed M-Pesa code is the control the owner actually
  wants, and unlike an API call it works with no internet.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Supabase (Postgres + Auth + RLS) ·
Dexie/IndexedDB · hand-written service worker · Vercel.
