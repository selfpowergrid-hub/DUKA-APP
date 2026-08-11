/**
 * Offline write-path verification — runs the real Dexie layer against an
 * in-memory IndexedDB with no network and no Supabase, exactly the state a
 * phone is in with aeroplane mode on.
 *
 * Asserts the things the shop's money depends on:
 *   - checkout() completes offline, well inside the one-second budget
 *   - stock drops by the right amount and is derived, never written directly
 *   - Closing keeps cash and M-Pesa separate and computes the difference
 *   - every sale leaves exactly one outbox entry, ready to sync exactly once
 *
 * Run: npm run test:offline
 */
import "fake-indexeddb/auto";
import { db, META_KEYS, metaGet, metaSet } from "../src/lib/db";
import {
  checkout,
  dayTotals,
  pendingDeltas,
  applyDeltas,
  recordAdjustment,
  recordMovement,
  saveCashCount,
  saveCategory,
  saveProduct,
  saveUnit,
} from "../src/lib/store";
import { businessDate, money } from "../src/lib/format";
import type { Product, Session } from "../src/lib/types";

const round2 = (n: number) => Math.round(n * 100) / 100;

let failures = 0;
function expect(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
}

const SESSION: Session = {
  user_id: "00000000-0000-4000-8000-000000000001",
  shop_id: "00000000-0000-4000-8000-0000000000aa",
  shop_name: "Duka ya Mama Njeri",
  role: "owner",
  full_name: "Njeri",
  email: "owner@duka.ke",
};

async function stockOf(id: string): Promise<number> {
  const rows = await db.products.toArray();
  return applyDeltas(rows, await pendingDeltas()).find((p) => p.id === id)!.quantity;
}

