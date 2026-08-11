/**
 * Multi-tenancy audit.
 *
 * Several shops use one database. The ONLY thing keeping their data apart is
 * Row Level Security, and the failure mode is silent: a table added without a
 * policy does not error, it just quietly serves every shop's rows to everyone.
 * Nobody notices until a shopkeeper sees a stranger's takings.
 *
 * So this does not test a sample. It enumerates every table in `public` and
 * requires each one to either scope itself to the current shop or be
 * explicitly listed below as deliberately shared. A new table added without a
 * policy fails this suite on the day it is written.
 *
 * Then it proves isolation behaviourally: two shops, real data in both, every
 * table read as each of them.
 *
 * Run: npm run test:tenancy
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGDIR = join(HERE, "..", "supabase", "migrations");

// Every migration, in name order — which is also apply order, by design.
const MIGRATIONS = readdirSync(MIGDIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/**
 * Tables that legitimately have no `shop_id`, with the reason each is safe.
 * Anything not listed here MUST carry shop_id and a policy referencing it.
 */
/**
 * Tables with RLS on and no policy at all. That denies every client outright;
 * they are reached only through SECURITY DEFINER functions, which is stricter
 * than any policy could be. Declared here so the state is a decision rather
 * than something nobody noticed.
 */
const DENY_ALL = {
  pending_invites:
    "written by create_attendant() and read by the signup trigger, both SECURITY DEFINER",
};

const EXEMPT = {
  shops: "the tenant itself — scoped by its own id, not by shop_id",
  sale_items: "scoped through its sale; carries shop_id too and is checked below",
  pending_invites: "keyed by email before a user exists; carries shop_id",
};

const db = new PGlite();
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
  grant usage on schema public to authenticated;
  grant usage on schema auth to authenticated;
  grant select, update on auth._ctx to authenticated;
  grant execute on function auth.uid() to authenticated;
