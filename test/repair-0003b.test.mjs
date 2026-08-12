/**
 * Reproduces the 0003b upgrade failure, and proves the repair fixes it.
 *
 *   ERROR: 23514: check constraint "movement_reason_shape" of relation
 *   "stock_movements" is violated by some row
 *
 * 0001 allowed `damage` with ANY delta — its branch was
 * `reason in ('adjustment','damage') and sale_id is null`, with no sign check.
 * 0003b tightened damage to `delta < 0`, because damage reduces stock. So a
 * pre-existing damage row with a POSITIVE delta blocks the upgrade, and
 * Postgres will not say which row.
 *
 * Positive is the only possible shape, which this suite established rather
 * than assumed: the first version of it tried a zero-delta row too, and the
 * insert was refused by `check (delta <> 0)` on the column itself.
 *
 * The repair does NOT delete anything. Stock is an append-only ledger, and a
 * row that has already moved the quantity cannot be removed without changing
 * history. It re-labels those rows as `adjustment` — the one reason that
 * legitimately carries either sign, and the honest description of "the count
 * was corrected" — keeping the delta, so no quantity moves.
 *
 * Run: npm run test:repair-0003b
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = (f) => join(HERE, "..", "supabase", "migrations", f);
const REPAIR = join(HERE, "..", "supabase", "repair_0003b_damage_rows.sql");
const sql = (f) => readFileSync(f, "utf8").replace(/create extension if not exists "pgcrypto";/, "");

let failures = 0;
const expect = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
};

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(),
    email text unique, raw_user_meta_data jsonb default '{}'::jsonb);
  create table auth._ctx (uid uuid);
  insert into auth._ctx values (null);
  create function auth.uid() returns uuid language sql stable as $$
    select uid from auth._ctx limit 1; $$;
`);

for (const f of ["0001_init.sql", "0002_fix_owner_guard.sql", "0003a_stock_intake_enums.sql"]) {
  await db.exec(sql(MIG(f)));
}

const owner = (
  await db.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ('o@duka.ke', '{"shop_name":"Duka"}'::jsonb) returning id`,
  )
).rows[0].id;
const shop = (await db.query("select shop_id from public.users where id=$1", [owner])).rows[0]
  .shop_id;
const prod = (
  await db.query(
    `insert into public.products (shop_id, name, unit, buying_price, selling_price)
     values ($1,'Sukari','kg',100,120) returning id`,
    [shop],
  )
).rows[0].id;

// Legal under 0001, illegal under 0003b. This is the row that blocks the upgrade.
await db.query(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
   values (gen_random_uuid(), $1, $2, $3, 3, 'damage', now())`,
  [shop, prod, owner],
);
// A correct damage row, which the repair must leave alone. (A zero-delta row
// is not tested because it cannot exist: `check (delta <> 0)` sits on the
// column, which is how this suite learned that positive is the only case.)
await db.query(
  `insert into public.stock_movements (id, shop_id, product_id, user_id, delta, reason, created_at)
   values (gen_random_uuid(), $1, $2, $3, -2, 'damage', now())`,
  [shop, prod, owner],
);

const qtyBefore = Number(
  (await db.query("select quantity from public.products where id=$1", [prod])).rows[0].quantity,
);

// --- the failure, reproduced -------------------------------------------------
let blocked = false;
let code = null;
try {
  await db.exec(sql(MIG("0003b_stock_intake.sql")));
} catch (e) {
  blocked = true;
  code = e.code ?? null;
}
expect(
  "0003b is blocked by the pre-existing damage rows, exactly as reported",
  blocked && code === "23514",
  `code=${code}`,
);

// --- the repair ---------------------------------------------------------------
const changed = (await db.query(sql(REPAIR))).rows;
expect(
  "the repair reports what it changed rather than working silently",
  changed.length === 1,
  `${changed.length} rows re-labelled`,
);

// --- and now the migration applies -------------------------------------------
let applied = true;
try {
  await db.exec(sql(MIG("0003b_stock_intake.sql")));
} catch (e) {
  applied = false;
  console.log("   still failing:", e.message);
}
expect("0003b applies once the repair has run", applied);

// --- nothing was destroyed, and no stock moved -------------------------------
const rows = (
  await db.query(
    `select reason, delta, note from public.stock_movements
      where product_id = $1 order by delta`,
    [prod],
  )
).rows;
expect(
  "every movement is still there — the ledger is append-only",
  rows.length === 2,
  `${rows.length} rows`,
);
expect(
  "the product's quantity is unchanged, because no delta was touched",
  Number(
    (await db.query("select quantity from public.products where id=$1", [prod])).rows[0].quantity,
  ) === qtyBefore,
  `qty=${qtyBefore}`,
);
expect(
  "the genuine damage row was left as damage",
  rows.some((r) => r.reason === "damage" && Number(r.delta) === -2),
  JSON.stringify(rows.map((r) => [r.reason, Number(r.delta)])),
);
expect(
  "the impossible one became an adjustment, keeping its delta",
  rows.filter((r) => r.reason === "adjustment").length === 1 &&
    rows.some((r) => r.reason === "adjustment" && Number(r.delta) === 3),
  JSON.stringify(rows.map((r) => [r.reason, Number(r.delta)])),
);
expect(
  "each re-labelled row says why, so the change is not silent in the record",
  rows.filter((r) => (r.note ?? "").toLowerCase().includes("recorded as damage")).length === 1,
  JSON.stringify(rows.map((r) => r.note)),
);

// --- safe to run twice --------------------------------------------------------
const second = (await db.query(sql(REPAIR))).rows;
expect("running the repair again changes nothing", second.length === 0, `${second.length} rows`);

console.log(
  failures === 0 ? "\nALL REPAIR CHECKS PASSED" : `\n${failures} REPAIR CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