async function main() {
  await metaSet(META_KEYS.session, SESSION);

  // --- currency formatting, the one rule that shows up on every screen ----
  expect("money formats as KES 1,250", money(1250) === "KES 1,250", money(1250));
  expect("money has no decimals", money(1250.4) === "KES 1,250", money(1250.4));
  expect("money handles a negative difference", money(-380) === "-KES 380", money(-380));

  // --- products -----------------------------------------------------------
  const unga = await saveProduct({
    name: "Unga Jogoo 2kg",
    unit: "packet",
    buying_price: 175,
    selling_price: 200,
    low_stock_threshold: 8,
  });
  const omo = await saveProduct({
    name: "Omo 500g",
    unit: "packet",
    buying_price: 95,
    selling_price: 120,
    low_stock_threshold: 10,
  });

  // Pretend the server has already told us the opening stock.
  await db.products.update(unga.id, { quantity: 40 } as Partial<Product>);
  await db.products.update(omo.id, { quantity: 30 } as Partial<Product>);

  // --- three items paid in cash (the definition-of-done flow) --------------
  const t0 = performance.now();
  const cashSale = await checkout({
    lines: [
      { product_id: unga.id, name: unga.name, unit: "packet", unit_price: 200, quantity: 2 },
      { product_id: omo.id, name: omo.name, unit: "packet", unit_price: 120, quantity: 1 },
    ],
    payment_method: "cash",
    amount_tendered: 600,
  });
  const elapsed = performance.now() - t0;

  expect("cash checkout completes offline", cashSale.payment_method === "cash");
  expect("cash sale total is right (2x200 + 1x120)", cashSale.total === 520, `${cashSale.total}`);
  expect(
    `checkout is well under the 1s budget`,
    elapsed < 1000,
    `${elapsed.toFixed(1)}ms`,
  );
  expect("cash sale stores tendered and no mpesa code",
    cashSale.amount_tendered === 600 && cashSale.mpesa_code === null);

  expect("stock drops for the sold items", (await stockOf(unga.id)) === 38, `unga=${await stockOf(unga.id)}`);
  expect("stock drops for the second line", (await stockOf(omo.id)) === 29, `omo=${await stockOf(omo.id)}`);

  const stored = await db.products.get(unga.id);
  expect(
    "the stored product row is never mutated locally (derivation, not writing)",
    stored!.quantity === 40,
    `stored=${stored!.quantity}`,
  );

  // --- two items paid by M-Pesa -------------------------------------------
  const mpesaSale = await checkout({
    lines: [
      { product_id: omo.id, name: omo.name, unit: "packet", unit_price: 120, quantity: 2 },
    ],
    payment_method: "mpesa",
    mpesa_code: "SGH7X2K9LM",
  });
  expect("mpesa sale stores the code and no tendered amount",
    mpesaSale.mpesa_code === "SGH7X2K9LM" && mpesaSale.amount_tendered === null);
  expect("stock drops again", (await stockOf(omo.id)) === 27, `omo=${await stockOf(omo.id)}`);

  // --- the money rules are enforced before anything is written ------------
  const before = await db.sales.count();
  let rejected = false;
  try {
    await checkout({
      lines: [{ product_id: unga.id, name: unga.name, unit: "packet", unit_price: 200, quantity: 1 }],
      payment_method: "cash",
      amount_tendered: 50,
    });
  } catch {
    rejected = true;
  }
  expect("short cash payment is refused", rejected && (await db.sales.count()) === before);



  // --- restock ------------------------------------------------------------
  await recordMovement({ product_id: unga.id, delta: 10, reason: "restock", buying_price: 180 });
  expect("restock raises derived stock", (await stockOf(unga.id)) === 48, `unga=${await stockOf(unga.id)}`);

  // --- Closing ------------------------------------------------------------
  const today = businessDate();
  let totals = await dayTotals(today);

  expect("cash and M-Pesa are kept separate", totals.cash === 520 && totals.mpesa === 240,
    `cash=${totals.cash} mpesa=${totals.mpesa}`);
  expect("total is the sum of the two", totals.total === 760, `${totals.total}`);
  expect("transaction count is right", totals.count === 2, `${totals.count}`);
  expect("the M-Pesa code is listed for tick-off",
    totals.mpesaSales.some((s) => s.mpesa_code === "SGH7X2K9LM"));
  expect("all sales are flagged as not yet synced", totals.unsynced === 2, `${totals.unsynced}`);



  // Cash count: expected is CASH ONLY. Counting the M-Pesa money in would be
  // the exact mistake this whole app exists to prevent.
  await saveCashCount(today, 520);
  totals = await dayTotals(today);
  expect("a correct count leaves a zero difference",
    totals.cashCount!.counted_amount - totals.cash === 0);

  await saveCashCount(today, 480);
  totals = await dayTotals(today);
  expect("a short drawer shows a negative difference",
    totals.cashCount!.counted_amount - totals.cash === -40,
    `${totals.cashCount!.counted_amount - totals.cash}`);
  expect("re-counting the same day does not create a second row",
    (await db.cash_counts.where("business_date").equals(today).count()) === 1);

  expect("expected cash excludes M-Pesa entirely", totals.cash === 520 && totals.total === 760);

  // --- the outbox: exactly one entry per sale, ready to sync once ----------
  const outbox = await db.outbox.toArray();
  const saleEntries = outbox.filter((e) => e.kind === "sale");
  expect("exactly one outbox entry per sale", saleEntries.length === 2, `${saleEntries.length}`);
  expect("each sale entry carries its client uuid",
    saleEntries.every((e) => /^[0-9a-f-]{36}$/i.test(e.entity_id)));

  const salePayload = saleEntries[0].payload as { sale: { id: string }; items: unknown[]; movements: unknown[] };
  expect("the sale payload bundles its lines and movements together",
    salePayload.items.length === 2 && salePayload.movements.length === 2);
  expect("the payload id matches the local sale id",
    salePayload.sale.id === saleEntries[0].entity_id);

  const productEntries = outbox.filter((e) => e.kind === "product");
  expect("product payloads never include quantity",
    productEntries.every((e) => !("quantity" in (e.payload as object))));

  // --- registering a product WITH opening stock, offline ------------------
  const beforeOutbox = await db.outbox.count();
  const sukari = await saveProduct({
    name: "Sukari Mumias 1kg",
    unit: "packet",
    buying_price: 145,
    selling_price: 165,
    low_stock_threshold: 10,
    opening_quantity: 50,
    opening_total_cost: 7250,
  });

  expect(
    "a new product with opening stock queues ONE outbox entry, not two",
    (await db.outbox.count()) - beforeOutbox === 1,
    `${(await db.outbox.count()) - beforeOutbox}`,
  );

  const npEntry = (await db.outbox.toArray()).find((e) => e.entity_id === sukari.id)!;
  expect("that entry is a new_product bundle", npEntry.kind === "new_product", npEntry.kind);

  const npPayload = npEntry.payload as {
    product: Record<string, unknown>;
    opening: { delta: number; total_cost: number } | null;
  };
  expect(
    "the bundle carries the product and its opening movement together",
    npPayload.opening?.delta === 50 && npPayload.opening?.total_cost === 7250,
    JSON.stringify(npPayload.opening),
  );
  expect(
    "the product payload never carries quantity",
    !("quantity" in npPayload.product),
  );

  // The whole point: stock is right immediately, with no network.
  expect("opening stock shows immediately offline", (await stockOf(sukari.id)) === 50, `${await stockOf(sukari.id)}`);
  expect(
    "the stored product row still holds no local quantity",
    (await db.products.get(sukari.id))!.quantity === 0,
  );

  // Selling from opening stock works before anything has synced.
  await checkout({
    lines: [
      { product_id: sukari.id, name: sukari.name, unit: "packet", unit_price: 165, quantity: 4 },
    ],
    payment_method: "cash",
    amount_tendered: 700,
  });
  expect("selling from unsynced opening stock is correct", (await stockOf(sukari.id)) === 46, `${await stockOf(sukari.id)}`);

  // --- a product registered with no opening stock -------------------------
  const airtime = await saveProduct({
    name: "Airtime",
    unit: "pc",
    buying_price: 0,
    selling_price: 50,
    low_stock_threshold: 0,
    track_stock: false,
  });
  expect("an untracked product starts at zero", (await stockOf(airtime.id)) === 0);

  await checkout({
    lines: [{ product_id: airtime.id, name: airtime.name, unit: "pc", unit_price: 50, quantity: 3 }],
    payment_method: "mpesa",
    mpesa_code: "AIRTIME123",
  });
  expect(
    "selling an untracked product writes no stock movement",
    (await stockOf(airtime.id)) === 0,
    `${await stockOf(airtime.id)}`,
  );
  expect(
    "...but the sale itself is still recorded",
    (await db.sales.toArray()).some((s) => s.mpesa_code === "AIRTIME123"),
  );

  // --- adjustments: recount takes an ABSOLUTE figure ----------------------
  // 46 on hand; the attendant counts 40. That is a delta of -6, worked out by
  // the app, not by the person holding the clipboard.
  const afterRecount = await recordAdjustment({
    product_id: sukari.id,
    reason: "adjustment",
    value: 40,
    note: "end of month count",
  });
  expect("a recount to an absolute figure lands on that figure", afterRecount === 40, `${afterRecount}`);
  expect("derived stock agrees with the recount", (await stockOf(sukari.id)) === 40);

  const recountMove = (await db.stock_movements.toArray())
    .filter((m) => m.product_id === sukari.id && m.reason === "adjustment")
    .pop()!;
  expect("the recount is stored as a signed delta, not the raw count", recountMove.delta === -6, `${recountMove.delta}`);

  // A recount upward works too.
  expect(
    "a recount can also increase stock",
    (await recordAdjustment({ product_id: sukari.id, reason: "adjustment", value: 44 })) === 44,
  );

  // Damage always reduces.
  const afterDamage = await recordAdjustment({
    product_id: sukari.id,
    reason: "damage",
    value: 2,
    note: "torn packets",
  });
  expect("damage reduces stock", afterDamage === 42, `${afterDamage}`);

  let dmgRejected = false;
  try {
    await recordAdjustment({ product_id: sukari.id, reason: "damage", value: 0 });
  } catch {
    dmgRejected = true;
  }
  expect("damaging zero is refused", dmgRejected);

  let negRejected = false;
  try {
    await recordAdjustment({ product_id: sukari.id, reason: "adjustment", value: -5 });
  } catch {
    negRejected = true;
  }
  expect("a negative count is refused", negRejected);

  // A recount that matches does nothing at all — no empty movement.
  const movesBefore = await db.stock_movements.count();
  const same = await recordAdjustment({ product_id: sukari.id, reason: "adjustment", value: 42 });
  expect(
    "recounting the same figure records nothing",
    same === 42 && (await db.stock_movements.count()) === movesBefore,
  );

  // --- restock with backdating and a total-cost invoice -------------------
  await recordMovement({
    product_id: sukari.id,
    delta: 25,
    reason: "restock",
    buying_price: 175,
    total_cost: 4375,
    note_ref: "INV-2291",
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
  expect("a backdated restock still moves stock", (await stockOf(sukari.id)) === 67, `${await stockOf(sukari.id)}`);
  const restockMove = (await db.stock_movements.toArray())
    .filter((m) => m.product_id === sukari.id && m.reason === "restock")
    .pop()!;
  expect(
    "the restock keeps the invoice total and reference",
    restockMove.total_cost === 4375 && restockMove.note_ref === "INV-2291",
  );

  // --- categories ---------------------------------------------------------
  const flour = await saveCategory("Flour");
  const flourAgain = await saveCategory("  flour  ");
  expect("categories de-duplicate by name, case and spacing", flour.id === flourAgain.id);
  expect("only one category row exists", (await db.categories.count()) === 1);

  // =========================================================================
  // CASE A — sealed pack sizes. Independent stock is the whole guarantee.
  // =========================================================================
  const rina: Record<string, Awaited<ReturnType<typeof saveProduct>>> = {};
  for (const [key, nm, price] of [
    ["l1", "Rina 1L", 290],
    ["l5", "Rina 5L", 1350],
    ["l10", "Rina 10L", 2600],
  ] as Array<[string, string, number]>) {
    rina[key] = await saveProduct({
      name: nm,
      unit: "bottle",
      buying_price: price * 0.85,
      selling_price: price,
      low_stock_threshold: 2,
      group_name: "Rina cooking oil",
      opening_quantity: 10,
    });
  }

  expect(
    "sealed sizes share a group but are separate products",
    rina.l1.group_name === "Rina cooking oil" && rina.l1.id !== rina.l5.id,
  );
  expect("each sealed size carries its own opening stock", (await stockOf(rina.l5.id)) === 10);

  await checkout({
    lines: [
      { product_id: rina.l5.id, name: "Rina 5L", unit: "bottle", unit_price: 1350, quantity: 1 },
    ],
    payment_method: "cash",
    amount_tendered: 1500,
  });

  expect("selling a sealed 5L reduces the 5L count", (await stockOf(rina.l5.id)) === 9, `${await stockOf(rina.l5.id)}`);
  expect(
    "...and provably leaves 1L and 10L untouched",
    (await stockOf(rina.l1.id)) === 10 && (await stockOf(rina.l10.id)) === 10,
    `1L=${await stockOf(rina.l1.id)} 10L=${await stockOf(rina.l10.id)}`,
  );

  // =========================================================================
  // CASE B — measured from one pool.
  // =========================================================================
  const drum = await saveProduct({
    name: "Mafuta ya kupima",
    unit: "litre",
    buying_price: 190,
    selling_price: 220,
    low_stock_threshold: 5,
    opening_quantity: 20,
    portions: [
      { name: "½ litre", factor: 0.5, price: 120 },
      { name: "1 litre", factor: 1, price: 220 },
      { name: "5 litres", factor: 5, price: 1050 },
    ],
  });

  const drumPortions = await db.portions.where("product_id").equals(drum.id).toArray();
  expect("portions are stored against the product", drumPortions.length === 3, `${drumPortions.length}`);
  expect(
    "a new product ships its portions inside the same outbox entry",
    (
      (await db.outbox.toArray()).find((e) => e.entity_id === drum.id)!.payload as {
        portions: unknown[];
      }
    ).portions.length === 3,
  );
  expect("the drum starts at its opening litres", (await stockOf(drum.id)) === 20);

  const half = drumPortions.find((p) => p.name === "½ litre")!;
  await checkout({
    lines: [
      {
        product_id: drum.id,
        name: "Mafuta ya kupima — ½ litre",
        unit: "litre",
        unit_price: half.price,
        quantity: 3,
        portion_id: half.id,
        portion_name: half.name,
        portion_factor: half.factor,
      },
    ],
    payment_method: "cash",
    amount_tendered: 400,
  });

  expect(
    "selling 3 × ½ litre takes exactly 1.5 litre from the pool",
    (await stockOf(drum.id)) === 18.5,
    `${await stockOf(drum.id)}`,
  );

  const halfLine = (await db.sale_items.toArray()).find((i) => i.portion_name === "½ litre")!;
  expect("the sale line counts portions, not litres", halfLine.quantity === 3);
  expect("...and records the base quantity separately", halfLine.base_quantity === 1.5, `${halfLine.base_quantity}`);
  expect("the line total uses the portion price", halfLine.line_total === 360, `${halfLine.line_total}`);

  // Two measures of the same drum in one sale are two lines at two prices.
  const fiveL = drumPortions.find((p) => p.name === "5 litres")!;
  await checkout({
    lines: [
      {
        product_id: drum.id,
        name: "½ litre",
        unit: "litre",
        unit_price: half.price,
        quantity: 2,
        portion_id: half.id,
        portion_name: half.name,
        portion_factor: half.factor,
      },
      {
        product_id: drum.id,
        name: "5 litres",
        unit: "litre",
        unit_price: fiveL.price,
        quantity: 1,
        portion_id: fiveL.id,
        portion_name: fiveL.name,
        portion_factor: fiveL.factor,
      },
    ],
    payment_method: "mpesa",
    mpesa_code: "OILSALE99",
  });
  expect(
    "mixed measures in one sale take 1 + 5 = 6 litres",
    (await stockOf(drum.id)) === 12.5,
    `${await stockOf(drum.id)}`,
  );

  // --- fractional quantities on a plain measured product -----------------
  const beans = await saveProduct({
    name: "Maharagwe",
    unit: "kg",
    buying_price: 130,
    selling_price: 160,
    low_stock_threshold: 5,
    opening_quantity: 30,
  });
  await checkout({
    lines: [
      { product_id: beans.id, name: "Maharagwe", unit: "kg", unit_price: 160, quantity: 2.5 },
    ],
    payment_method: "cash",
    amount_tendered: 500,
  });
  expect("2.5 kg can now be sold at all", (await stockOf(beans.id)) === 27.5, `${await stockOf(beans.id)}`);
  const beanLine = (await db.sale_items.toArray()).find((i) => i.product_name === "Maharagwe")!;
  expect("a fractional line prices correctly (2.5 × 160)", beanLine.line_total === 400, `${beanLine.line_total}`);

  // --- custom units -------------------------------------------------------
  const gunia = await saveUnit({ code: "Gunia", label: "Sack of 90kg" });
  expect("a custom unit is normalised to lower case", gunia.code === "gunia");
  const guniaAgain = await saveUnit({ code: " GUNIA " });
  expect("custom units de-duplicate", gunia.id === guniaAgain.id);
  const maize = await saveProduct({
    name: "Mahindi gunia",
    unit: "gunia",
    buying_price: 5800,
    selling_price: 6500,
    low_stock_threshold: 1,
    opening_quantity: 4,
  });
  expect("a product can use a unit the app never shipped", maize.unit === "gunia");

  // --- editing portions replaces the list --------------------------------
  await saveProduct({
    id: drum.id,
    name: drum.name,
    unit: drum.unit,
    buying_price: drum.buying_price,
    selling_price: drum.selling_price,
    low_stock_threshold: drum.low_stock_threshold,
    portions: [{ name: "1 litre", factor: 1, price: 230 }],
  });
  expect(
    "editing a product replaces its portion list",
    (await db.portions.where("product_id").equals(drum.id).toArray()).length === 1,
  );
  expect(
    "removing a portion does not disturb the stock pool",
    (await stockOf(drum.id)) === 12.5,
    `${await stockOf(drum.id)}`,
  );
  expect(
    "...nor rewrite sales already rung up at that measure",
    (await db.sale_items.toArray()).some((i) => i.portion_name === "½ litre"),
  );

  // =========================================================================
  // REPORTS
  // =========================================================================
  const { buildReport, previousPeriod, buildPeriod } = await import("../src/lib/reports");

  // Period arithmetic first — everything else depends on it.
  const wk = buildPeriod("week", today);
  expect("a week period covers 7 days ending today", wk.dates.length === 7 && wk.to === today);
  expect("a month period covers 30 days", buildPeriod("month", today).dates.length === 30);
  expect(
    "a day compares against the SAME WEEKDAY last week, not yesterday",
    previousPeriod(buildPeriod("day", today)).to ===
      businessDate(new Date(Date.now() - 7 * 86_400_000)),
  );
  expect(
    "a week compares against the 7 days before it, with no overlap",
    previousPeriod(wk).dates.every((d) => !wk.dates.includes(d)) &&
      previousPeriod(wk).dates.length === 7,
  );

  // Compare against a FRESH Closing computation, not the snapshot taken
  // earlier in this test — many more sales have been rung up since.
  const closingNow = await dayTotals(today);
  const dayReport = await buildReport("day", today);
  expect(
    "the day report's cash and M-Pesa match Closing exactly",
    dayReport.sales.cash === closingNow.cash && dayReport.sales.mpesa === closingNow.mpesa,
    `report ${dayReport.sales.cash}/${dayReport.sales.mpesa} vs closing ${closingNow.cash}/${closingNow.mpesa}`,
  );
  expect(
    "the average sale is the total over the count",
    dayReport.sales.average === Math.round((dayReport.sales.total / dayReport.sales.count) * 100) / 100,
  );

  const weekReport = await buildReport("week", today);
  expect(
    "a week that contains only today has the same totals as the day",
    weekReport.sales.total === dayReport.sales.total,
    `${weekReport.sales.total} vs ${dayReport.sales.total}`,
  );
  expect(
    "an empty comparison period reads zero, not an error",
    weekReport.previous.total === 0 && weekReport.previous.count === 0,
  );

  // --- cash variance across days -------------------------------------------
  expect(
    "variance has a row for every day in the period",
    weekReport.variance.length === 7,
    `${weekReport.variance.length}`,
  );
  expect(
    "days with no cash count are marked, not counted as zero difference",
    weekReport.variance.filter((v) => v.counted === null).length === 6,
  );
  const expectedDiff = Math.round((480 - closingNow.cash) * 100) / 100;
  expect(
    "the variance total only sums days that were actually counted",
    weekReport.varianceTotal.countedDays === 1 &&
      weekReport.varianceTotal.difference === expectedDiff,
    `days=${weekReport.varianceTotal.countedDays} diff=${weekReport.varianceTotal.difference} expected=${expectedDiff}`,
  );
  expect(
    "expected cash in the variance row is the day's cash sales",
    weekReport.variance.find((v) => v.date === today)!.expectedCash === closingNow.cash,
  );

  // --- by attendant ---------------------------------------------------------
  expect(
    "sales are attributed to the person who rang them up",
    weekReport.attendants.length === 1 && weekReport.attendants[0].user_id === SESSION.user_id,
  );
  expect(
    "an attendant's cash and M-Pesa are kept apart",
    weekReport.attendants[0].cash === closingNow.cash &&
      weekReport.attendants[0].mpesa === closingNow.mpesa,
    `${weekReport.attendants[0].cash}/${weekReport.attendants[0].mpesa}`,
  );

  // --- margin: the failure mode that would misprice a product --------------
  // Everything sold so far in this test was priced with a known cost.
  expect(
    "gross profit is revenue minus recorded cost",
    weekReport.margin.profit === weekReport.margin.revenue - weekReport.margin.cost,
  );
  expect("margin percent is derived from those two", weekReport.margin.marginPct > 0);

  // Now a line whose cost was never recorded — the pre-migration case.
  const legacyItems = await db.sale_items.toArray();
  await db.sale_items.update(legacyItems[0].id, { unit_cost: null });
  const withUnknown = await buildReport("week", today);
  expect(
    "a line with no recorded cost is reported as unknown, never as zero cost",
    withUnknown.margin.unknownLines === 1,
    `${withUnknown.margin.unknownLines}`,
  );
  expect(
    "...and is excluded from revenue as well as cost, so the margin stays honest",
    withUnknown.margin.revenue < weekReport.margin.revenue &&
      withUnknown.margin.marginPct > 0 &&
      withUnknown.margin.marginPct < 100,
    `${withUnknown.margin.marginPct}%`,
  );
  const unknownProduct = withUnknown.topByValue.find(
    (p) => p.product_id === legacyItems[0].product_id,
  );
  expect(
    "a product with any unpriced line reports null profit, not a wrong number",
    unknownProduct?.profit === null,
    `${unknownProduct?.profit}`,
  );
  await db.sale_items.update(legacyItems[0].id, { unit_cost: 175 });

  // --- portioned lines cost by base units, not by portions -----------------
  const drumReport = await buildReport("week", today);
  const drumRow = drumReport.topByValue.find((p) => p.product_id === drum.id);
  expect(
    "a measured product's report quantity is in base units, not portions",
    drumRow != null && drumRow.quantity === 7.5,
    `${drumRow?.quantity}`,
  );

  // --- top sellers and slow movers -----------------------------------------
  expect(
    "top sellers are ordered by money taken",
    weekReport.topByValue.every(
      (p, i) => i === 0 || weekReport.topByValue[i - 1].revenue >= p.revenue,
    ),
  );
  expect(
    "a product that never sold appears under slow movers",
    weekReport.slowMovers.some((p) => p.id === maize.id),
  );
  expect(
    "a product that sold does not",
    !weekReport.slowMovers.some((p) => p.id === unga.id),
  );

  // --- stock movement (the shrink report) ----------------------------------
  const damaged = weekReport.movements.find((m) => m.reason === "damage");
  expect("damage shows up in the stock movement report", damaged != null);
  expect("damage is a negative value at cost", (damaged?.value ?? 0) < 0, `${damaged?.value}`);
  expect(
    "restocks show as positive",
    (weekReport.movements.find((m) => m.reason === "restock")?.quantity ?? 0) > 0,
  );

  // --- stock value ----------------------------------------------------------
  expect("stock is valued at both cost and retail", weekReport.stock.atCost > 0 && weekReport.stock.atRetail > weekReport.stock.atCost);

  // --- a period with nothing in it -----------------------------------------
  const longAgo = businessDate(new Date(Date.now() - 300 * 86_400_000));
  const empty = await buildReport("week", longAgo);
  expect(
    "a period with no activity reads zero everywhere instead of erroring",
    empty.sales.total === 0 &&
      empty.sales.count === 0 &&
      empty.attendants.length === 0 &&
      empty.margin.knownLines === 0 &&
      empty.varianceTotal.countedDays === 0,
  );

  // =========================================================================
  // AUDIT FIXES — each test below reproduces the exact scenario that used to
  // fail, not just the happy path.
  // =========================================================================

  // --- fix: reports name the current user from the session, not just the
  // staff roster (an attendant's own roster row is often not synced yet) ---
  expect(
    "the signed-in user's own sales are named from the session, not left as Unknown",
    weekReport.attendants.find((a) => a.user_id === SESSION.user_id)?.name === SESSION.full_name,
    JSON.stringify(weekReport.attendants),
  );

  // --- fix: sync failure classification --------------------------------
  const { isPermanent, describeSyncError } = await import("../src/lib/sync");
  expect(
    "an RLS refusal is classified permanent, not retried forever",
    isPermanent('new row violates row-level security policy for table "products"'),
  );
  expect(
    "a duplicate name collision is classified permanent",
    isPermanent(
      'duplicate key value violates unique constraint "products_shop_name_unique"',
    ),
  );
  expect(
    "the four original permanent shapes still classify correctly",
    isPermanent("violates check constraint") &&
      isPermanent("violates foreign key constraint") &&
      isPermanent("invalid input syntax for type uuid") &&
      isPermanent("violates not-null constraint"),
  );
  expect(
    "a plain network failure is NOT classified permanent — it should still retry",
    !isPermanent("Failed to fetch") && !isPermanent("NetworkError when attempting to fetch"),
  );

  expect(
    "an RLS refusal gets a human explanation, not a raw Postgres string",
    describeSyncError('rejected: new row violates row-level security policy for table "products"') ===
      "This device tried to save something only the shop owner is allowed to change.",
  );
  expect(
    "a product name collision names the product specifically",
    describeSyncError('duplicate key value violates unique constraint "products_shop_name_unique"') ===
      "A product with this name already exists.",
  );
  expect(
    "an unrecognised error falls back to the raw message rather than a wrong friendly one",
    describeSyncError("rejected: some future Postgres error we have never seen") ===
      "some future Postgres error we have never seen",
  );

  // --- fix: cash-count ids are deterministic, so two devices counting the
  // same day can never diverge into two local rows -------------------------
  const { cashCountId } = await import("../src/lib/store");
  const day1 = businessDate();
  const day2 = businessDate(new Date(Date.now() - 86_400_000));
  expect(
    "the same shop+day always produces the same id",
    cashCountId(SESSION.shop_id, day1) === cashCountId(SESSION.shop_id, day1),
  );
  expect(
    "a different day produces a different id",
    cashCountId(SESSION.shop_id, day1) !== cashCountId(SESSION.shop_id, day2),
  );
  expect(
    "a different shop produces a different id for the same day",
    cashCountId(SESSION.shop_id, day1) !== cashCountId("00000000-0000-4000-8000-0000000000bb", day1),
  );
  expect(
    "the id is a syntactically valid uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      cashCountId(SESSION.shop_id, day1),
    ),
  );

  // The scenario the bug actually was: two "devices" (simulated by two direct
  // saveCashCount calls with no shared local state, which is exactly what
  // happens when Device A creates a count offline and Device B, also offline,
  // creates its own for the same day before either has seen the other) must
  // resolve to ONE row, not two, once both are known locally.
  const freshDay = businessDate(new Date(Date.now() - 200 * 86_400_000));
  await db.cash_counts.where("business_date").equals(freshDay).delete();
  const deviceACount = await saveCashCount(freshDay, 500);
  await db.cash_counts.clear(); // simulate Device B, which never saw A's row
  const deviceBCount = await saveCashCount(freshDay, 480);
  expect(
    "two independent devices counting the same day compute the same row id",
    deviceACount.id === deviceBCount.id,
    `${deviceACount.id} vs ${deviceBCount.id}`,
  );

  // --- fix: oversell guard --------------------------------------------------
  const fewLeft = await saveProduct({
    name: "Kasuku 500ml",
    unit: "pc",
    buying_price: 130,
    selling_price: 155,
    low_stock_threshold: 5,
    opening_quantity: 3,
  });
  let oversoldRejected = false;
  try {
    await checkout({
      lines: [
        { product_id: fewLeft.id, name: fewLeft.name, unit: "pc", unit_price: 155, quantity: 10 },
      ],
      payment_method: "cash",
      amount_tendered: 2000,
    });
  } catch {
    oversoldRejected = true;
  }
  expect("selling more than is on hand is refused", oversoldRejected);
  expect("...and nothing was written", (await stockOf(fewLeft.id)) === 3, `${await stockOf(fewLeft.id)}`);

  // Selling exactly what remains is still allowed — this is a floor, not a
  // margin of safety subtracted from real stock.
  await checkout({
    lines: [
      { product_id: fewLeft.id, name: fewLeft.name, unit: "pc", unit_price: 155, quantity: 3 },
    ],
    payment_method: "cash",
    amount_tendered: 500,
  });
  expect("selling exactly what is on hand succeeds", (await stockOf(fewLeft.id)) === 0);

  // Untracked products are exempt — there is no "on hand" to compare against.
  const untrackedItem = await saveProduct({
    name: "Bag",
    unit: "pc",
    buying_price: 0,
    selling_price: 5,
    low_stock_threshold: 0,
    track_stock: false,
  });
  let untrackedOk = true;
  try {
    await checkout({
      lines: [
        { product_id: untrackedItem.id, name: "Bag", unit: "pc", unit_price: 5, quantity: 500 },
      ],
      payment_method: "cash",
      amount_tendered: 3000,
    });
  } catch {
    untrackedOk = false;
  }
  expect("an untracked product has no oversell floor to hit", untrackedOk);

  // --- fix: damage/loss cannot exceed what is on hand -----------------------
  const capped = await saveProduct({
    name: "Dettol 100ml",
    unit: "pc",
    buying_price: 115,
    selling_price: 145,
    low_stock_threshold: 3,
    opening_quantity: 4,
  });
  let damageCapped = false;
  try {
    await recordAdjustment({ product_id: capped.id, reason: "damage", value: 50 });
  } catch {
    damageCapped = true;
  }
  expect("damaging more than is on hand is refused", damageCapped);
  expect("...and stock is untouched", (await stockOf(capped.id)) === 4);
  // A recount, in contrast, is never capped — that is what "recount" means.
  let recountUncapped = true;
  try {
    await recordAdjustment({ product_id: capped.id, reason: "adjustment", value: 500 });
  } catch {
    recountUncapped = false;
  }
  expect("a recount can freely exceed the previous figure", recountUncapped);

  // --- fix: sale total is the sum of its own printed lines, always ---------
  // 3 lines chosen so that summing raw (unrounded) amounts and rounding once
  // gives a DIFFERENT cent than summing three independently-rounded lines —
  // the exact drift the old computation was exposed to.
  const roundingProduct = await saveProduct({
    name: "Rounding test item",
    unit: "pc",
    buying_price: 0,
    selling_price: 99.99,
    low_stock_threshold: 0,
    opening_quantity: 100,
  });
  const drifted = await checkout({
    lines: [
      { product_id: roundingProduct.id, name: "A", unit: "pc", unit_price: 33.335, quantity: 1 },
      { product_id: roundingProduct.id, name: "A", unit: "pc", unit_price: 33.335, quantity: 1 },
      { product_id: roundingProduct.id, name: "A", unit: "pc", unit_price: 33.335, quantity: 1 },
    ],
    payment_method: "cash",
    amount_tendered: 200,
  });
  const driftedLines = (await db.sale_items.toArray()).filter((i) => i.sale_id === drifted.id);
  const sumOfLines = Math.round(driftedLines.reduce((s, i) => s + i.line_total, 0) * 100) / 100;
  expect(
    "the sale total exactly equals the sum of its own printed line totals",
    drifted.total === sumOfLines,
    `total=${drifted.total} sum-of-lines=${sumOfLines}`,
  );

  // --- fix: a duplicate product name is caught locally, before it ever
  // reaches the sync queue -------------------------------------------------
  await saveProduct({
    name: "Colgate 75ml",
    unit: "pc",
    buying_price: 130,
    selling_price: 160,
    low_stock_threshold: 4,
  });
  let dupeProductRejected = false;
  try {
    await saveProduct({
      name: "  colgate 75ml  ", // same name, different case and spacing
      unit: "pc",
      buying_price: 130,
      selling_price: 160,
      low_stock_threshold: 4,
    });
  } catch {
    dupeProductRejected = true;
  }
  expect(
    "creating a second product with the same name is refused locally",
    dupeProductRejected,
  );

  // =========================================================================
  // CUSTOMER DEBT
  // =========================================================================
  const { saveCustomer, recordDebtEntry } = await import("../src/lib/store");
  const { customerDebt, debtors, allocate, bucketFor, debtTotals, repaymentsOn } = await import(
    "../src/lib/debt"
  );

  // --- FIFO allocation, tested as a pure function first --------------------
  const mkEntry = (
    kind: "charge" | "payment" | "writeoff",
    amount: number,
    dayOffset: number,
  ) =>
    ({
      id: `e${dayOffset}-${kind}-${amount}`,
      shop_id: SESSION.shop_id,
      customer_id: "c1",
      user_id: SESSION.user_id,
      kind,
      amount,
      sale_id: kind === "charge" ? "s1" : null,
      payment_method: kind === "payment" ? "cash" : null,
      mpesa_code: null,
      note: null,
      business_date: businessDate(new Date(Date.now() - dayOffset * 86_400_000)),
      created_at: new Date(Date.now() - dayOffset * 86_400_000).toISOString(),
      synced_at: null,
    }) as const;

  // 500 owed 40 days ago, 300 owed 5 days ago, then 400 paid.
  // FIFO must clear the OLD charge first: 400 goes against the 500.
  const fifo = allocate([
    mkEntry("charge", 500, 40),
    mkEntry("charge", 300, 5),
    mkEntry("payment", 400, 1),
  ]);
  expect("FIFO leaves the right balance", fifo.balance === 400, `${fifo.balance}`);
  expect(
    "a payment clears the OLDEST charge first, not the newest",
    fifo.open.length === 2 && fifo.open[0].outstanding === 100 && fifo.open[1].outstanding === 300,
    JSON.stringify(fifo.open.map((o) => o.outstanding)),
  );
  expect(
    "ageing comes from the oldest UNPAID charge",
    fifo.open[0].ageDays === 40 && fifo.open[0].bucket === "chase",
    `${fifo.open[0].ageDays} ${fifo.open[0].bucket}`,
  );

  // Paying exactly clears everything and leaves no phantom open charge.
  const settled = allocate([mkEntry("charge", 500, 10), mkEntry("payment", 500, 1)]);
  expect("paying in full settles to zero", settled.balance === 0 && settled.open.length === 0);

  // Paying ahead is real — customers round up — and must not be lost.
  const ahead = allocate([mkEntry("charge", 200, 10), mkEntry("payment", 500, 1)]);
  expect(
    "overpayment becomes credit, not a discarded amount",
    ahead.balance === -300 && ahead.credit === 300,
    `balance=${ahead.balance} credit=${ahead.credit}`,
  );

  // Money paid before a charge should settle that charge on arrival.
  const prepaid = allocate([mkEntry("payment", 500, 10), mkEntry("charge", 200, 5)]);
  expect("money paid ahead settles a later charge", prepaid.balance === -300, `${prepaid.balance}`);

  // A write-off reduces what is owed exactly like a payment.
  const written = allocate([mkEntry("charge", 500, 10), mkEntry("writeoff", 500, 1)]);
  expect("a write-off clears the debt", written.balance === 0 && written.open.length === 0);

  // Allocation must be order-independent given the same events — that is what
  // makes two offline devices converge once they have both synced.
  const shuffled = allocate([
    mkEntry("payment", 400, 1),
    mkEntry("charge", 300, 5),
    mkEntry("charge", 500, 40),
  ]);
  expect(
    "the same events in any input order give the same answer",
    shuffled.balance === fifo.balance &&
      JSON.stringify(shuffled.open.map((o) => o.outstanding)) ===
        JSON.stringify(fifo.open.map((o) => o.outstanding)),
  );

  expect(
    "ageing buckets match the duka-tuned thresholds",
    bucketFor(0) === "normal" &&
      bucketFor(7) === "normal" &&
      bucketFor(8) === "watch" &&
      bucketFor(30) === "watch" &&
      bucketFor(31) === "chase" &&
      bucketFor(60) === "chase" &&
      bucketFor(61) === "at_risk",
  );

  // --- a real credit sale, end to end --------------------------------------
  const wanjiku = await saveCustomer({ name: "Wanjiku", phone: "0722000111" });
  const creditStock = await saveProduct({
    name: "Sukari for credit",
    unit: "packet",
    buying_price: 145,
    selling_price: 165,
    low_stock_threshold: 2,
    opening_quantity: 20,
  });

  const stockBeforeCredit = await stockOf(creditStock.id);
  // Captured here, not reused from earlier: many more sales have been rung up
  // since, so an older snapshot would be comparing against the wrong day.
  const beforeCredit = await dayTotals(businessDate());
  const creditSale = await checkout({
    lines: [
      {
        product_id: creditStock.id,
        name: creditStock.name,
        unit: "packet",
        unit_price: 165,
        quantity: 4,
      },
    ],
    payment_method: "credit",
    customer_id: wanjiku.id,
  });

  expect("a credit sale records no money tendered", creditSale.amount_tendered === null);
  expect("a credit sale carries its customer", creditSale.customer_id === wanjiku.id);
  expect(
    "goods leave the shop on credit exactly as on a cash sale",
    stockBeforeCredit - (await stockOf(creditStock.id)) === 4,
  );

  const afterCredit = await customerDebt(wanjiku.id);
  expect("the sale becomes a debt for that customer", afterCredit?.balance === 660, `${afterCredit?.balance}`);

  // ONE outbox entry — the charge must ride with its sale, never separately.
  const creditEntry = (await db.outbox.toArray()).find((e) => e.entity_id === creditSale.id)!;
  expect("a credit sale queues one outbox entry", creditEntry.kind === "sale");
  expect(
    "...carrying the customer and the debt entry id, so the server writes both atomically",
    Boolean(
      (creditEntry.payload as { sale: { customer_id: string; debt_entry_id: string } }).sale
        .customer_id &&
        (creditEntry.payload as { sale: { debt_entry_id: string } }).sale.debt_entry_id,
    ),
  );
  expect(
    "no separate debt_entry outbox row is created for a charge",
    (await db.outbox.toArray()).filter((e) => e.kind === "debt_entry").length === 0,
  );

  let creditNoCustomer = false;
  try {
    await checkout({
      lines: [
        {
          product_id: creditStock.id,
          name: creditStock.name,
          unit: "packet",
          unit_price: 165,
          quantity: 1,
        },
      ],
      payment_method: "credit",
    });
  } catch {
    creditNoCustomer = true;
  }
  expect("a credit sale with nobody attached is refused", creditNoCustomer);

  // --- repayment ------------------------------------------------------------
  await recordDebtEntry({
    customer_id: wanjiku.id,
    kind: "payment",
    amount: 400,
    payment_method: "cash",
  });
  const afterPayment = await customerDebt(wanjiku.id);
  expect("a repayment reduces the balance", afterPayment?.balance === 260, `${afterPayment?.balance}`);



  // --- THE money rule: credit is not cash, repayments are ------------------
  const creditDay = businessDate();
  const closingWithCredit = await dayTotals(creditDay);

  expect(
    "a credit sale never counts toward cash in the drawer",
    closingWithCredit.cash === beforeCredit.cash,
    `${closingWithCredit.cash} vs ${beforeCredit.cash}`,
  );
  expect(
    "...nor toward M-Pesa",
    closingWithCredit.mpesa === beforeCredit.mpesa,
    `${closingWithCredit.mpesa}`,
  );
  expect(
    "credit is reported on its own line",
    closingWithCredit.creditSales === 660 && closingWithCredit.creditCount === 1,
    `${closingWithCredit.creditSales} / ${closingWithCredit.creditCount}`,
  );
  expect(
    "credit IS included in total sales — the goods really did leave",
    closingWithCredit.total === beforeCredit.total + 660,
    `${closingWithCredit.total} vs ${beforeCredit.total}`,
  );
  expect(
    "a cash repayment IS expected in the drawer",
    closingWithCredit.expectedCash === closingWithCredit.cash + 400,
    `expected=${closingWithCredit.expectedCash} cash=${closingWithCredit.cash}`,
  );
  expect(
    "the repayment is reported separately from sales",
    closingWithCredit.repaidCash === 400 && closingWithCredit.repaidMpesa === 0,
  );

  const repaid = await repaymentsOn(creditDay);
  expect("repaymentsOn agrees with the day totals", repaid.cash === 400 && repaid.mpesa === 0);


  // --- the debtors list -----------------------------------------------------
  const list = await debtors();
  expect("the debtor appears in the list", list.some((d) => d.customer.id === wanjiku.id));
  expect(
    "a settled customer drops off the list entirely",
    !list.some((d) => Math.abs(d.balance) < 0.001),
  );

  const totalsForDebt = await debtTotals([creditDay]);
  expect(
    "shop-wide outstanding matches the sum of balances",
    totalsForDebt.outstanding === 260,
    `${totalsForDebt.outstanding}`,
  );
  expect("new credit given in the period is reported", totalsForDebt.chargedInPeriod === 660);
  expect("repayments in the period are split by method", totalsForDebt.repaidCash === 400);

  // --- write-off ------------------------------------------------------------
  await recordDebtEntry({ customer_id: wanjiku.id, kind: "writeoff", amount: 260 });
  const afterWriteoff = await customerDebt(wanjiku.id);
  expect("a write-off clears the balance", afterWriteoff?.balance === 0, `${afterWriteoff?.balance}`);
  expect(
    "...and stays visible in the history rather than deleting anything",
    afterWriteoff?.totalWrittenOff === 260 && afterWriteoff?.totalCharged === 660,
  );
  expect(
    "a settled customer no longer appears in the debtors list",
    !(await debtors()).some((d) => d.customer.id === wanjiku.id),
  );

  // --- the M-Pesa half of the money rule ------------------------------------
  // A repayment by M-Pesa is a real transaction on the Safaricom statement, so
  // it must be reconcilable. An M-Pesa payment the owner cannot find in the app
  // looks exactly like one that was never recorded. Done on its own customer so
  // it does not disturb the balances asserted above.
  const otieno = await saveCustomer({ name: "Otieno", phone: "0733222444" });
  await checkout({
    lines: [
      {
        product_id: creditStock.id,
        name: creditStock.name,
        unit: "packet",
        unit_price: 165,
        quantity: 1,
      },
    ],
    payment_method: "credit",
    customer_id: otieno.id,
  });
  const beforeMpesaRepay = await dayTotals(creditDay);
  await recordDebtEntry({
    customer_id: otieno.id,
    kind: "payment",
    amount: 60,
    payment_method: "mpesa",
    mpesa_code: "RKJ9N3B7WZ",
  });
  const withMpesaRepay = await dayTotals(creditDay);
  expect(
    "an M-Pesa repayment raises expected M-Pesa",
    withMpesaRepay.expectedMpesa === withMpesaRepay.mpesa + 60,
    `expected=${withMpesaRepay.expectedMpesa} sales=${withMpesaRepay.mpesa}`,
  );
  expect(
    "...and leaves expected CASH untouched",
    withMpesaRepay.expectedCash === beforeMpesaRepay.expectedCash,
    `${withMpesaRepay.expectedCash} vs ${beforeMpesaRepay.expectedCash}`,
  );
  expect(
    "its code is available for ticking off against the Safaricom statement",
    withMpesaRepay.mpesaRepayments.some((e) => e.mpesa_code === "RKJ9N3B7WZ"),
    JSON.stringify(withMpesaRepay.mpesaRepayments.map((e) => e.mpesa_code)),
  );

  // A duplicate phone almost always means the same person, not a new one.
  let dupePhone = false;
  try {
    await saveCustomer({ name: "Someone else", phone: "0722000111" }); // Wanjiku's
  } catch {
    dupePhone = true;
  }
  expect("two customers cannot share a phone number", dupePhone);

  // =======================================================================
  // Part-payment at the till: "pay 200 now, owe 300"
  // =======================================================================
  const { chaseList, remindersFor } = await import("../src/lib/debt");
  const { recordReminder } = await import("../src/lib/store");
  const { normalisePhone, renderTemplate, channelLink, statementText, DEFAULT_TEMPLATE } =
    await import("../src/lib/remind");

  const kamau = await saveCustomer({ name: "Kamau", phone: "0722555777" });
  const partStock = await saveProduct({
    name: "Cooking fat 1kg",
    unit: "packet",
    buying_price: 200,
    selling_price: 250,
    low_stock_threshold: 2,
    opening_quantity: 20,
  });

  const beforePart = await dayTotals(businessDate());
  const partSale = await checkout({
    lines: [
      {
        product_id: partStock.id,
        name: partStock.name,
        unit: "packet",
        unit_price: 250,
        quantity: 2,
      },
    ],
    payment_method: "credit",
    customer_id: kamau.id,
    paid_now: 200,
    paid_now_method: "cash",
  });
  const afterPart = await dayTotals(businessDate());

  expect(
    "a part-payment leaves only the remainder owing",
    (await customerDebt(kamau.id))?.balance === 300,
    `balance=${(await customerDebt(kamau.id))?.balance}`,
  );
  expect(
    "the full 500 still counts as credit given",
    afterPart.creditSales - beforePart.creditSales === 500,
    `${afterPart.creditSales} - ${beforePart.creditSales}`,
  );
  expect(
    "...but only 300 of it is still outstanding",
    afterPart.creditOutstanding - beforePart.creditOutstanding === 300,
    `${afterPart.creditOutstanding} - ${beforePart.creditOutstanding}`,
  );
  // The headline claim of the whole feature: money taken at the counter must
  // show up in the drawer figure, or the shop reads SHORT by exactly that
  // amount and an honest attendant looks like a thief.
  expect(
    "the 200 raises expected cash",
    afterPart.expectedCash - beforePart.expectedCash === 200,
    `${afterPart.expectedCash} - ${beforePart.expectedCash}`,
  );
  expect(
    "it is filed as paid-at-the-till, not as old debt repaid",
    afterPart.paidAtTillCash - beforePart.paidAtTillCash === 200 &&
      afterPart.repaidCash === beforePart.repaidCash,
    `till=${afterPart.paidAtTillCash} old=${afterPart.repaidCash}`,
  );

  // Both facts ride in ONE outbox entry. A payment that reached the server
  // without its charge would briefly show the customer in credit.
  const partOutbox = await db.outbox.where("entity_id").equals(partSale.id).toArray();
  expect(
    "the sale, its charge and the part-payment sync as one unit",
    partOutbox.length === 1 &&
      (partOutbox[0].payload as { sale: { immediate_payment?: { amount: number } } }).sale
        .immediate_payment?.amount === 200,
    JSON.stringify(partOutbox.map((e) => e.kind)),
  );

  // A "part"-payment covering the whole sale is a cash sale wearing a disguise.
  let overPaid = false;
  try {
    await checkout({
      lines: [
        {
          product_id: partStock.id,
          name: partStock.name,
          unit: "packet",
          unit_price: 250,
          quantity: 1,
        },
      ],
      payment_method: "credit",
      customer_id: kamau.id,
      paid_now: 250,
      paid_now_method: "cash",
    });
  } catch {
    overPaid = true;
  }
  expect("a part-payment covering the whole sale is refused", overPaid);

  // The part-payment follows the same rule as everything else M-Pesa: the code
  // is prompted for, never required. What IS still required is the method,
  // because Closing cannot put money in a column it was not told about.
  const partNoCodeSale = await checkout({
      lines: [
        {
          product_id: partStock.id,
          name: partStock.name,
          unit: "packet",
          unit_price: 250,
          quantity: 2,
        },
      ],
    payment_method: "credit",
    customer_id: kamau.id,
    paid_now: 100,
    paid_now_method: "mpesa",
  });
  // Filtered rather than indexed: the app never queries debt_entries by
  // sale_id (Closing already has the day's rows in hand), so adding an index
  // for a test would be adding a schema version for nothing.
  const partNoCodeEntry = (await db.debt_entries.toArray()).find(
    (e) => e.sale_id === partNoCodeSale.id && e.kind === "payment",
  );
  expect(
    "an M-Pesa part-payment records without a code",
    partNoCodeEntry != null && partNoCodeEntry.mpesa_code === null,
    JSON.stringify(partNoCodeEntry?.mpesa_code),
  );

  // =======================================================================
  // The chase
  // =======================================================================
  expect(
    "the reminder log starts empty",
    (await remindersFor(kamau.id)).length === 0,
  );

  const chased = await recordReminder({
    customer_id: kamau.id,
    channel: "whatsapp",
    balance_at_time: 300,
  });
  expect(
    "a reminder records what was owed at the time",
    chased.balance_at_time === 300 && chased.channel === "whatsapp",
  );
  expect(
    "it queues for the server like everything else",
    (await db.outbox.where("entity_id").equals(chased.id).count()) === 1,
  );

  // A promise is a second, separate record — the log is append-only, so
  // "I chased them" and "they said Friday" stay two honest facts.
  const promiseDay = businessDate(new Date(Date.now() + 3 * 86_400_000));
  await recordReminder({
    customer_id: kamau.id,
    channel: "whatsapp",
    balance_at_time: 300,
    promised_date: promiseDay,
  });
  expect(
    "the promise is a new entry, not an edit of the first",
    (await remindersFor(kamau.id)).length === 2,
  );

  const pending = await chaseList();
  const kamauPending = [...pending.due, ...pending.later].find(
    (d) => d.customer.id === kamau.id,
  );
  expect(
    "someone who promised a future day is not on today's list",
    kamauPending?.chase.promisePending === true &&
      pending.due.every((d) => d.customer.id !== kamau.id),
    kamauPending?.chase.reason,
  );

  // Now let the promised day pass. This is the signal the whole queue is for.
  const brokenDay = businessDate(new Date(Date.now() - 2 * 86_400_000));
  await recordReminder({
    customer_id: kamau.id,
    channel: "sms",
    balance_at_time: 300,
    promised_date: brokenDay,
  });
  const afterBroken = await chaseList();
  const kamauBroken = afterBroken.due.find((d) => d.customer.id === kamau.id);
  expect(
    "a broken promise puts them on today's list",
    kamauBroken != null && kamauBroken.chase.promiseBroken,
    kamauBroken?.chase.reason,
  );
  expect(
    "and puts them at the very top of it",
    afterBroken.due[0]?.customer.id === kamau.id,
    afterBroken.due.map((d) => d.customer.name).join(", "),
  );

  // Paying retires the promise. Someone who came back is not still in breach.
  await recordDebtEntry({
    customer_id: kamau.id,
    kind: "payment",
    amount: 100,
    payment_method: "cash",
  });
  const afterPaying = await chaseList();
  const kamauPaid = [...afterPaying.due, ...afterPaying.later].find(
    (d) => d.customer.id === kamau.id,
  );
  expect(
    "paying after a promise clears the broken-promise flag",
    kamauPaid?.chase.promiseBroken === false,
    kamauPaid?.chase.reason,
  );
  expect(
    "the reminder history survives the payment",
    (await remindersFor(kamau.id)).length === 3,
  );

  // A settled customer drops out of the chase entirely.
  const settledBalance = (await customerDebt(kamau.id))?.balance ?? 0;
  await recordDebtEntry({
    customer_id: kamau.id,
    kind: "payment",
    amount: settledBalance,
    payment_method: "cash",
  });
  const afterSettled = await chaseList();
  expect(
    "a settled customer leaves the chase list",
    [...afterSettled.due, ...afterSettled.later].every((d) => d.customer.id !== kamau.id),
  );

  // =======================================================================
  // Phone numbers, messages and statements
  // =======================================================================
  expect(
    "0722… normalises to 254722…",
    normalisePhone("0722 555 777") === "254722555777",
    String(normalisePhone("0722 555 777")),
  );
  expect(
    "+254… and 254… both normalise",
    normalisePhone("+254722555777") === "254722555777" &&
      normalisePhone("254722555777") === "254722555777",
  );
  expect(
    "a bare 722555777 normalises",
    normalisePhone("722555777") === "254722555777",
    String(normalisePhone("722555777")),
  );
  expect(
    "nonsense yields no number rather than a broken link",
    normalisePhone("12345") === null && normalisePhone("") === null && normalisePhone(null) === null,
  );

  const rendered = renderTemplate(DEFAULT_TEMPLATE, {
    name: "Kamau",
    shop: "Duka ya Mama Njeri",
    balance: 300,
    oldestDays: 12,
  });
  expect(
    "the template fills in the name, shop and balance",
    rendered.includes("Kamau") &&
      rendered.includes("Duka ya Mama Njeri") &&
      rendered.includes(money(300)) &&
      !rendered.includes("{"),
    rendered,
  );

  const wa = channelLink("whatsapp", "0722555777", "hello there");
  expect(
    "WhatsApp gets bare international digits and an encoded message",
    wa === "https://wa.me/254722555777?text=hello%20there",
    String(wa),
  );
  expect(
    "no phone number means no link, rather than a link that opens nothing",
    channelLink("whatsapp", null, "x") === null && channelLink("in_person", "0722555777", "x") === null,
  );

  const kamauLedger = await db.debt_entries.where("customer_id").equals(kamau.id).toArray();
  const statement = statementText(
    (await customerDebt(kamau.id))!,
    kamauLedger,
    "Duka ya Mama Njeri",
    (d) => d,
  );
  expect(
    "a statement lists every entry, which is what settles an argument",
    kamauLedger.every((e) => statement.includes(money(e.amount))) &&
      statement.includes("BALANCE NOW"),
    statement,
  );

  // =======================================================================
  // Nothing is lost: discarding archives instead of deleting
  // =======================================================================
  const { discardOutboxEntry, requeueDiscarded, unsyncedReport, isMoneyEntry } = await import(
    "../src/lib/sync"
  );
  const doomed = (await db.outbox.where("kind").equals("sale").toArray())[0];
  expect("a sale is recognised as money", isMoneyEntry(doomed));

  const beforeDiscard = await db.outbox.count();
  await discardOutboxEntry(doomed.seq!);
  expect(
    "discarding takes it out of the queue",
    (await db.outbox.count()) === beforeDiscard - 1,
  );
  expect(
    "...but keeps it, because a discarded sale exists on no other device",
    (await db.discarded.count()) === 1,
  );
  const archivedRow = (await db.discarded.toArray())[0];
  expect(
    "the archive is readable without decoding a payload",
    archivedRow.summary.startsWith("Sale of"),
    archivedRow.summary,
  );

  const report = await unsyncedReport();
  expect(
    "the export names both the queue and the archive",
    report.text.includes("NOT YET SENT") && report.text.includes("GIVEN UP ON"),
    report.text.slice(0, 120),
  );

  await requeueDiscarded(archivedRow.id);
  expect(
    "re-queueing puts it back where it belongs",
    (await db.discarded.count()) === 0 && (await db.outbox.count()) === beforeDiscard,
  );

  // =======================================================================
  // Refunds — reversing a sale without editing it
  // =======================================================================
  const { refundSale, refundedSaleIds } = await import("../src/lib/store");

  const refProd = await saveProduct({
    name: "Blue Band 250g",
    unit: "pc",
    buying_price: 180,
    selling_price: 220,
    low_stock_threshold: 2,
    opening_quantity: 30,
  });

  const stockBeforeRefund = await stockOf(refProd.id);
  const beforeRefund = await dayTotals(businessDate());
  const refCashSale = await checkout({
    lines: [
      { product_id: refProd.id, name: refProd.name, unit: "pc", unit_price: 220, quantity: 2 },
    ],
    payment_method: "cash",
    amount_tendered: 500,
  });

  const refund = await refundSale({ sale_id: refCashSale.id, reason: "mis_key" });
  const afterRefund = await dayTotals(businessDate());

  expect("a refund reverses the whole sale", refund.amount === 440, `${refund.amount}`);
  expect(
    "the goods come back on the shelf",
    (await stockOf(refProd.id)) === stockBeforeRefund,
    `${await stockOf(refProd.id)} vs ${stockBeforeRefund}`,
  );

  // THE claim. A mis-keyed sale used to leave the drawer reading short by
  // exactly the mistake, which is indistinguishable from theft.
  expect(
    "expected cash returns to where it was before the mistake",
    afterRefund.expectedCash === beforeRefund.expectedCash,
    `${afterRefund.expectedCash} vs ${beforeRefund.expectedCash}`,
  );
  expect(
    "the sale itself is untouched — nothing is deleted or edited",
    (await db.sales.get(refCashSale.id))?.total === 440,
  );
  expect(
    "gross sales still include it; the refund is a separate line",
    afterRefund.total - beforeRefund.total === 440 && afterRefund.refundedTotal === 440,
    `total+${afterRefund.total - beforeRefund.total} refunds=${afterRefund.refundedTotal}`,
  );
  expect(
    "everything rides in one outbox entry",
    (await db.outbox.where("entity_id").equals(refund.id).count()) === 1,
  );
  expect("refundedSaleIds marks the sale", (await refundedSaleIds()).has(refCashSale.id));

  let twice = false;
  try {
    await refundSale({ sale_id: refCashSale.id, reason: "returned" });
  } catch {
    twice = true;
  }
  expect("the same sale cannot be refunded twice", twice);

  // --- an M-Pesa sale is refunded in CASH -----------------------------------
  const beforeMpesaRefund = await dayTotals(businessDate());
  const refMpesaSale = await checkout({
    lines: [
      { product_id: refProd.id, name: refProd.name, unit: "pc", unit_price: 220, quantity: 1 },
    ],
    payment_method: "mpesa",
    mpesa_code: "RKX8M2P4QN",
  });
  const midMpesa = await dayTotals(businessDate());
  await refundSale({ sale_id: refMpesaSale.id, reason: "returned" });
  const afterMpesaRefund = await dayTotals(businessDate());

  // The app has no Daraja and cannot send M-Pesa, so the money leaves the
  // DRAWER. Taking it off expected M-Pesa instead would leave the drawer
  // reading over by 220 and the Safaricom statement disagreeing.
  expect(
    "refunding an M-Pesa sale takes cash out of the drawer",
    afterMpesaRefund.expectedCash === beforeMpesaRefund.expectedCash - 220,
    `${afterMpesaRefund.expectedCash} vs ${beforeMpesaRefund.expectedCash}`,
  );
  expect(
    "...and leaves expected M-Pesa exactly where the sale put it",
    afterMpesaRefund.expectedMpesa === midMpesa.expectedMpesa,
    `${afterMpesaRefund.expectedMpesa} vs ${midMpesa.expectedMpesa}`,
  );

  // --- damaged goods come back AND are written off --------------------------
  const dmgBefore = await stockOf(refProd.id);
  const dmgSale = await checkout({
    lines: [
      { product_id: refProd.id, name: refProd.name, unit: "pc", unit_price: 220, quantity: 2 },
    ],
    payment_method: "cash",
    amount_tendered: 440,
  });
  await refundSale({ sale_id: dmgSale.id, reason: "damaged" });

  expect(
    "damaged goods leave sellable stock unchanged",
    (await stockOf(refProd.id)) === dmgBefore - 2,
    `${await stockOf(refProd.id)} vs ${dmgBefore - 2}`,
  );
  // Two movements, not a silent no-op: the shrink report needs the damage half,
  // and "the goods came back" is a separate fact worth keeping.
  const dmgMoves = (await db.stock_movements.toArray()).filter((m) => m.sale_id === dmgSale.id);
  expect(
    "it is recorded as a return AND a damage, not as nothing",
    dmgMoves.some((m) => m.reason === "return" && m.delta === 2) &&
      dmgMoves.some((m) => m.reason === "damage" && m.delta === -2),
    dmgMoves.map((m) => `${m.reason}:${m.delta}`).join(", "),
  );

  // --- a credit sale is REVERSED, not paid out ------------------------------
  const { customerDebt: debtOf } = await import("../src/lib/debt");
  const mwangi = await saveCustomer({ name: "Mwangi", phone: "0711333555" });
  const creditForRefund = await checkout({
    lines: [
      { product_id: refProd.id, name: refProd.name, unit: "pc", unit_price: 220, quantity: 3 },
    ],
    payment_method: "credit",
    customer_id: mwangi.id,
  });
  expect("the credit sale creates the debt", (await debtOf(mwangi.id))?.balance === 660);

  const beforeCreditRefund = await dayTotals(businessDate());
  const creditRefund = await refundSale({ sale_id: creditForRefund.id, reason: "returned" });
  const afterCreditRefund = await dayTotals(businessDate());

  expect("a credit refund settles as credit, not cash", creditRefund.settled_as === "credit");
  expect(
    "reversing a credit sale moves NO cash",
    afterCreditRefund.expectedCash === beforeCreditRefund.expectedCash,
    `${afterCreditRefund.expectedCash} vs ${beforeCreditRefund.expectedCash}`,
  );
  const afterReversal = await debtOf(mwangi.id);
  expect("the debt drops instead", afterReversal?.balance === 0, `${afterReversal?.balance}`);
  // The reason `reversal` exists as its own kind: goods coming back is not a
  // loss, and counting it as one would inflate the bad-debt figure the Debts
  // screen exists to keep honest.
  expect(
    "and it is recorded as a reversal, NOT as a write-off",
    afterReversal?.totalReversed === 660 && afterReversal?.totalWrittenOff === 0,
    `reversed=${afterReversal?.totalReversed} writtenOff=${afterReversal?.totalWrittenOff}`,
  );

  // --- an attendant cannot refund -------------------------------------------
  const ownerSession = (await metaGet<Session>(META_KEYS.session))!;
  await metaSet(META_KEYS.session, { ...ownerSession, role: "attendant" });
  const attSale = await checkout({
    lines: [
      { product_id: refProd.id, name: refProd.name, unit: "pc", unit_price: 220, quantity: 1 },
    ],
    payment_method: "cash",
    amount_tendered: 220,
  });
  let attBlocked = false;
  try {
    await refundSale({ sale_id: attSale.id, reason: "mis_key" });
  } catch {
    attBlocked = true;
  }
  await metaSet(META_KEYS.session, ownerSession);
  expect("an attendant cannot refund a sale", attBlocked);

  // --- a refund is money, so it is never silently discarded -----------------
  const refundEntry = (await db.outbox.where("kind").equals("refund").toArray())[0];
  expect(
    "a refund counts as money in the outbox",
    refundEntry != null && isMoneyEntry(refundEntry),
  );

  // =======================================================================
  // The M-Pesa confirmation code is optional
  // =======================================================================
  // Requiring it never produced more codes. It produced sales recorded as cash,
  // or not recorded at all — the two least accurate outcomes available. The
  // control moved from a block to visibility: Closing reports what cannot be
  // verified rather than refusing to record it.
  //
  // Placed last, and measured as deltas, because an extra sale shifts every
  // absolute total after it.
  const codeDayBefore = await dayTotals(businessDate());
  const noCodeSale = await checkout({
    lines: [{ product_id: unga.id, name: unga.name, unit: "packet", unit_price: 200, quantity: 1 }],
    payment_method: "mpesa",
    mpesa_code: "  ",
  });
  const codeDayAfter = await dayTotals(businessDate());

  expect(
    "an M-Pesa sale records without a code, storing NULL rather than a blank",
    noCodeSale.mpesa_code === null,
    JSON.stringify(noCodeSale.mpesa_code),
  );
  expect(
    "it still counts as M-Pesa money",
    codeDayAfter.mpesa - codeDayBefore.mpesa === 200,
    `${codeDayAfter.mpesa} - ${codeDayBefore.mpesa}`,
  );
  expect(
    "...and Closing flags it as unverifiable against the statement",
    codeDayAfter.mpesaWithoutCode - codeDayBefore.mpesaWithoutCode === 1,
    `${codeDayAfter.mpesaWithoutCode} vs ${codeDayBefore.mpesaWithoutCode}`,
  );
  expect(
    "it still appears in the tick-off list, so it cannot be quietly forgotten",
    codeDayAfter.mpesaSales.some((s) => s.id === noCodeSale.id),
  );

  const repayNoCode = await recordDebtEntry({
    customer_id: wanjiku.id,
    kind: "payment",
    amount: 100,
    payment_method: "mpesa",
  });
  const afterRepayNoCode = await dayTotals(businessDate());
  expect(
    "an M-Pesa repayment records without a code too",
    repayNoCode.mpesa_code === null,
    JSON.stringify(repayNoCode.mpesa_code),
  );
  expect(
    "both the sale and the repayment are counted as unverifiable",
    afterRepayNoCode.mpesaWithoutCode - codeDayBefore.mpesaWithoutCode === 2,
    `${afterRepayNoCode.mpesaWithoutCode} vs ${codeDayBefore.mpesaWithoutCode}`,
  );

  // =======================================================================
  // Product photos
  // =======================================================================
  // prepareImage() itself needs a canvas and is exercised by the browser suite;
  // what is tested here is everything after it — storage, the size ceiling, and
  // the queue behaviour that decides whether a shop on 2G can actually sync.
  const { saveProductImage, removeProductImage } = await import("../src/lib/store");
  const { MAX_IMAGE_BYTES, formatBytes } = await import("../src/lib/image");

  const fakePhoto = (marker: string, bytes = 12000) => ({
    data: `data:image/webp;base64,${marker.repeat(64)}`,
    width: 256,
    height: 256,
    bytes,
  });

  const photoProduct = await saveProduct({
    name: "Tomatoes loose",
    unit: "kg",
    buying_price: 60,
    selling_price: 90,
    low_stock_threshold: 2,
  });

  await saveProductImage(photoProduct.id, fakePhoto("A"));
  const storedPhoto = await db.product_images.get(photoProduct.id);
  expect("a photo is stored against its product", storedPhoto?.data.includes("A") === true);
  expect(
    "it queues for the server",
    (await db.outbox.where("kind").equals("product_image").count()) === 1,
  );

  // Photographing the same product four times offline must not queue four
  // payloads of ~15KB each when only the last one matters. On a slow
  // connection that difference is the whole point.
  await saveProductImage(photoProduct.id, fakePhoto("B"));
  await saveProductImage(photoProduct.id, fakePhoto("C"));
  await saveProductImage(photoProduct.id, fakePhoto("D"));
  const queued = await db.outbox.where("kind").equals("product_image").toArray();
  expect(
    "re-photographing collapses to a single queued payload",
    queued.length === 1,
    `${queued.length} queued`,
  );
  expect(
    "...and the one that survives is the newest",
    (queued[0].payload as { data: string }).data.includes("D"),
  );
  expect(
    "the stored photo is the newest too",
    (await db.product_images.get(photoProduct.id))?.data.includes("D") === true,
  );

  // The ceiling is enforced client-side as well as in the database, because a
  // browser that cannot encode WebP silently falls back to something far
  // larger and would otherwise fill the shop's own database.
  let tooBig = false;
  try {
    await saveProductImage(photoProduct.id, fakePhoto("E", MAX_IMAGE_BYTES + 1));
  } catch {
    tooBig = true;
  }
  expect("an oversized photo is refused before it is stored", tooBig);
  expect(
    "...and the good photo is untouched by the refusal",
    (await db.product_images.get(photoProduct.id))?.data.includes("D") === true,
  );

  // Removing sends an empty payload rather than deleting nothing: the server
  // has to be told, or the photo comes straight back on the next pull.
  await removeProductImage(photoProduct.id);
  expect(
    "removing clears it locally",
    (await db.product_images.get(photoProduct.id)) === undefined,
  );
  const afterRemoval = await db.outbox.where("kind").equals("product_image").toArray();
  expect(
    "...and tells the server, rather than silently forgetting",
    afterRemoval.length === 1 && (afterRemoval[0].payload as { data: unknown }).data === null,
  );

  // A photo is not money. Discarding one must never carry the warning that a
  // stranded sale does.
  expect(
    "a photo is not treated as money in the outbox",
    !isMoneyEntry(afterRemoval[0]),
  );

  expect("byte sizes read in KB for a human", formatBytes(12000) === "11.7 KB", formatBytes(12000));

  // =======================================================================
  // Batches, expiry and FEFO dispensing
  // =======================================================================
  const { saveBatch } = await import("../src/lib/store");
  const { allocateFefo, batchStock, expiringStock, expiryState, stockOfProduct, salesOfBatch } =
    await import("../src/lib/batches");

  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  expect("yesterday is expired", expiryState(day(-1)) === "expired");
  expect("in 10 days is critical", expiryState(day(10)) === "critical");
  expect("in 60 days is soon", expiryState(day(60)) === "soon");
  expect("in 200 days is ok", expiryState(day(200)) === "ok");

  const amox = await saveProduct({
    name: "Amoxil 500mg",
    unit: "pc",
    buying_price: 8,
    selling_price: 15,
    low_stock_threshold: 20,
    track_batches: true,
    is_pom: true,
    portions: [{ name: "Strip of 10", factor: 10, price: 130 }],
  });

  // Deliberately received in the WRONG order: the batch that arrives second
  // expires first. FIFO would dispense the wrong one; FEFO is the whole point.
  const later = await saveBatch({
    product_id: amox.id,
    batch_no: "AMX-LATE",
    expiry_date: day(400),
  });
  await recordMovement({
    product_id: amox.id,
    delta: 100,
    reason: "restock",
    buying_price: 8,
    batch_id: later.id,
  });
  const sooner = await saveBatch({
    product_id: amox.id,
    batch_no: "AMX-SOON",
    expiry_date: day(45),
  });
  await recordMovement({
    product_id: amox.id,
    delta: 30,
    reason: "restock",
    buying_price: 8,
    batch_id: sooner.id,
  });

  const shelf = await stockOfProduct(amox.id);
  expect(
    "batch quantities are derived from the movements, not stored",
    shelf.length === 2 &&
      shelf.find((b) => b.batch.id === sooner.id)?.quantity === 30 &&
      shelf.find((b) => b.batch.id === later.id)?.quantity === 100,
    JSON.stringify(shelf.map((b) => [b.batch.batch_no, b.quantity])),
  );
  expect(
    "the nearest expiry sorts first even though it arrived last",
    shelf[0].batch.id === sooner.id,
    shelf[0].batch.batch_no,
  );

  // Selling a PORTION: one strip of 10 must come out of the nearest-expiry
  // batch in base units, not in strips.
  await checkout({
    lines: [
      {
        product_id: amox.id,
        name: amox.name,
        unit: "pc",
        unit_price: 130,
        quantity: 1,
        portion_id: null,
        portion_name: "Strip of 10",
        portion_factor: 10,
      },
    ],
    payment_method: "cash",
    amount_tendered: 130,
  });

  const afterStrip = await stockOfProduct(amox.id);
  expect(
    "a partial pack is dispensed from the nearest-expiry batch",
    afterStrip.find((b) => b.batch.id === sooner.id)?.quantity === 20 &&
      afterStrip.find((b) => b.batch.id === later.id)?.quantity === 100,
    JSON.stringify(afterStrip.map((b) => [b.batch.batch_no, b.quantity])),
  );

  // A quantity larger than the nearest batch must SPAN batches rather than
  // failing or silently taking it all from one.
  await checkout({
    lines: [{ product_id: amox.id, name: amox.name, unit: "pc", unit_price: 15, quantity: 30 }],
    payment_method: "cash",
    amount_tendered: 450,
  });
  const afterSpan = await stockOfProduct(amox.id);
  expect(
    "a sale bigger than one batch spans into the next",
    afterSpan.find((b) => b.batch.id === sooner.id)?.quantity === 0 &&
      afterSpan.find((b) => b.batch.id === later.id)?.quantity === 90,
    JSON.stringify(afterSpan.map((b) => [b.batch.batch_no, b.quantity])),
  );

  // --- expired stock is never dispensed -------------------------------------
  const expiredProd = await saveProduct({
    name: "Old Syrup 100ml",
    unit: "pc",
    buying_price: 50,
    selling_price: 90,
    low_stock_threshold: 2,
    track_batches: true,
  });
  const deadBatch = await saveBatch({
    product_id: expiredProd.id,
    batch_no: "SYR-OLD",
    expiry_date: day(-30),
  });
  await recordMovement({
    product_id: expiredProd.id,
    delta: 40,
    reason: "restock",
    buying_price: 50,
    batch_id: deadBatch.id,
  });

  // THE claim of the whole feature. The stock exists, the count says 40, and
  // the till must still refuse — quietly dispensing it is the failure this was
  // built to prevent.
  let expiredBlocked = false;
  try {
    await checkout({
      lines: [
        {
          product_id: expiredProd.id,
          name: expiredProd.name,
          unit: "pc",
          unit_price: 90,
          quantity: 1,
        },
      ],
      payment_method: "cash",
      amount_tendered: 90,
    });
  } catch {
    expiredBlocked = true;
  }
  expect("expired stock cannot be dispensed, even though the count says 40", expiredBlocked);
  expect(
    "...and the refusal leaves the stock untouched rather than half-selling it",
    (await stockOfProduct(expiredProd.id))[0].quantity === 40,
  );

  const alloc = allocateFefo(await stockOfProduct(expiredProd.id), 1);
  expect(
    "FEFO reports nothing available rather than offering the expired batch",
    alloc.available === 0 && alloc.short === 1 && alloc.lines.length === 0,
    JSON.stringify(alloc),
  );

  // --- stock that predates batch tracking stays sellable ---------------------
  // Otherwise turning the feature on for a product already on the shelf would
  // make it unsellable, and the shop would simply turn it back off.
  const legacyAlloc = allocateFefo([], 5, { unbatched: 25 });
  expect(
    "pre-batch stock is usable, and marked as having no known expiry",
    legacyAlloc.short === 0 &&
      legacyAlloc.fromUnbatched === 5 &&
      legacyAlloc.lines[0].batch_id === null,
    JSON.stringify(legacyAlloc),
  );

  // ...but only AFTER every dated batch, so the dated stock drains first.
  const mixed = batchStock(
    [
      {
        id: "b1",
        shop_id: SESSION.shop_id,
        product_id: "p1",
        batch_no: "B1",
        expiry_date: day(30),
        note: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        synced_at: null,
      },
    ],
    [
      {
        id: "m1",
        shop_id: SESSION.shop_id,
        product_id: "p1",
        user_id: SESSION.user_id,
        delta: 4,
        reason: "restock",
        buying_price: null,
        total_cost: null,
        sale_id: null,
        batch_id: "b1",
        note: null,
        note_ref: null,
        created_at: new Date().toISOString(),
        synced_at: null,
      },
    ],
  );
  const mixedAlloc = allocateFefo(mixed, 6, { unbatched: 10 });
  expect(
    "dated stock is used before undated stock",
    mixedAlloc.lines[0].batch_id === "b1" &&
      mixedAlloc.lines[0].quantity === 4 &&
      mixedAlloc.lines[1].batch_id === null &&
      mixedAlloc.lines[1].quantity === 2,
    JSON.stringify(mixedAlloc.lines),
  );

  // --- the expiry report and the recall question ----------------------------
  const expiring = await expiringStock();
  expect(
    "expired stock sorts to the very top of the expiry list",
    expiring[0]?.batch.batch_no === "SYR-OLD",
    expiring.map((r) => r.batch.batch_no).join(", "),
  );
  expect(
    "a batch with nothing left is not reported as a problem",
    !expiring.some((r) => r.batch.batch_no === "AMX-SOON"),
    expiring.map((r) => r.batch.batch_no).join(", "),
  );
  expect(
    "a batch expiring beyond the window is not reported either",
    !expiring.some((r) => r.batch.batch_no === "AMX-LATE"),
  );

  // The recall question: which sales touched this batch.
  const touched = await salesOfBatch(sooner.id);
  expect(
    "every sale that touched a batch can be found again",
    touched.length === 2 && touched.reduce((t, r) => t + r.quantity, 0) === 30,
    JSON.stringify(touched),
  );

  // =======================================================================
  // Drill-down reports: product table, stock card, trading account
  // =======================================================================
  const { productLines, stockCard, tradingAccount } = await import("../src/lib/report-detail");
  const { buildPeriod: buildPeriodFn } = await import("../src/lib/reports");
  const todayPeriod = buildPeriodFn("day", businessDate());

  const repProd = await saveProduct({
    name: "Report Test Soap",
    unit: "pc",
    buying_price: 40,
    selling_price: 70,
    low_stock_threshold: 5,
    opening_quantity: 100,
  });
  await recordMovement({ product_id: repProd.id, delta: 20, reason: "restock", buying_price: 40 });
  await checkout({
    lines: [
      { product_id: repProd.id, name: repProd.name, unit: "pc", unit_price: 70, quantity: 8 },
    ],
    payment_method: "cash",
    amount_tendered: 560,
  });
  await recordAdjustment({ product_id: repProd.id, reason: "damage", value: 5 });

  const repRows = await productLines(todayPeriod);
  const row = repRows.find((r) => r.product_id === repProd.id)!;

  // The identity the whole report rests on. If this drifts, every figure
  // downstream is quietly wrong.
  expect(
    "opening + received - sold - lost = remaining",
    Math.abs(row.discrepancy) < 0.001,
    `discrepancy=${row.discrepancy}`,
  );
  expect(
    "received counts the opening stock and the restock",
    row.received === 120,
    `received=${row.received}`,
  );
  expect("sold is counted in the product's own unit", row.sold === 8, `sold=${row.sold}`);
  expect("damage counts as lost, not as sold", row.lost === 5, `lost=${row.lost}`);
  expect(
    "remaining matches the shelf",
    row.remaining === 107,
    `remaining=${row.remaining}`,
  );
  expect(
    "revenue and profit use the cost recorded at the moment of sale",
    row.revenue === 560 && row.profit === 240,
    `revenue=${row.revenue} profit=${row.profit}`,
  );
  expect(
    "stock left is valued at cost, not at retail",
    row.remainingValue === 107 * 40,
    `${row.remainingValue}`,
  );

  // --- the stock card ---------------------------------------------------------
  const card = (await stockCard(repProd.id, todayPeriod))!;
  expect(
    "the stock card opens where the period opened",
    card.opening === row.opening,
    `${card.opening} vs ${row.opening}`,
  );
  expect(
    "the running balance ends exactly at the closing balance",
    card.entries.length > 0 &&
      card.entries[card.entries.length - 1].balance === card.closing,
    `last=${card.entries[card.entries.length - 1]?.balance} closing=${card.closing}`,
  );
  expect(
    "every movement in the period appears on the card",
    // opening stock, restock, sale, damage
    card.entries.length === 4,
    `${card.entries.length} entries`,
  );
  expect(
    "a sale line can be traced back to its transaction total",
    card.entries.some((e) => e.movement.reason === "sale" && e.saleTotal === 560),
  );

  // --- the trading account ----------------------------------------------------
  const acc = await tradingAccount(todayPeriod);
  expect(
    "net sales is sales less refunds",
    acc.netSales === round2(acc.sales - acc.refunds),
    `${acc.netSales} vs ${acc.sales} - ${acc.refunds}`,
  );
  expect(
    "gross profit is net sales less cost of goods",
    acc.grossProfit === round2(acc.netSales - acc.costOfGoods),
    `${acc.grossProfit}`,
  );
  expect(
    "trading profit deducts stock losses and bad debt from gross profit",
    acc.tradingProfit === round2(acc.grossProfit - acc.stockLosses - acc.badDebt),
    `${acc.tradingProfit}`,
  );
  // Valuing a loss at retail would overstate it — the shop is out what it paid.
  expect(
    "stock losses are valued at cost, not at the price they might have fetched",
    acc.stockLosses >= 5 * 40,
    `${acc.stockLosses}`,
  );
  expect(
    "a period with no activity reports zeroes rather than dividing by zero",
    (await tradingAccount(buildPeriodFn("day", "2020-01-01"))).grossMarginPct === 0,
  );

  // A reversal is goods coming back, not a loss. Counting it as bad debt would
  // inflate the very figure the Debts screen exists to keep honest. There ARE
  // write-offs in this suite, so the claim is not "bad debt is zero" — it is
  // "bad debt counts write-offs and nothing else".
  const periodEntries = await db.debt_entries
    .where("business_date")
    .anyOf(todayPeriod.dates)
    .toArray();
  const writeoffs = round2(
    periodEntries.filter((e) => e.kind === "writeoff").reduce((t, e) => t + e.amount, 0),
  );
  const reversals = periodEntries.filter((e) => e.kind === "reversal");
  expect(
    "bad debt counts write-offs only, and reversals exist to prove it excludes them",
    reversals.length > 0 && acc.badDebt === writeoffs && writeoffs > 0,
    `badDebt=${acc.badDebt} writeoffs=${writeoffs} reversals=${reversals.length}`,
  );

  // --- a past day is empty, and today's figures are untouched -------------
  const yesterday = businessDate(new Date(Date.now() - 86_400_000));
  const past = await dayTotals(yesterday);
  expect("a day with no sales reads zero, not an error",
    past.cash === 0 && past.mpesa === 0 && past.count === 0);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL  unexpected error:", e);
  process.exit(1);
});