`);

for (const f of MIGRATIONS) {
  await db.exec(
    readFileSync(join(MIGDIR, f), "utf8").replace(
      /create extension if not exists "pgcrypto";/,
      "",
    ),
  );
}

const q = (s, p) => db.query(s, p);
const as = async (uid, fn) => {
  await q("update auth._ctx set uid = $1", [uid]);
  return fn();
};

let failures = 0;
const expect = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
};

console.log(`Auditing ${MIGRATIONS.length} migrations\n`);

// =========================================================================
// 1. Structural: no table may be left unprotected
// =========================================================================
const tables = (
  await q(`
    select c.relname as table, c.relrowsecurity as rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  `)
).rows;

expect("the schema has tables to audit", tables.length > 0, `${tables.length} tables`);

for (const t of tables) {
  expect(`RLS is enabled on ${t.table}`, t.rls === true);
}

for (const t of tables) {
  const hasShopId = (
    await q(
      `select 1 from information_schema.columns
        where table_schema='public' and table_name=$1 and column_name='shop_id'`,
      [t.table],
    )
  ).rows.length > 0;

  if (!hasShopId) {
    expect(
      `${t.table} has no shop_id, and is a known exception`,
      Object.hasOwn(EXEMPT, t.table),
      Object.hasOwn(EXEMPT, t.table)
        ? EXEMPT[t.table]
        : "NEW TABLE WITH NO shop_id — every shop would share it",
    );
    continue;
  }

  // A policy that never mentions the shop is a policy that does not isolate.
  const policies = (
    await q(
      `select polname, pg_get_expr(polqual, polrelid) as using_expr,
              pg_get_expr(polwithcheck, polrelid) as check_expr
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname=$1`,
      [t.table],
    )
  ).rows;

  // RLS on with NO policy is deny-all — the most locked-down state there is,
  // and correct for a table only reachable through SECURITY DEFINER functions.
  // It has to be deliberate rather than an oversight, so it is named.
  if (policies.length === 0) {
    expect(
      `${t.table} has no policies, which denies everything, and that is deliberate`,
      Object.hasOwn(DENY_ALL, t.table),
      Object.hasOwn(DENY_ALL, t.table) ? DENY_ALL[t.table] : "NO POLICY AND NOT DECLARED",
    );
    continue;
  }

  // A policy isolates if it keys off the shop, or off the individual user —
  // `auth.uid()` is strictly narrower than shop scope, not weaker than it.
  const unscoped = policies.filter((p) => {
    const expr = `${p.using_expr ?? ""} ${p.check_expr ?? ""}`;
    return !expr.includes("current_shop_id") && !expr.includes("auth.uid()");
  });
  expect(
    `every policy on ${t.table} scopes to the shop or to the user`,
    unscoped.length === 0,
    unscoped.map((p) => p.polname).join(", "),
  );
}

// =========================================================================
// 2. Behavioural: two shops, real data, read as each
// =========================================================================
const signup = async (email, shopName) => {
  const id = (
    await q(
      `insert into auth.users (email, raw_user_meta_data)
       values ($1, $2::jsonb) returning id`,
      [email, JSON.stringify({ shop_name: shopName, full_name: "Owner" })],
    )
  ).rows[0].id;
  const shop = (await q("select shop_id from public.users where id=$1", [id])).rows[0].shop_id;
  return { id, shop };
};

const a = await signup("a@duka.ke", "Shop A");
const b = await signup("b@duka.ke", "Shop B");

expect("each sign-up creates its own shop", a.shop !== b.shop);
expect("...and both are real", !!a.shop && !!b.shop);

// Give each shop one of everything that matters.
const seed = async (owner, shop, tag) => {
  const prod = (
    await q(
      `insert into public.products (shop_id, name, unit, buying_price, selling_price)
       values ($1, $2, 'pc', 10, 20) returning id`,
      [shop, `${tag} product`],
    )
  ).rows[0].id;
  const cust = (
    await q(
      `insert into public.customers (id, shop_id, name, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, now(), now()) returning id`,
      [shop, `${tag} customer`],
    )
  ).rows[0].id;
  const saleId = (
    await q(
      `insert into public.sales (id, shop_id, user_id, total, payment_method, amount_tendered, business_date, created_at)
       values (gen_random_uuid(), $1, $2, 100, 'cash', 100, current_date, now()) returning id`,
      [shop, owner],
    )
  ).rows[0].id;
  await q(
    `insert into public.expenses (id, shop_id, user_id, category, amount, paid_from, business_date, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'rent', 500, 'other', current_date, now(), now())`,
    [shop, owner],
  );
  await q(
    `insert into public.dispensing_records (id, shop_id, sale_id, user_id, patient_name, prescriber, business_date, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'Dr X', current_date, now())`,
    [shop, saleId, owner, `${tag} patient`],
  );
  await q(
    `insert into public.product_batches (id, shop_id, product_id, batch_no, expiry_date, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, current_date + 100, now(), now())`,
    [shop, prod, `${tag}-BATCH`],
  );
  return { prod, cust, saleId };
};

const dataA = await seed(a.id, a.shop, "A");
await seed(b.id, b.shop, "B");

// Read every shop-scoped table as each owner. Under RLS each must see exactly
// their own rows and none of the other's.
await db.exec("set role authenticated;");

const scoped = tables
  .map((t) => t.table)
  .filter((t) => !["shops", "pending_invites"].includes(t));

for (const table of scoped) {
  const seenByA = Number(
    (await as(a.id, () => q(`select count(*) c from public.${table}`))).rows[0].c,
  );
  const seenByB = Number(
    (await as(b.id, () => q(`select count(*) c from public.${table}`))).rows[0].c,
  );
  const totalRows = await (async () => {
    await db.exec("reset role;");
    const n = Number((await q(`select count(*) c from public.${table}`)).rows[0].c);
    await db.exec("set role authenticated;");
    return n;
  })();

  // The claim: what A sees plus what B sees accounts for everything, with no
  // row visible to both. Any overlap is a leak.
  expect(
    `${table}: the two shops' views do not overlap`,
    seenByA + seenByB === totalRows,
    `A=${seenByA} B=${seenByB} total=${totalRows}`,
  );
}

// A cross-shop WRITE must be refused, not merely invisible.
let crossWrite = false;
try {
  await as(b.id, () =>
    q(
      `insert into public.products (shop_id, name, unit, buying_price, selling_price)
       values ($1, 'Injected', 'pc', 1, 2)`,
      [a.shop],
    ),
  );
} catch {
  crossWrite = true;
}
expect("one shop cannot write a row into another shop's data", crossWrite);

// ...and nor can it reach another shop's rows through an RPC.
let crossRpc = false;
try {
  await as(b.id, () =>
    q("select public.sync_product_image($1::jsonb)", [
      JSON.stringify({
        product_id: dataA.prod,
        data: "data:image/webp;base64," + "A".repeat(200),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    ]),
  );
} catch {
  crossRpc = true;
}
expect("one shop cannot reach another shop's product through an RPC", crossRpc);

// A signed-in user with no shop must see nothing at all, rather than everything.
// Created as superuser — auth.users is Supabase's table, not the app's.
await db.exec("reset role;");
const orphan = (
  await q(`insert into auth.users (email) values ('orphan@nowhere.ke') returning id`)
).rows[0].id;
await db.exec("set role authenticated;");
const orphanSees = Number(
  (await as(orphan, () => q("select count(*) c from public.sales"))).rows[0].c,
);
expect(
  "a user belonging to no shop sees nothing",
  orphanSees === 0,
  `saw ${orphanSees} sales`,
);

await db.exec("reset role;");

console.log(
  failures === 0
    ? `\nALL TENANCY CHECKS PASSED (${tables.length} tables audited, ${scoped.length} isolation-tested)`
    : `\n${failures} TENANCY CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
