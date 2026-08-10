/**
 * Verifies supabase/check_migrations.sql actually discriminates.
 *
 * A checker that reports "ok" for a migration the database never had is worse
 * than no checker: it sends the owner away believing their database is current
 * while the app writes to tables that do not exist. So every row is tested
 * against a database that genuinely lacks that migration, not just against a
 * fully migrated one.
 *
 * Run: npm run test:migration-check
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

import { dirname, join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGDIR = pjoin(HERE, "..", "supabase", "migrations");
const ALL = [
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
];
const CHECK = readFileSync(pjoin(HERE, "..", "supabase", "check_migrations.sql"), "utf8");

async function build(files) {
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
  for (const f of files) {
    await db.exec(readFileSync(pjoin(MIGDIR, f), "utf8")
      .replace(/create extension if not exists "pgcrypto";/, ""));
  }
  return db;
}

let failures = 0;
const expect = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
};

// --- fully migrated: everything must read ok ------------------------------
const full = await build(ALL);
const fullRows = (await full.query(CHECK)).rows;
expect("reports a row per migration", fullRows.length === 13, `got ${fullRows.length}`);
const notOk = fullRows.filter((r) => r.status !== "ok");
expect(
  "a fully migrated database reports every migration ok",
  notOk.length === 0,
  notOk.map((r) => r.migration).join(", "),
);

// Reverts the two functions to their ORIGINAL, buggy definitions. Building the
// fixture from the committed 0001 would prove nothing: that file has since had
// 0002's fix folded into it, so it is already correct.
const BREAK_0002 = `
  create or replace function public.is_owner() returns boolean language sql stable as $$
    select public.current_user_role() = 'owner';
  $$;
  create or replace function public.create_attendant(p_email text, p_full_name text default null)
  returns void language plpgsql security definer set search_path = public as $$
  declare v_shop_id uuid := public.current_shop_id();
  begin
    if v_shop_id is null then raise exception 'no shop for current user'; end if;
    if not public.is_owner() then raise exception 'only an owner can add staff'; end if;
    insert into public.pending_invites (email, shop_id, role, full_name)
    values (lower(btrim(p_email)), v_shop_id, 'attendant', p_full_name)
    on conflict (email) do update set shop_id = excluded.shop_id;
  end; $$;
`;

// --- only 0001: everything after it must read MISSING ---------------------
// The real risk with a check like this is a false "ok" — telling the owner a
// migration landed when it did not is worse than no check at all.
const bare = await build(["0001_init.sql"]);
await bare.exec(BREAK_0002);
const bareRows = (await bare.query(CHECK)).rows;
const wronglyOk = bareRows.filter((r) => r.migration !== "0001_init" && r.status === "ok");
expect(
  "a database with only 0001 reports every later migration as MISSING",
  wronglyOk.length === 0,
  wronglyOk.length ? `falsely ok: ${wronglyOk.map((r) => r.migration).join(", ")}` : "",
);
expect(
  "...and still reports 0001 itself as ok",
  bareRows.find((r) => r.migration === "0001_init")?.status === "ok",
);

// --- partial: through 0005, so 0006/0007/0008 must be MISSING -------------
// The interesting boundary, because 0006 has no column or table to look for.
// Sanity: the fully-migrated database must NOT be flagged by the same marker,
// or the 0002 row is just always-MISSING and equally useless.
const reFixed = await build(["0001_init.sql"]);
await reFixed.exec(BREAK_0002);
await reFixed.exec(readFileSync(pjoin(MIGDIR, "0002_fix_owner_guard.sql"), "utf8"));
expect(
  "running 0002 on a broken database flips it back to ok",
  (await reFixed.query(CHECK)).rows.find((r) => r.migration === "0002_fix_owner_guard")
    ?.status === "ok",
);

const partial = await build(ALL.slice(0, 6));
const partialRows = (await partial.query(CHECK)).rows;
const missing = partialRows.filter((r) => r.status !== "ok").map((r) => r.migration);
expect(
  "a database migrated through 0005 flags exactly everything after it",
  missing.join(",") ===
    "0006_weighted_average_cost,0007a_credit_enum,0007b_customer_debt," +
      "0008_debt_lifecycle,0009a_refund_enums,0009b_refunds," +
      "0010_optional_mpesa_code",
  missing.join(",") || "(none flagged)",
);

console.log("\n--- what the owner sees on a fully migrated database ---");
for (const r of fullRows) console.log(`${r.status.padEnd(28)} ${r.migration}`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
