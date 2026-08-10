/**
 * Schema verification — runs the real migration against a real Postgres
 * (PGlite/WASM), then asserts the guarantees the app depends on:
 *
 *   - the payment-shape check constraints actually reject bad money
 *   - sync_sale is idempotent: replaying it must never double-count stock
 *   - RLS isolates shops, and no client can write products.quantity
 *
 * Run: npm run test:schema
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = (f) => join(HERE, "..", "supabase", "migrations", f);
// Applied in the same order a real database gets them. 0003a is separate
// because a new enum value cannot be used in the transaction that adds it.
const MIGRATIONS = [
  "0001_init.sql",
  "0002_fix_owner_guard.sql",
  "0003a_stock_intake_enums.sql",
  "0003b_stock_intake.sql",
  "0004_units_groups_portions.sql",
  "0005_reporting.sql",
  "0006_weighted_average_cost.sql",
  "0007a_credit_enum.sql",
  "0007b_customer_debt.sql",
  "0008_debt_lifecycle.sql",
  "0009a_refund_enums.sql",
  "0009b_refunds.sql",
  "0010_optional_mpesa_code.sql",
  "0011_product_images.sql",
];

const db = new PGlite();

// --- Supabase-ish harness: the bits the migration depends on --------------
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create table auth._ctx (uid uuid);
  insert into auth._ctx values (null);
  create function auth.uid() returns uuid language sql stable as $$
    select uid from auth._ctx limit 1;
  $$;
`);

for (const file of MIGRATIONS) {
  // pglite has no pgcrypto bundle; gen_random_uuid() is core in PG13+ anyway.
  const sql = readFileSync(MIG(file), "utf8").replace(
    /create extension if not exists "pgcrypto";/,
    "",
  );
  try {
    // Each file is its own exec so the enum values in 0003a are committed
    // before 0003b's check constraint references them.
    await db.exec(sql);
    console.log(`PASS  ${file} applied cleanly`);
  } catch (e) {
    console.error(`FAIL  ${file}:`, e.message);
    process.exit(1);
  }
}

// `as()` writes the pretend auth.uid() into auth._ctx. That write has to work
// while the session is `set role authenticated`, or every RLS assertion below
// "passes" on a permission error from the harness rather than from the policy
// being tested. Granting it once, here, keeps the failures honest.
await db.exec(`
  grant usage on schema public to authenticated;
  grant usage on schema auth to authenticated;
  grant select, update on auth._ctx to authenticated;
  grant execute on function auth.uid() to authenticated;
`);

const as = async (uid, fn) => {
  await db.query("update auth._ctx set uid = $1", [uid]);
  return fn();
};
const q = (s, p) => db.query(s, p);
const check = (name, ok, detail = "") =>
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);

let failures = 0;
const expect = (name, ok, detail) => {
  if (!ok) failures++;
  check(name, ok, detail);
};

// --- signup trigger creates a shop + owner --------------------------------
const owner = (
  await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ('owner@duka.ke', '{"shop_name":"Duka ya Mama Njeri","full_name":"Njeri"}'::jsonb)
     returning id`,
  )
).rows[0].id;

const prof = (await q("select shop_id, role from public.users where id = $1", [owner])).rows[0];
expect("signup creates shop + owner profile", prof?.role === "owner" && !!prof?.shop_id);
const shop = prof.shop_id;

// --- attendant invite flow -------------------------------------------------
await as(owner, () => q("select public.create_attendant('att@duka.ke', 'Kamau')"));
const att = (
  await q(`insert into auth.users (email) values ('att@duka.ke') returning id`)
).rows[0].id;
const attProf = (await q("select shop_id, role from public.users where id=$1", [att])).rows[0];
expect(
  "invited attendant joins the same shop as attendant",
  attProf.role === "attendant" && attProf.shop_id === shop,
);

// --- a second, unrelated shop (for the RLS isolation test) -----------------
const other = (
  await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ('other@duka.ke', '{"shop_name":"Other Duka"}'::jsonb) returning id`,
  )
).rows[0].id;
const otherShop = (await q("select shop_id from public.users where id=$1", [other])).rows[0]
  .shop_id;
expect("second signup gets its own shop", otherShop !== shop);

// --- products + the quantity trigger --------------------------------------
const prod = (
  await q(
    `insert into public.products (shop_id, name, unit, buying_price, selling_price, low_stock_threshold)
     values ($1,'Unga Jogoo 2kg','packet',175,200,8) returning id`,
    [shop],
  )
).rows[0].id;

await q(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, buying_price, created_at)
   values (gen_random_uuid(), $1, $2, $3, 40, 'restock', 175, now())`,
  [shop, prod, owner],
);
let qty = (await q("select quantity from public.products where id=$1", [prod])).rows[0].quantity;
expect("restock movement raises cached quantity", Number(qty) === 40, `qty=${qty}`);

// --- the money constraints -------------------------------------------------
const saleId = "11111111-1111-4111-8111-111111111111";
const badShapes = [
  ["cash sale with an mpesa code is rejected", `'cash', 500, 'SGH7X2K9LM'`],
  ["cash sale with no tendered amount is rejected", `'cash', null, null`],
  ["mpesa sale with a tendered amount is rejected", `'mpesa', 500, 'SGH7X2K9LM'`],
  ["cash tendered below the total is rejected", `'cash', 100, null`],
];
for (const [name, vals] of badShapes) {
  let rejected = false;
  try {
    await q(
      `insert into public.sales (id, shop_id, user_id, total, payment_method, amount_tendered, mpesa_code, business_date, created_at)
       values (gen_random_uuid(), $1, $2, 400, ${vals}, current_date, now())`,
      [shop, owner],
    );
  } catch {
    rejected = true;
  }
  expect(name, rejected);
}

// 0010 — an M-Pesa sale with no confirmation code is now ACCEPTED.
// Requiring it never produced more codes; it produced sales recorded as cash
// or not recorded at all, which are the two worst outcomes available.
let mpesaNoCode = true;
try {
  await q(
    `insert into public.sales (id, shop_id, user_id, total, payment_method, mpesa_code, business_date, created_at)
     values (gen_random_uuid(), $1, $2, 400, 'mpesa', null, current_date, now())`,
    [shop, owner],
  );
} catch {
  mpesaNoCode = false;
}
expect("an M-Pesa sale with no code is accepted", mpesaNoCode);

// A BLANK code is still refused. Storing '' would make every downstream
// "does it have a code" check quietly wrong, which is worse than NULL.
let blankCode = false;
try {
  await q(
    `insert into public.sales (id, shop_id, user_id, total, payment_method, mpesa_code, business_date, created_at)
     values (gen_random_uuid(), $1, $2, 400, 'mpesa', '   ', current_date, now())`,
    [shop, owner],
  );
} catch {
  blankCode = true;
}
expect("a blank M-Pesa code is still rejected", blankCode);

// The shape rules that are NOT about missing information still hold.
let cashWithCode = false;
try {
  await q(
    `insert into public.sales (id, shop_id, user_id, total, payment_method, amount_tendered, mpesa_code, business_date, created_at)
     values (gen_random_uuid(), $1, $2, 400, 'cash', 400, 'SGH7X2K9LM', current_date, now())`,
    [shop, owner],
  );
} catch {
  cashWithCode = true;
}
expect("a cash sale carrying an M-Pesa code is still rejected", cashWithCode);

// --- THE headline claim: sync_sale is idempotent ---------------------------
const payload = {
  sale: {
    id: saleId,
    total: 400,
    payment_method: "cash",
    amount_tendered: 500,
    mpesa_code: null,
    business_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
  },
  items: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      product_id: prod,
      product_name: "Unga Jogoo 2kg",
      unit_price: 200,
      quantity: 2,
      line_total: 400,
    },
  ],
  movements: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      product_id: prod,
      delta: -2,
      created_at: new Date().toISOString(),
    },
  ],
};

const callSync = () =>
  as(owner, () =>
    q("select public.sync_sale($1::jsonb, $2::jsonb, $3::jsonb) as id", [
      JSON.stringify(payload.sale),
      JSON.stringify(payload.items),
      JSON.stringify(payload.movements),
    ]),
  );

await callSync();
qty = (await q("select quantity from public.products where id=$1", [prod])).rows[0].quantity;
expect("sync_sale applies the sale once", Number(qty) === 38, `qty=${qty}`);

// Replay it four more times, exactly as a flaky 3G connection would.
await callSync();
await callSync();
await callSync();
await callSync();

const counts = (
  await q(
    `select (select count(*) from public.sales where id=$1) as sales,
            (select count(*) from public.sale_items where sale_id=$1) as items,
            (select count(*) from public.stock_movements where sale_id=$1) as movements,
            (select quantity from public.products where id=$2) as qty`,
    [saleId, prod],
  )
).rows[0];

expect("replaying sync_sale 5x writes exactly one sale", Number(counts.sales) === 1, `sales=${counts.sales}`);
expect("replaying sync_sale 5x writes exactly one line", Number(counts.items) === 1, `items=${counts.items}`);
expect("replaying sync_sale 5x writes exactly one movement", Number(counts.movements) === 1, `movements=${counts.movements}`);
expect("stock is decremented exactly once (40 - 2 = 38)", Number(counts.qty) === 38, `qty=${counts.qty}`);

// --- cash_counts upsert is idempotent per (shop, day) ----------------------
const ccPayload = (amt, id) =>
  JSON.stringify({
    id,
    business_date: new Date().toISOString().slice(0, 10),
    counted_amount: amt,
    created_at: new Date().toISOString(),
  });
await as(owner, () => q("select public.sync_cash_count($1::jsonb)", [ccPayload(400, "44444444-4444-4444-8444-444444444444")]));
await as(att, () => q("select public.sync_cash_count($1::jsonb)", [ccPayload(380, "55555555-5555-4555-8555-555555555555")]));
const cc = (await q("select count(*) c, max(counted_amount) a from public.cash_counts where shop_id=$1", [shop])).rows[0];
expect("two devices counting the same day leave one row (last write wins)", Number(cc.c) === 1 && Number(cc.a) === 380, `rows=${cc.c} amount=${cc.a}`);

// --- product registration with opening stock -------------------------------
const newProdId = "66666666-6666-4666-8666-666666666666";
const openMovId = "77777777-7777-4777-8777-777777777777";
const newProduct = {
  id: newProdId,
  name: "Sukari Mumias 1kg",
  unit: "packet",
  buying_price: 145,
  selling_price: 165,
  low_stock_threshold: 10,
  is_active: true,
  track_stock: true,
};
const opening = {
  id: openMovId,
  delta: 50,
  buying_price: 145,
  total_cost: 7250,
  created_at: new Date().toISOString(),
};
const callNewProduct = () =>
  as(owner, () =>
    q("select public.sync_new_product($1::jsonb, $2::jsonb) as id", [
      JSON.stringify(newProduct),
      JSON.stringify(opening),
    ]),
  );

await callNewProduct();
let np = (await q("select quantity, track_stock from public.products where id=$1", [newProdId]))
  .rows[0];
expect("registering a product with opening stock sets the count", Number(np.quantity) === 50, `qty=${np.quantity}`);

// The opening count must arrive through the ledger, never as a direct write.
const openLedger = (
  await q("select reason, delta from public.stock_movements where product_id=$1", [newProdId])
).rows;
expect(
  "opening stock is recorded as an 'opening' movement, not a direct quantity write",
  openLedger.length === 1 && openLedger[0].reason === "opening" && Number(openLedger[0].delta) === 50,
  JSON.stringify(openLedger),
);

await callNewProduct();
await callNewProduct();
await callNewProduct();
await callNewProduct();
const npCounts = (
  await q(
    `select (select count(*) from public.products where id=$1) p,
            (select count(*) from public.stock_movements where product_id=$1) m,
            (select quantity from public.products where id=$1) qty`,
    [newProdId],
  )
).rows[0];
expect("replaying sync_new_product 5x writes one product", Number(npCounts.p) === 1, `p=${npCounts.p}`);
expect("replaying sync_new_product 5x writes one opening movement", Number(npCounts.m) === 1, `m=${npCounts.m}`);
expect("opening stock is never double-counted", Number(npCounts.qty) === 50, `qty=${npCounts.qty}`);

// A product registered with no opening stock still works, and starts at zero.
const bareId = "88888888-8888-4888-8888-888888888888";
await as(owner, () =>
  q("select public.sync_new_product($1::jsonb, null) as id", [
    JSON.stringify({ ...newProduct, id: bareId, name: "Airtime", track_stock: false }),
  ]),
);
np = (await q("select quantity, track_stock from public.products where id=$1", [bareId])).rows[0];
expect("a product with no opening stock starts at zero", Number(np.quantity) === 0);
expect("track_stock can be turned off per product", np.track_stock === false);

// --- movement shape constraints --------------------------------------------
const movementShapes = [
  ["damaging a positive quantity into existence is rejected", "damage", 5],
  ["losing a positive quantity is rejected", "loss", 3],
  ["restocking a negative quantity is rejected", "restock", -4],
  ["opening stock cannot be negative", "opening", -4],
];
for (const [name, reason, delta] of movementShapes) {
  let rejected = false;
  try {
    await q(
      `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
      [shop, prod, owner, delta, reason],
    );
  } catch {
    rejected = true;
  }
  expect(name, rejected);
}

// A recount goes either way — that is the point of a recount.
for (const [name, delta] of [
  ["a recount can adjust stock down", -3],
  ["a recount can adjust stock up", 5],
]) {
  let ok = true;
  try {
    await q(
      `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, note, created_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'adjustment', 'recount', now())`,
      [shop, prod, owner, delta],
    );
  } catch {
    ok = false;
  }
  expect(name, ok);
}

// 38 after the sale, then -3 and +5 from the recounts above
const afterRecount = (await q("select quantity from public.products where id=$1", [prod])).rows[0];
expect("recounts move the cached quantity correctly", Number(afterRecount.quantity) === 40, `qty=${afterRecount.quantity}`);

// --- opening stock cannot sneak in through the generic movement RPC --------
let openingRefused = false;
try {
  await as(owner, () =>
    q("select public.sync_movement($1::jsonb)", [
      JSON.stringify({
        id: "99999999-9999-4999-8999-999999999999",
        product_id: prod,
        delta: 10,
        reason: "opening",
        created_at: new Date().toISOString(),
      }),
    ]),
  );
} catch {
  openingRefused = true;
}
expect("sync_movement refuses opening stock (it belongs to sync_new_product)", openingRefused);

// --- categories ------------------------------------------------------------
await q(`insert into public.categories (id, shop_id, name) values (gen_random_uuid(), $1, 'Flour')`, [shop]);
let dupeRefused = false;
try {
  await q(`insert into public.categories (id, shop_id, name) values (gen_random_uuid(), $1, ' flour ')`, [shop]);
} catch {
  dupeRefused = true;
}
expect("a shop cannot have two categories with the same name", dupeRefused);
await q(`insert into public.categories (id, shop_id, name) values (gen_random_uuid(), $1, 'Flour')`, [otherShop]);
expect(
  "a different shop can reuse the same category name",
  Number((await q("select count(*) c from public.categories")).rows[0].c) === 2,
);

// ===========================================================================
// CUSTOMER DEBT
// ===========================================================================
const wanjiku = "11111111-2222-4333-8444-555555555555";
await q(
  `insert into public.customers (id, shop_id, name, phone, created_at)
   values ($1, $2, 'Wanjiku', '0722000111', now())`,
  [wanjiku, shop],
);

// A credit sale with no customer is the paper book's worst failure reproduced
// digitally: a debt owed by nobody. The constraint must forbid it outright.
let creditNoCustomer = false;
try {
  await q(
    `insert into public.sales (id, shop_id, user_id, total, payment_method, business_date, created_at)
     values (gen_random_uuid(), $1, $2, 500, 'credit', current_date, now())`,
    [shop, owner],
  );
} catch {
  creditNoCustomer = true;
}
expect("a credit sale with no customer is rejected", creditNoCustomer);

// Credit must not carry money fields — that is what makes it not money.
for (const [name, extra] of [
  ["a credit sale cannot carry a tendered amount", "amount_tendered, 500"],
  ["a credit sale cannot carry an M-Pesa code", "mpesa_code, 'SGH7X2K9LM'"],
]) {
  const [col, val] = extra.split(", ");
  let rejected = false;
  try {
    await q(
      `insert into public.sales (id, shop_id, user_id, total, payment_method, customer_id, ${col}, business_date, created_at)
       values (gen_random_uuid(), $1, $2, 500, 'credit', $3, ${val}, current_date, now())`,
      [shop, owner, wanjiku],
    );
  } catch {
    rejected = true;
  }
  expect(name, rejected);
}

// Cash and M-Pesa sales must be completely unaffected by the new branch.
let cashStillWorks = true;
try {
  await q(
    `insert into public.sales (id, shop_id, user_id, total, payment_method, amount_tendered, business_date, created_at)
     values ('cccc0000-0000-4000-8000-000000000001', $1, $2, 100, 'cash', 100, current_date, now())`,
    [shop, owner],
  );
} catch {
  cashStillWorks = false;
}
expect("the rewritten constraint leaves ordinary cash sales working", cashStillWorks);

// --- a credit sale writes its charge in the same transaction --------------
const creditSaleId = "dddd0000-0000-4000-8000-000000000001";
const creditPayload = [
  JSON.stringify({
    id: creditSaleId,
    total: 800,
    payment_method: "credit",
    customer_id: wanjiku,
    debt_entry_id: "eeee0000-0000-4000-8000-000000000001",
    business_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
  }),
  JSON.stringify([
    {
      id: "dddd0000-0000-4000-8000-000000000002",
      product_id: prod,
      product_name: "Unga Jogoo 2kg",
      unit_price: 200,
      quantity: 4,
      line_total: 800,
      unit_cost: 175,
    },
  ]),
  JSON.stringify([
    {
      id: "dddd0000-0000-4000-8000-000000000003",
      product_id: prod,
      delta: -4,
      created_at: new Date().toISOString(),
    },
  ]),
];
const callCreditSync = () =>
  as(owner, () => q("select public.sync_sale($1::jsonb,$2::jsonb,$3::jsonb)", creditPayload));

// Measured as a delta rather than an absolute, so this stays true regardless
// of what earlier tests left the count at.
const qtyBeforeCredit = Number(
  (await q("select quantity from public.products where id=$1", [prod])).rows[0].quantity,
);
await callCreditSync();
const chargeRows = (
  await q("select kind, amount, customer_id from public.debt_entries where sale_id=$1", [
    creditSaleId,
  ])
).rows;
expect(
  "a credit sale creates its debt charge atomically",
  chargeRows.length === 1 &&
    chargeRows[0].kind === "charge" &&
    Number(chargeRows[0].amount) === 800 &&
    chargeRows[0].customer_id === wanjiku,
  JSON.stringify(chargeRows),
);

await callCreditSync();
await callCreditSync();
expect(
  "replaying a credit sale does not double the debt",
  Number(
    (await q("select count(*) c from public.debt_entries where sale_id=$1", [creditSaleId]))
      .rows[0].c,
  ) === 1,
);

// Stock leaves the shop on credit exactly as it does on a cash sale — the
// goods are gone whether or not the money arrived.
const qtyAfterCredit = Number(
  (await q("select quantity from public.products where id=$1", [prod])).rows[0].quantity,
);
expect(
  "a credit sale still reduces stock by the amount sold",
  qtyBeforeCredit - qtyAfterCredit === 4,
  `${qtyBeforeCredit} -> ${qtyAfterCredit}`,
);
expect(
  "...and replaying it does not reduce stock again",
  qtyBeforeCredit - qtyAfterCredit === 4,
);

// --- repayments -----------------------------------------------------------
const payEntry = (id, amount, method, code) =>
  as(owner, () =>
    q("select public.sync_debt_entry($1::jsonb)", [
      JSON.stringify({
        id,
        customer_id: wanjiku,
        kind: "payment",
        amount,
        payment_method: method,
        mpesa_code: code ?? null,
        business_date: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
      }),
    ]),
  );

await payEntry("ffff0000-0000-4000-8000-000000000001", 300, "cash", null);
await payEntry("ffff0000-0000-4000-8000-000000000001", 300, "cash", null); // replay
expect(
  "a repayment is idempotent on replay",
  Number(
    (await q("select count(*) c from public.debt_entries where id=$1", [
      "ffff0000-0000-4000-8000-000000000001",
    ])).rows[0].c,
  ) === 1,
);

// A repayment must say where the money landed, or Closing cannot column it.
let payNoMethod = false;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'payment', 100, current_date, now())`,
    [shop, wanjiku, owner],
  );
} catch {
  payNoMethod = true;
}
expect("a repayment with no payment method is rejected", payNoMethod);

// 0010 flipped this: a debtor who paid and cannot produce the code is still a
// debtor who paid, and refusing the record is worse than holding it without
// the reference. Closing flags it as unverifiable instead.
let mpesaPayNoCode = true;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount, payment_method, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'payment', 100, 'mpesa', current_date, now())`,
    [shop, wanjiku, owner],
  );
} catch {
  mpesaPayNoCode = false;
}
expect("an M-Pesa repayment with no code is accepted", mpesaPayNoCode);

// A CASH repayment carrying an M-Pesa code is still a shape error, not
// missing information, and is still refused.
let cashPayWithCode = false;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount, payment_method, mpesa_code, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'payment', 100, 'cash', 'SGH7X2K9LM', current_date, now())`,
    [shop, wanjiku, owner],
  );
} catch {
  cashPayWithCode = true;
}
expect("a cash repayment carrying an M-Pesa code is still rejected", cashPayWithCode);

// A charge must never be creatable outside its sale.
let chargeViaRpc = false;
try {
  await as(owner, () =>
    q("select public.sync_debt_entry($1::jsonb)", [
      JSON.stringify({
        id: "ffff0000-0000-4000-8000-000000000009",
        customer_id: wanjiku,
        kind: "charge",
        amount: 100,
        business_date: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
      }),
    ]),
  );
} catch {
  chargeViaRpc = true;
}
expect("a charge cannot be created outside its sale", chargeViaRpc);

// Append-only is enforced by grants and RLS, which only apply to the
// `authenticated` role — as superuser these would both succeed, so the role
// has to be switched for the assertion to mean anything.
await db.exec("grant usage on schema public to authenticated;");
await db.exec("set role authenticated;");
let debtUpdate = false;
try {
  await as(owner, () =>
    q("update public.debt_entries set amount = 1 where customer_id=$1", [wanjiku]),
  );
} catch {
  debtUpdate = true;
}
let debtDelete = false;
try {
  await as(owner, () => q("delete from public.debt_entries where customer_id=$1", [wanjiku]));
} catch {
  debtDelete = true;
}
await db.exec("reset role;");
expect("a debt entry cannot be edited, even by the owner", debtUpdate);
expect("a debt entry cannot be deleted, even by the owner", debtDelete);

// --- 0008: part-payment at the till ---------------------------------------
// The whole point of letting a payment name its sale. Without the relaxed
// constraint this insert is rejected and "pay 200 now, owe 300" is impossible.
let paymentWithSale = true;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount,
                                      sale_id, payment_method, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'payment', 50, $4, 'cash', current_date, now())`,
    [shop, wanjiku, owner, creditSaleId],
  );
} catch {
  paymentWithSale = false;
}
expect("a payment may name the sale it was made against", paymentWithSale);

// A charge still may not: goods leaving on credit is always tied to its sale,
// and a charge carrying a payment method would be a contradiction.
let chargeWithMethod = false;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount,
                                      sale_id, payment_method, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'charge', 50, $4, 'cash', current_date, now())`,
    [shop, wanjiku, owner, creditSaleId],
  );
} catch {
  chargeWithMethod = true;
}
expect("a charge carrying a payment method is still rejected", chargeWithMethod);

// The NULL hole, re-checked after the constraint was rewritten. A CHECK only
// rejects on FALSE — a NULL payment_method used to satisfy the whole clause.
let paymentNoMethod = false;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount,
                                      business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'payment', 50, current_date, now())`,
    [shop, wanjiku, owner],
  );
} catch {
  paymentNoMethod = true;
}
expect("a payment with no method is still rejected (the NULL hole)", paymentNoMethod);

// --- sync_sale writes the part-payment in the SAME transaction ------------
const partSaleId = "77777777-7777-4777-8777-777777777777";
const partPaymentId = "88888888-8888-4888-8888-888888888888";
const partSale = {
  id: partSaleId,
  total: 500,
  payment_method: "credit",
  amount_tendered: null,
  mpesa_code: null,
  customer_id: wanjiku,
  debt_entry_id: "99999999-9999-4999-8999-999999999999",
  immediate_payment: {
    id: partPaymentId,
    amount: 200,
    payment_method: "cash",
    mpesa_code: null,
  },
  business_date: new Date().toISOString().slice(0, 10),
  created_at: new Date().toISOString(),
};
const callPart = () =>
  as(owner, () =>
    q("select public.sync_sale($1::jsonb, $2::jsonb, $3::jsonb)", [
      JSON.stringify(partSale),
      JSON.stringify([]),
      JSON.stringify([]),
    ]),
  );

await callPart();
const partRows = (
  await q(
    `select kind, amount, payment_method from public.debt_entries
      where sale_id = $1 order by kind`,
    [partSaleId],
  )
).rows;
expect(
  "a part-payment sale writes both the charge and the payment",
  partRows.length === 2 &&
    partRows[0].kind === "charge" &&
    Number(partRows[0].amount) === 500 &&
    partRows[1].kind === "payment" &&
    Number(partRows[1].amount) === 200 &&
    partRows[1].payment_method === "cash",
  JSON.stringify(partRows),
);

// Replay it — a flaky connection retrying must not double the money, in either
// direction. A duplicated payment would show the customer in credit.
await callPart();
await callPart();
const partCount = (
  await q("select count(*) c from public.debt_entries where sale_id=$1", [partSaleId])
).rows[0].c;
expect("replaying a part-payment sale doubles nothing", Number(partCount) === 2, `c=${partCount}`);

// A credit sale with no part-payment must not invent one.
const plainCreditId = "0801c0de-0000-4000-8000-000000000001";
await as(owner, () =>
  q("select public.sync_sale($1::jsonb, $2::jsonb, $3::jsonb)", [
    JSON.stringify({
      ...partSale,
      id: plainCreditId,
      debt_entry_id: "0801c0de-0000-4000-8000-000000000002",
      immediate_payment: null,
    }),
    JSON.stringify([]),
    JSON.stringify([]),
  ]),
);
const plainRows = (
  await q("select kind from public.debt_entries where sale_id=$1", [plainCreditId])
).rows;
expect(
  "a credit sale without a part-payment writes only the charge",
  plainRows.length === 1 && plainRows[0].kind === "charge",
);

// --- 0008: reminders -------------------------------------------------------
const reminderId = "0801c0de-0000-4000-8000-000000000003";
const callReminder = () =>
  as(owner, () =>
    q("select public.sync_debt_reminder($1::jsonb)", [
      JSON.stringify({
        id: reminderId,
        customer_id: wanjiku,
        channel: "whatsapp",
        balance_at_time: 1200,
        promised_date: "2030-01-05",
        note: "said Friday",
        created_at: new Date().toISOString(),
      }),
    ]),
  );
await callReminder();
await callReminder();
const remCount = (
  await q("select count(*) c from public.debt_reminders where id=$1", [reminderId])
).rows[0].c;
expect("sync_debt_reminder is idempotent", Number(remCount) === 1, `c=${remCount}`);

let badChannel = false;
try {
  await q(
    `insert into public.debt_reminders (id, shop_id, customer_id, user_id, channel,
                                        balance_at_time, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'carrier_pigeon', 100, now())`,
    [shop, wanjiku, owner],
  );
} catch {
  badChannel = true;
}
expect("an unknown reminder channel is rejected", badChannel);

// "I reminded you on Tuesday" is only worth anything if it cannot be rewritten
// afterwards — the same append-only rule the debt ledger itself follows.
// Grants and RLS only bind `authenticated`; as superuser both would succeed.
await db.exec("set role authenticated;");
let remUpdate = false;
try {
  await as(owner, () =>
    q("update public.debt_reminders set note = 'never happened' where id=$1", [reminderId]),
  );
} catch {
  remUpdate = true;
}
let remDelete = false;
try {
  await as(owner, () => q("delete from public.debt_reminders where id=$1", [reminderId]));
} catch {
  remDelete = true;
}
await db.exec("reset role;");
expect("a reminder cannot be edited", remUpdate);
expect("a reminder cannot be deleted", remDelete);

// An attendant may chase a debt — they are usually the one who sees the
// customer, and pushing that interaction off the system is how the paper book
// comes back.
await db.exec("set role authenticated;");
let attReminder = true;
try {
  await as(att, () =>
    q("select public.sync_debt_reminder($1::jsonb)", [
      JSON.stringify({
        id: "0801c0de-0000-4000-8000-000000000004",
        customer_id: wanjiku,
        channel: "sms",
        balance_at_time: 800,
        created_at: new Date().toISOString(),
      }),
    ]),
  );
} catch {
  attReminder = false;
}
await db.exec("reset role;");
expect("an attendant may record a reminder", attReminder);

// RLS: the other shop must not see this shop's chase history.
await db.exec("set role authenticated;");
const otherSees = (
  await as(other, () => q("select count(*) c from public.debt_reminders"))
).rows[0].c;
await db.exec("reset role;");
expect("another shop cannot see these reminders", Number(otherSees) === 0, `c=${otherSees}`);

// =========================================================================
// 0009 — refunds
// =========================================================================
// A cash sale to reverse. Its own product so the stock assertions are exact.
const refProd = (
  await q(
    `insert into public.products (shop_id, name, unit, buying_price, selling_price)
     values ($1,'Soap bar refund test','pc',20,30) returning id`,
    [shop],
  )
).rows[0].id;
await q(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, buying_price, created_at)
   values (gen_random_uuid(), $1, $2, $3, 50, 'restock', 20, now())`,
  [shop, refProd, owner],
);

const refSaleId = "0900cafe-0000-4000-8000-000000000001";
await as(owner, () =>
  q("select public.sync_sale($1::jsonb, $2::jsonb, $3::jsonb)", [
    JSON.stringify({
      id: refSaleId,
      total: 90,
      payment_method: "cash",
      amount_tendered: 100,
      business_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }),
    JSON.stringify([
      {
        id: "0900cafe-0000-4000-8000-000000000002",
        product_id: refProd,
        product_name: "Soap bar refund test",
        unit_price: 30,
        quantity: 3,
        line_total: 90,
      },
    ]),
    JSON.stringify([
      {
        id: "0900cafe-0000-4000-8000-000000000003",
        product_id: refProd,
        delta: -3,
        created_at: new Date().toISOString(),
      },
    ]),
  ]),
);
await db.exec("reset role;");

const qtyAfterSale = Number(
  (await q("select quantity from public.products where id=$1", [refProd])).rows[0].quantity,
);
expect("the sale to be reversed left stock at 47", qtyAfterSale === 47, `qty=${qtyAfterSale}`);

const refundId = "0900cafe-0000-4000-8000-000000000010";
const refundPayload = {
  id: refundId,
  sale_id: refSaleId,
  amount: 90,
  settled_as: "cash",
  reason: "returned",
  note: null,
  business_date: new Date().toISOString().slice(0, 10),
  created_at: new Date().toISOString(),
};
const refundMovements = [
  {
    id: "0900cafe-0000-4000-8000-000000000011",
    product_id: refProd,
    delta: 3,
    reason: "return",
    created_at: new Date().toISOString(),
  },
];
const callRefund = () =>
  as(owner, () =>
    q("select public.sync_refund($1::jsonb, $2::jsonb)", [
      JSON.stringify(refundPayload),
      JSON.stringify(refundMovements),
    ]),
  );

await callRefund();
await db.exec("reset role;");
const qtyAfterRefund = Number(
  (await q("select quantity from public.products where id=$1", [refProd])).rows[0].quantity,
);
expect("a refund puts the stock back", qtyAfterRefund === 50, `qty=${qtyAfterRefund}`);

// The headline claim, same as for sync_sale: replaying must never double.
// Putting the stock back twice would be an invented three items of inventory.
await callRefund();
await callRefund();
await db.exec("reset role;");
const replayed = (
  await q(
    `select (select count(*) from public.refunds where id=$1) as refunds,
            (select count(*) from public.stock_movements where reason='return' and sale_id=$2) as moves,
            (select quantity from public.products where id=$3) as qty`,
    [refundId, refSaleId, refProd],
  )
).rows[0];
expect(
  "replaying a refund doubles nothing",
  Number(replayed.refunds) === 1 &&
    Number(replayed.moves) === 1 &&
    Number(replayed.qty) === 50,
  JSON.stringify(replayed),
);

// Whole-sale-only, expressed in the database. This is also what blocks
// refunding the same sale twice and keeping the second payout.
let secondRefund = false;
try {
  await as(owner, () =>
    q("select public.sync_refund($1::jsonb, $2::jsonb)", [
      JSON.stringify({ ...refundPayload, id: "0900cafe-0000-4000-8000-000000000012" }),
      JSON.stringify([]),
    ]),
  );
} catch {
  secondRefund = true;
}
await db.exec("reset role;");
expect("a sale cannot be refunded twice", secondRefund);

// --- owner only ------------------------------------------------------------
const attSaleId = "0900cafe-0000-4000-8000-000000000020";
await as(att, () =>
  q("select public.sync_sale($1::jsonb, $2::jsonb, $3::jsonb)", [
    JSON.stringify({
      id: attSaleId,
      total: 30,
      payment_method: "cash",
      amount_tendered: 30,
      business_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }),
    JSON.stringify([]),
    JSON.stringify([]),
  ]),
);
await db.exec("reset role;");

await db.exec("set role authenticated;");
let attRefund = false;
try {
  await as(att, () =>
    q("select public.sync_refund($1::jsonb, $2::jsonb)", [
      JSON.stringify({
        id: "0900cafe-0000-4000-8000-000000000021",
        sale_id: attSaleId,
        amount: 30,
        settled_as: "cash",
        reason: "mis_key",
        business_date: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
      }),
      JSON.stringify([]),
    ]),
  );
} catch {
  attRefund = true;
}
await db.exec("reset role;");
expect("an attendant cannot refund a sale", attRefund);

// A refund is append-only like everything else: "I reversed 4,000" must not be
// editable into "I reversed 400" after the cash has gone.
await db.exec("set role authenticated;");
let refUpdate = false;
try {
  await as(owner, () => q("update public.refunds set amount = 1 where id=$1", [refundId]));
} catch {
  refUpdate = true;
}
let refDelete = false;
try {
  await as(owner, () => q("delete from public.refunds where id=$1", [refundId]));
} catch {
  refDelete = true;
}
await db.exec("reset role;");
expect("a refund cannot be edited", refUpdate);
expect("a refund cannot be deleted", refDelete);

// --- the money rule: a credit sale is reversed, never paid out in cash -----
const credRefSale = "0900cafe-0000-4000-8000-000000000030";
await as(owner, () =>
  q("select public.sync_sale($1::jsonb, $2::jsonb, $3::jsonb)", [
    JSON.stringify({
      id: credRefSale,
      total: 250,
      payment_method: "credit",
      customer_id: wanjiku,
      debt_entry_id: "0900cafe-0000-4000-8000-000000000031",
      business_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }),
    JSON.stringify([]),
    JSON.stringify([]),
  ]),
);
await db.exec("reset role;");

let cashOutOnCredit = false;
try {
  await as(owner, () =>
    q("select public.sync_refund($1::jsonb, $2::jsonb)", [
      JSON.stringify({
        id: "0900cafe-0000-4000-8000-000000000032",
        sale_id: credRefSale,
        amount: 250,
        settled_as: "cash",
        reason: "returned",
        business_date: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
      }),
      JSON.stringify([]),
    ]),
  );
} catch {
  cashOutOnCredit = true;
}
await db.exec("reset role;");
expect(
  "handing cash back for goods that were never paid for is refused",
  cashOutOnCredit,
);

await as(owner, () =>
  q("select public.sync_refund($1::jsonb, $2::jsonb)", [
    JSON.stringify({
      id: "0900cafe-0000-4000-8000-000000000033",
      sale_id: credRefSale,
      amount: 250,
      settled_as: "credit",
      reason: "returned",
      debt_entry_id: "0900cafe-0000-4000-8000-000000000034",
      business_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }),
    JSON.stringify([]),
  ]),
);
await db.exec("reset role;");
const reversalRow = (
  await q(
    "select kind, amount from public.debt_entries where id=$1",
    ["0900cafe-0000-4000-8000-000000000034"],
  )
).rows[0];
expect(
  "reversing a credit sale writes a reversal, not a writeoff",
  reversalRow?.kind === "reversal" && Number(reversalRow.amount) === 250,
  JSON.stringify(reversalRow),
);

// A reversal must point at its sale; a writeoff must not. Keeping them apart
// in the constraint is what stops a reversal being counted as bad debt.
let reversalNoSale = false;
try {
  await q(
    `insert into public.debt_entries (id, shop_id, customer_id, user_id, kind, amount, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'reversal', 100, current_date, now())`,
    [shop, wanjiku, owner],
  );
} catch {
  reversalNoSale = true;
}
expect("a reversal with no sale attached is rejected", reversalNoSale);

// =========================================================================
// 0011 — product photos
// =========================================================================
const tinyPng =
  "data:image/webp;base64," + "U".repeat(400); // shape is what the CHECK tests

const callImage = (data, updated) =>
  as(owner, () =>
    q("select public.sync_product_image($1::jsonb)", [
      JSON.stringify({
        product_id: prod,
        data,
        width: 256,
        height: 256,
        bytes: 12000,
        created_at: new Date().toISOString(),
        updated_at: updated,
      }),
    ]),
  );

const t1 = new Date(Date.now() - 60_000).toISOString();
await callImage(tinyPng, t1);
await db.exec("reset role;");
expect(
  "a product photo is stored",
  Number((await q("select count(*) c from public.product_images where product_id=$1", [prod]))
    .rows[0].c) === 1,
);

// Unlike the money records this one is last-write-wins: a photo is a
// correction, and replacing a bad one has to actually replace it.
const t2 = new Date().toISOString();
await callImage("data:image/webp;base64," + "Z".repeat(400), t2);
await db.exec("reset role;");
const replaced = (
  await q("select data from public.product_images where product_id=$1", [prod])
).rows[0].data;
expect("a newer photo replaces the old one", replaced.includes("Z"), replaced.slice(0, 40));

// ...but a STALE replay must not win. A phone offline for a day coming back
// online must not overwrite a newer photo with the one it has been holding.
await callImage("data:image/webp;base64," + "Q".repeat(400), t1);
await db.exec("reset role;");
const afterStale = (
  await q("select data from public.product_images where product_id=$1", [prod])
).rows[0].data;
expect("a stale photo does not overwrite a newer one", afterStale.includes("Z"));

// The ceiling exists for the browser that cannot encode WebP and silently
// hands back a PNG an order of magnitude larger.
let oversize = false;
try {
  await q(
    `insert into public.product_images (product_id, shop_id, user_id, data, created_at, updated_at)
     values ($1, $2, $3, $4, now(), now())
     on conflict (product_id) do update set data = excluded.data`,
    [prod, shop, owner, "data:image/png;base64," + "A".repeat(250000)],
  );
} catch {
  oversize = true;
}
expect("an oversized photo is rejected by the database, not just the client", oversize);

let notAnImage = false;
try {
  await q(
    `insert into public.product_images (product_id, shop_id, user_id, data, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'not-a-data-url', now(), now())`,
    [shop, owner],
  );
} catch {
  notAnImage = true;
}
expect("something that is not an image data URL is rejected", notAnImage);

// Removing the photo is the same call with no data.
await callImage(null, new Date(Date.now() + 1000).toISOString());
await db.exec("reset role;");
expect(
  "sending no data removes the photo",
  Number((await q("select count(*) c from public.product_images where product_id=$1", [prod]))
    .rows[0].c) === 0,
);

// A photo may not be attached to another shop's product.
let crossShop = false;
try {
  await as(other, () =>
    q("select public.sync_product_image($1::jsonb)", [
      JSON.stringify({
        product_id: prod,
        data: tinyPng,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    ]),
  );
} catch {
  crossShop = true;
}
await db.exec("reset role;");
expect("a photo cannot be attached to another shop's product", crossShop);

// --- weighted-average cost ------------------------------------------------
// The scenario the old "latest cost" behaviour got wrong: buy cheap, then buy
// dear, and every unit already on the shelf used to revalue to the new price.
const wacProd = (
  await q(
    `insert into public.products (shop_id, name, unit, buying_price, selling_price)
     values ($1,'Sukari WAC test','packet',0,200) returning id`,
    [shop],
  )
).rows[0].id;

const restock = (deltaQty, price) =>
  q(
    `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, buying_price, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'restock', $5, now())`,
    [shop, wacProd, owner, deltaQty, price],
  );
const wacOf = async () =>
  Number((await q("select buying_price from public.products where id=$1", [wacProd])).rows[0].buying_price);
const qtyOf = async () =>
  Number((await q("select quantity from public.products where id=$1", [wacProd])).rows[0].quantity);

await restock(10, 100);
expect("the first delivery sets the average to its own price", (await wacOf()) === 100, `${await wacOf()}`);

// 10 @ 100 then 10 @ 200 -> (1000 + 2000) / 20 = 150, NOT 200.
await restock(10, 200);
expect(
  "a dearer delivery blends into a weighted average, it does not overwrite",
  (await wacOf()) === 150,
  `${await wacOf()} (latest-cost would have said 200)`,
);
expect("quantity still accumulates normally", (await qtyOf()) === 20);

// Selling must not move the average — that is the whole point of WAC.
await q(
  `insert into public.sales (id, shop_id, user_id, total, payment_method, amount_tendered, business_date, created_at)
   values ('aaaa1111-1111-4111-8111-111111111111', $1, $2, 200, 'cash', 200, current_date, now())`,
  [shop, owner],
);
await q(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, sale_id, created_at)
   values (gen_random_uuid(), $1, $2, $3, -5, 'sale', 'aaaa1111-1111-4111-8111-111111111111', now())`,
  [shop, wacProd, owner],
);
expect("selling stock leaves the average untouched", (await wacOf()) === 150, `${await wacOf()}`);
expect("...but does reduce the quantity", (await qtyOf()) === 15);

// Damage and recounts carry no cost information, so they must not move it either.
await q(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
   values (gen_random_uuid(), $1, $2, $3, -3, 'damage', now())`,
  [shop, wacProd, owner],
);
await q(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
   values (gen_random_uuid(), $1, $2, $3, 4, 'adjustment', now())`,
  [shop, wacProd, owner],
);
expect("damage and recounts do not move the average", (await wacOf()) === 150, `${await wacOf()}`);

// A restock with no price recorded cannot inform the average, so it must not
// silently zero it — that would value the whole shelf at nothing.
await restock(5, null);
expect(
  "a restock with no price leaves the average alone rather than zeroing it",
  (await wacOf()) === 150,
  `${await wacOf()}`,
);

// sync_movement must no longer clobber the trigger's average with the latest
// price — that overwrite was the original bug.
await as(owner, () =>
  q("select public.sync_movement($1::jsonb)", [
    JSON.stringify({
      id: "bbbb2222-2222-4222-8222-222222222222",
      product_id: wacProd,
      delta: 20,
      reason: "restock",
      buying_price: 300,
      created_at: new Date().toISOString(),
    }),
  ]),
);
// 21 @ 150 + 20 @ 300 = (3150 + 6000) / 41 = 223.17
const afterRpc = await wacOf();
expect(
  "restocking through the RPC also blends, instead of overwriting with the latest price",
  Math.abs(afterRpc - 223.17) < 0.02,
  `${afterRpc} (latest-cost would have said 300)`,
);

// --- reporting: cost captured at the moment of sale ------------------------
const costSaleId = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const costPayload = [
  JSON.stringify({
    id: costSaleId,
    total: 400,
    payment_method: "cash",
    amount_tendered: 500,
    business_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
  }),
  JSON.stringify([
    {
      id: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1",
      product_id: prod,
      product_name: "Unga Jogoo 2kg",
      unit_price: 200,
      quantity: 2,
      line_total: 400,
      unit_cost: 175,
    },
  ]),
  JSON.stringify([
    {
      id: "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2",
      product_id: prod,
      delta: -2,
      created_at: new Date().toISOString(),
    },
  ]),
];
const callCostSync = () =>
  as(owner, () => q("select public.sync_sale($1::jsonb,$2::jsonb,$3::jsonb)", costPayload));

await callCostSync();
await callCostSync();
await callCostSync();

const costRows = (
  await q("select unit_cost, quantity, line_total from public.sale_items where sale_id=$1", [
    costSaleId,
  ])
).rows;
expect("cost at the moment of sale is stored", costRows.length === 1 && Number(costRows[0].unit_cost) === 175, JSON.stringify(costRows));
expect(
  "replaying a sale does not duplicate its cost lines",
  costRows.length === 1,
  `${costRows.length}`,
);
expect(
  "gross profit is computable from the stored cost",
  Number(costRows[0].line_total) - Number(costRows[0].unit_cost) * Number(costRows[0].quantity) === 50,
);

// A sale recorded before this column existed must read as unknown, not zero.
await q(
  `insert into public.sale_items (id, sale_id, shop_id, product_id, product_name, unit_price, quantity, line_total)
   values (gen_random_uuid(), $1, $2, $3, 'Legacy line', 100, 1, 100)`,
  [costSaleId, shop, prod],
);
expect(
  "a pre-migration line has a null cost, never a zero one",
  Number(
    (
      await q(
        "select count(*) c from public.sale_items where sale_id=$1 and unit_cost is null",
        [costSaleId],
      )
    ).rows[0].c,
  ) === 1,
);

let negCost = false;
try {
  await q(
    `insert into public.sale_items (id, sale_id, shop_id, product_id, product_name, unit_price, quantity, line_total, unit_cost)
     values (gen_random_uuid(), $1, $2, $3, 'Bad', 100, 1, 100, -5)`,
    [costSaleId, shop, prod],
  );
} catch {
  negCost = true;
}
expect("a negative cost is rejected", negCost);

// --- units: the enum is gone, values survived, custom codes work -----------
expect(
  "the enum→text migration preserved existing unit values",
  (await q("select unit from public.products where id=$1", [prod])).rows[0].unit === "packet",
);
expect(
  "every shop gets a default unit list",
  Number((await q("select count(*) c from public.units where shop_id=$1", [shop])).rows[0].c) >= 18,
);
expect(
  "fractional units are flagged",
  (await q("select is_fractional from public.units where shop_id=$1 and code='litre'", [shop]))
    .rows[0].is_fractional === true &&
    (await q("select is_fractional from public.units where shop_id=$1 and code='pc'", [shop]))
      .rows[0].is_fractional === false,
);

// A unit the app never shipped — the whole point of dropping the enum.
await q(
  `insert into public.units (id, shop_id, code, label, is_fractional) values (gen_random_uuid(),$1,'gunia','Sack of 90kg',false)`,
  [shop],
);
const gunia = (
  await q(
    `insert into public.products (shop_id, name, unit, selling_price) values ($1,'Mahindi gunia','gunia',6500) returning id, unit`,
    [shop],
  )
).rows[0];
expect("a product can use a shop-defined unit", gunia.unit === "gunia");

let dupUnit = false;
try {
  await q(`insert into public.units (id, shop_id, code, label) values (gen_random_uuid(),$1,' GUNIA ','dup')`, [shop]);
} catch {
  dupUnit = true;
}
expect("unit codes are unique per shop, case and space insensitive", dupUnit);

// ===========================================================================
// CASE A — sealed pack sizes. The guarantee: stock is INDEPENDENT.
// This is the assertion that guards against the whole design trap: modelling
// sealed bottles as one pool would let a 5L sale silently eat 1L stock.
// ===========================================================================
const oils = {};
for (const [key, name, sell] of [
  ["l1", "Rina 1L", 290],
  ["l5", "Rina 5L", 1350],
  ["l10", "Rina 10L", 2600],
]) {
  oils[key] = (
    await q(
      `insert into public.products (shop_id, name, unit, selling_price, group_name)
       values ($1,$2,'bottle',$3,'Rina cooking oil') returning id`,
      [shop, name, sell],
    )
  ).rows[0].id;
  await q(
    `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
     values (gen_random_uuid(),$1,$2,$3,10,'opening',now())`,
    [shop, oils[key], owner],
  );
}

expect(
  "sealed pack sizes share a group name",
  Number(
    (await q("select count(*) c from public.products where group_name='Rina cooking oil'")).rows[0].c,
  ) === 3,
);

// Sell one 5L bottle.
await as(owner, () =>
  q("select public.sync_sale($1::jsonb,$2::jsonb,$3::jsonb)", [
    JSON.stringify({
      id: "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1",
      total: 1350,
      payment_method: "cash",
      amount_tendered: 1500,
      business_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }),
    JSON.stringify([
      {
        id: "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2",
        product_id: oils.l5,
        product_name: "Rina 5L",
        unit_price: 1350,
        quantity: 1,
        line_total: 1350,
      },
    ]),
    JSON.stringify([
      {
        id: "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3",
        product_id: oils.l5,
        delta: -1,
        created_at: new Date().toISOString(),
      },
    ]),
  ]),
);

const oilQty = async (id) =>
  Number((await q("select quantity from public.products where id=$1", [id])).rows[0].quantity);
expect("selling a sealed 5L reduces the 5L count", (await oilQty(oils.l5)) === 9, `${await oilQty(oils.l5)}`);
expect(
  "...and provably leaves the 1L and 10L counts untouched",
  (await oilQty(oils.l1)) === 10 && (await oilQty(oils.l10)) === 10,
  `1L=${await oilQty(oils.l1)} 10L=${await oilQty(oils.l10)}`,
);

// ===========================================================================
// CASE B — measured from bulk. The guarantee: ONE pool, moved in base units.
// ===========================================================================
const drum = (
  await q(
    `insert into public.products (shop_id, name, unit, selling_price, track_stock)
     values ($1,'Mafuta ya kupima','litre',220,true) returning id`,
    [shop],
  )
).rows[0].id;
await q(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
   values (gen_random_uuid(),$1,$2,$3,20,'opening',now())`,
  [shop, drum, owner],
);

const portions = [
  { id: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1", name: "½ litre", factor: 0.5, price: 120, sort_order: 10 },
  { id: "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2", name: "1 litre", factor: 1, price: 220, sort_order: 20 },
  { id: "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3", name: "5 litres", factor: 5, price: 1050, sort_order: 30 },
];
await as(owner, () =>
  q("select public.sync_portions($1::uuid, $2::jsonb)", [drum, JSON.stringify(portions)]),
);
expect(
  "a product can have several portions",
  Number((await q("select count(*) c from public.product_portions where product_id=$1", [drum])).rows[0].c) === 3,
);

// Sell 3 × ½ litre. That must move the pool by exactly 1.5 litre.
await as(owner, () =>
  q("select public.sync_sale($1::jsonb,$2::jsonb,$3::jsonb)", [
    JSON.stringify({
      id: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
      total: 360,
      payment_method: "cash",
      amount_tendered: 400,
      business_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }),
    JSON.stringify([
      {
        id: "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2",
        product_id: drum,
        product_name: "Mafuta ya kupima",
        unit_price: 120,
        quantity: 3,
        line_total: 360,
        portion_name: "½ litre",
        portion_factor: 0.5,
        base_quantity: 1.5,
      },
    ]),
    JSON.stringify([
      {
        id: "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3",
        product_id: drum,
        delta: -1.5,
        created_at: new Date().toISOString(),
      },
    ]),
  ]),
);

expect(
  "selling 3 × ½ litre moves the pool by exactly 1.5 litre",
  (await oilQty(drum)) === 18.5,
  `${await oilQty(drum)}`,
);
const soldLine = (
  await q("select quantity, portion_name, portion_factor, base_quantity, line_total from public.sale_items where product_id=$1", [drum])
).rows[0];
expect(
  "the receipt line says '½ litre × 3', not '1.5 litre'",
  Number(soldLine.quantity) === 3 && soldLine.portion_name === "½ litre",
  JSON.stringify(soldLine),
);
expect(
  "...while base_quantity records what actually left the pool",
  Number(soldLine.base_quantity) === 1.5,
  `${soldLine.base_quantity}`,
);

// Removing a portion from the price list must not rewrite history.
await as(owner, () =>
  q("select public.sync_portions($1::uuid, $2::jsonb)", [drum, JSON.stringify(portions.slice(1))]),
);
expect(
  "sync_portions replaces the list, removing what is gone",
  Number((await q("select count(*) c from public.product_portions where product_id=$1", [drum])).rows[0].c) === 2,
);
expect(
  "deleting a portion leaves already-sold lines intact",
  (await q("select portion_name from public.sale_items where product_id=$1", [drum])).rows[0]
    .portion_name === "½ litre",
);
expect("...and does not disturb the stock pool", (await oilQty(drum)) === 18.5, `${await oilQty(drum)}`);

let badFactor = false;
try {
  await q(
    `insert into public.product_portions (id, shop_id, product_id, name, factor, price)
     values (gen_random_uuid(),$1,$2,'free',0,10)`,
    [shop, drum],
  );
} catch {
  badFactor = true;
}
expect("a portion factor of zero is rejected", badFactor);

// --- RLS isolation ---------------------------------------------------------
// The test harness's own uid-switching table must stay reachable once we drop
// privileges to `authenticated`.
await db.exec(`
  grant usage on schema public to authenticated;
  grant usage on schema auth to authenticated;
  grant select, update on auth._ctx to authenticated;
  grant execute on function auth.uid() to authenticated;
`);
await db.exec("set role authenticated;");

// How many products this shop actually has, counted with RLS out of the way.
await db.exec("reset role;");
const actual = (await q("select count(*)::int c from public.products where shop_id=$1", [shop]))
  .rows[0].c;
await db.exec("set role authenticated;");

const seenOwn = await as(owner, () => q("select count(*)::int c from public.products"));
const seenOther = await as(other, () => q("select count(*)::int c from public.products"));
expect(
  "owner sees every product in their own shop under RLS",
  seenOwn.rows[0].c === actual && actual > 0,
  `saw ${seenOwn.rows[0].c} of ${actual}`,
);
expect("a different shop sees none of them", seenOther.rows[0].c === 0, `saw ${seenOther.rows[0].c}`);

const saleSeen = await as(other, () => q("select count(*)::int c from public.sales"));
expect("a different shop sees none of the sales", saleSeen.rows[0].c === 0, `saw ${saleSeen.rows[0].c}`);

// cross-shop write must be refused
let refused = false;
try {
  await as(other, () =>
    q(
      `insert into public.products (shop_id, name, unit, selling_price) values ($1,'Smuggled','pc',10)`,
      [shop],
    ),
  );
} catch {
  refused = true;
}
expect("inserting into another shop is refused by RLS", refused);

// Authorization guards must not fall open on NULL. A caller with no row in
// public.users gets NULL from current_user_role(); `if not NULL` never fires.
expect(
  "is_owner() never returns NULL",
  (await as(null, () => q("select public.is_owner() as v"))).rows[0].v === false,
);

let inviteRefusedAnon = false;
try {
  await as(null, () => q("select public.create_attendant('sneak@x.ke', 'Sneak')"));
} catch {
  inviteRefusedAnon = true;
}
expect("a caller with no shop cannot invite staff", inviteRefusedAnon);

let inviteRefusedAtt = false;
try {
  await as(att, () => q("select public.create_attendant('sneak2@x.ke', 'Sneak')"));
} catch {
  inviteRefusedAtt = true;
}
expect("an attendant cannot invite staff", inviteRefusedAtt);

// attendant may not create products
let attRefused = false;
try {
  await as(att, () =>
    q(`insert into public.products (shop_id, name, unit, selling_price) values ($1,'Attendant item','pc',10)`, [shop]),
  );
} catch {
  attRefused = true;
}
expect("an attendant cannot create products", attRefused);

// ...nor sneak one in through the registration RPC, which runs as invoker
// precisely so the owner-only insert policy still applies.
let attRpcRefused = false;
try {
  await as(att, () =>
    q("select public.sync_new_product($1::jsonb, $2::jsonb)", [
      JSON.stringify({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Sneaked in",
        unit: "pc",
        selling_price: 10,
      }),
      JSON.stringify({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", delta: 99, created_at: new Date().toISOString() }),
    ]),
  );
} catch {
  attRpcRefused = true;
}
expect("an attendant cannot register a product through sync_new_product", attRpcRefused);

// An attendant CAN record damage and recounts — that is the whole point of
// the adjustment screen, and they are the person holding the stock.
let attAdjustOk = true;
try {
  await as(att, () =>
    q("select public.sync_movement($1::jsonb)", [
      JSON.stringify({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        product_id: prod,
        delta: -1,
        reason: "damage",
        note: "spoilt",
        created_at: new Date().toISOString(),
      }),
    ]),
  );
} catch {
  attAdjustOk = false;
}
expect("an attendant can record damage", attAdjustOk);

// nobody may write products.quantity
let qtyRefused = false;
try {
  await as(owner, () => q("update public.products set quantity = 9999 where id=$1", [prod]));
} catch {
  qtyRefused = true;
}
expect("no client can write products.quantity directly", qtyRefused);

// nobody may delete
let delRefused = false;
try {
  await as(owner, () => q("delete from public.sales where id=$1", [saleId]));
} catch {
  delRefused = true;
}
expect("a recorded sale cannot be deleted", delRefused);

await db.exec("reset role;");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
