/**
 * Responsive layout check — drives a real browser at phone, tablet and desktop
 * widths, seeds a session and a day's trade straight into IndexedDB, and fails
 * on the things that actually break a responsive layout:
 *
 *   - horizontal overflow (the page scrolling sideways)
 *   - any interactive element under 44px tall
 *   - uncaught JS errors
 *
 * It also writes screenshots to test/screenshots/ for eyeballing.
 *
 * Needs the app running:  npm run build && npm start -- -p 3100
 * Then:                   npm run test:responsive
 *
 * A 401 from Supabase is expected and ignored — the seeded session is a local
 * fixture, not a real auth token, so the sync engine's pull is refused. That
 * exercises exactly the path we want: the UI must render regardless.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "screenshots");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },   // iPhone 14
  { name: "tablet", width: 820, height: 1180 },  // iPad Air portrait
  { name: "desktop", width: 1440, height: 900 },
];

const SESSION = {
  user_id: "00000000-0000-4000-8000-000000000001",
  shop_id: "00000000-0000-4000-8000-0000000000aa",
  shop_name: "Duka ya Mama Njeri",
  role: "owner",
  full_name: "Njeri",
  email: "owner@duka.ke",
};

const NAMES = [
  ["Unga Jogoo 2kg", "packet", 175, 200, 40, 8],
  ["Unga Pembe 2kg", "packet", 170, 195, 30, 8],
  ["Sukari Mumias 1kg", "packet", 145, 165, 50, 10],
  ["Sukari Kabras 2kg", "packet", 290, 330, 20, 5],
  ["Mchele Pishori 1kg", "packet", 180, 210, 25, 6],
  ["Maharagwe 1kg", "kg", 130, 160, 30, 6],
  ["Omo 500g", "packet", 95, 120, 40, 10],
  ["Sunlight Bar 800g", "pc", 90, 115, 25, 6],
  ["Blue Band 250g", "pc", 140, 170, 20, 5],
  ["Kimbo 500g", "pc", 165, 195, 3, 4],
  ["Kasuku 500ml", "pc", 130, 155, 24, 6],
  ["Mafuta Rina 1L", "litre", 250, 290, 15, 4],
  ["Royco Mchuzi Mix 10g", "pc", 8, 10, 100, 20],
  ["Chumvi Kensalt 1kg", "packet", 30, 40, 30, 8],
  ["Maziwa Fresha 500ml", "pc", 55, 65, 40, 12],
  ["Mkate Supa Loaf 400g", "pc", 60, 70, 2, 6],
  ["Mayai (tray 30)", "pc", 390, 450, 8, 2],
  ["Colgate 75ml", "pc", 130, 160, 16, 4],
  ["Dettol 100ml", "pc", 115, 145, 12, 3],
  ["Kiberiti (matchbox)", "pc", 3, 5, 200, 40],
];

const now = new Date().toISOString();
const PRODUCTS = NAMES.map(([name, unit, buy, sell, qty, low], i) => ({
  id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`,
  shop_id: SESSION.shop_id,
  name, unit,
  buying_price: buy,
  selling_price: sell,
  quantity: qty,
  low_stock_threshold: low,
  is_active: true,
  created_at: now,
  updated_at: now,
}));

// A day's trade so Closing has something real to show.
const today = new Date();
const bd = new Date(today.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const SALES = [
  { total: 520, payment_method: "cash", amount_tendered: 600, mpesa_code: null },
  { total: 340, payment_method: "cash", amount_tendered: 500, mpesa_code: null },
  { total: 1250, payment_method: "mpesa", amount_tendered: null, mpesa_code: "SGH7X2K9LM" },
  { total: 210, payment_method: "mpesa", amount_tendered: null, mpesa_code: "TDF4M8P1QR" },
  { total: 890, payment_method: "mpesa", amount_tendered: null, mpesa_code: "RKJ9N3B7WZ" },
].map((s, i) => ({
  ...s,
  id: `00000000-0000-4000-8000-${String(i + 200).padStart(12, "0")}`,
  shop_id: SESSION.shop_id,
  user_id: SESSION.user_id,
  business_date: bd,
  created_at: new Date(today.getTime() - (5 - i) * 3600 * 1000).toISOString(),
  synced_at: i < 3 ? now : null,
}));

// Line items, so the reports screen exercises top sellers and gross profit
// rather than rendering three empty blocks.
const SALE_ITEMS = SALES.flatMap((s, i) => {
  const p = PRODUCTS[i % PRODUCTS.length];
  const q = (i % 3) + 1;
  return [
    {
      id: `00000000-0000-4000-8000-${String(i + 500).padStart(12, "0")}`,
      sale_id: s.id,
      shop_id: SESSION.shop_id,
      product_id: p.id,
      product_name: p.name,
      unit_price: p.selling_price,
      quantity: q,
      line_total: p.selling_price * q,
      portion_name: null,
      portion_factor: null,
      base_quantity: q,
      // One line deliberately has no cost, so the "unknown cost" warning is
      // exercised too — it is the path most likely to be got wrong.
      unit_cost: i === 0 ? null : p.buying_price,
    },
  ];
});

const STAFF = [
  { id: SESSION.user_id, shop_id: SESSION.shop_id, role: "owner", full_name: "Njeri" },
];

const CASH_COUNTS = [
  {
    id: "00000000-0000-4000-8000-000000000900",
    shop_id: SESSION.shop_id,
    user_id: SESSION.user_id,
    business_date: bd,
    counted_amount: 820,
    created_at: now,
    updated_at: now,
    synced_at: now,
  },
];

// Debtors, because an empty Debts screen measures nothing. Three states that
// render differently: a broken promise, a promise still pending, and someone
// nobody has ever chased.
const CUSTOMERS = [
  { id: "00000000-0000-4000-8000-000000000c01", shop_id: SESSION.shop_id, name: "Wanjiku Mwangi", phone: "0722000111", credit_limit: 2000, is_active: true, created_at: now, updated_at: now, synced_at: now },
  { id: "00000000-0000-4000-8000-000000000c02", shop_id: SESSION.shop_id, name: "Otieno", phone: "0733222444", credit_limit: null, is_active: true, created_at: now, updated_at: now, synced_at: now },
  { id: "00000000-0000-4000-8000-000000000c03", shop_id: SESSION.shop_id, name: "Kamau wa Duka", phone: null, credit_limit: null, is_active: true, created_at: now, updated_at: now, synced_at: now },
];

const daysAgoIso = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAgoDate = (n) => daysAgoIso(n).slice(0, 10);

const DEBT_ENTRIES = [
  // Old and unchased — the "never chased" branch.
  { id: "00000000-0000-4000-8000-000000000d01", shop_id: SESSION.shop_id, customer_id: CUSTOMERS[0].id, user_id: SESSION.user_id, kind: "charge", amount: 1450, sale_id: SALES[0].id, payment_method: null, mpesa_code: null, note: null, business_date: daysAgoDate(41), created_at: daysAgoIso(41), synced_at: now },
  { id: "00000000-0000-4000-8000-000000000d02", shop_id: SESSION.shop_id, customer_id: CUSTOMERS[1].id, user_id: SESSION.user_id, kind: "charge", amount: 620, sale_id: SALES[1].id, payment_method: null, mpesa_code: null, note: null, business_date: daysAgoDate(12), created_at: daysAgoIso(12), synced_at: now },
  { id: "00000000-0000-4000-8000-000000000d03", shop_id: SESSION.shop_id, customer_id: CUSTOMERS[2].id, user_id: SESSION.user_id, kind: "charge", amount: 300, sale_id: SALES[2].id, payment_method: null, mpesa_code: null, note: null, business_date: daysAgoDate(3), created_at: daysAgoIso(3), synced_at: now },
  // A part-payment taken at the till today, against today's sale.
  { id: "00000000-0000-4000-8000-000000000d04", shop_id: SESSION.shop_id, customer_id: CUSTOMERS[2].id, user_id: SESSION.user_id, kind: "payment", amount: 100, sale_id: SALES[2].id, payment_method: "cash", mpesa_code: null, note: null, business_date: bd, created_at: now, synced_at: now },
];

const DEBT_REMINDERS = [
  // Promised four days ago and nothing came — this must sort to the top.
  { id: "00000000-0000-4000-8000-000000000e01", shop_id: SESSION.shop_id, customer_id: CUSTOMERS[1].id, user_id: SESSION.user_id, channel: "whatsapp", balance_at_time: 620, promised_date: daysAgoDate(4), note: "said Friday", created_at: daysAgoIso(9), synced_at: now },
  // Promised for a week from now — waiting is the correct action.
  { id: "00000000-0000-4000-8000-000000000e02", shop_id: SESSION.shop_id, customer_id: CUSTOMERS[2].id, user_id: SESSION.user_id, channel: "sms", balance_at_time: 300, promised_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), note: null, created_at: daysAgoIso(1), synced_at: now },
];

async function seed(page, data) {
  return page.evaluate(async ({ session, products, sales, items, staff, counts, customers, debts, reminders }) => {
    const open = () =>
      new Promise((res, rej) => {
        const r = indexedDB.open("duka-lite");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const db = await open();
    const put = (store, rows) =>
      new Promise((res, rej) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        rows.forEach((row) => os.put(row));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    await put("meta", [{ key: "session", value: session }]);
    await put("products", products);
    await put("sales", sales);
    await put("sale_items", items);
    await put("staff", staff);
    await put("cash_counts", counts);
    await put("customers", customers);
    await put("debt_entries", debts);
    await put("debt_reminders", reminders);
    db.close();
    return true;
  }, data);
}

const browser = await chromium.launch();
const report = [];
let bad = 0;

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    hasTouch: vp.name !== "desktop",
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // Open the app once so Dexie creates the database, then seed it.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await seed(page, {
    session: SESSION,
    products: PRODUCTS,
    sales: SALES,
    items: SALE_ITEMS,
    staff: STAFF,
    counts: CASH_COUNTS,
    customers: CUSTOMERS,
    debts: DEBT_ENTRIES,
    reminders: DEBT_REMINDERS,
  });

  for (const route of [
    "/sell",
    "/products",
    "/debts",
    `/debts/customer?id=${CUSTOMERS[1].id}`,
    "/closing",
    "/reports",
    "/products/low-stock",
    "/products/new",
    "/products/adjust",
    "/products/history",
    "/products/restock",
    "/settings",
  ]) {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);

    // Build a cart on the Sell screen so the till panel is exercised.
    if (route === "/sell") {
      const tiles = page.locator("main button", { hasText: "KES" });
      const n = await tiles.count();
      if (n > 2) {
        await tiles.nth(0).click();
        await tiles.nth(0).click();
        await tiles.nth(2).click();
        await page.waitForTimeout(400);
      }
    }

    // Open the chase sheet and the credit step — panels that only exist after
    // a tap, and therefore the ones most likely to overflow a 390px screen
    // unnoticed.
    // The refund sheet only exists after two taps, so it would never be
    // measured otherwise — and it is the densest panel on the screen.
    if (route === "/closing") {
      const show = page.getByRole("button", { name: /Show \/ refund|Show/ });
      if (await show.count()) {
        await show.first().click();
        await page.waitForTimeout(300);
        const refundBtn = page.getByRole("button", { name: "Refund" });
        if (await refundBtn.count()) {
          await refundBtn.first().click();
          await page.waitForTimeout(300);
          const why = page.getByRole("button", { name: /Rung up wrong/ });
          if (await why.count()) {
            await why.first().click();
            await page.waitForTimeout(300);
          }
          await page.screenshot({ path: `${OUT}/${vp.name}_closing_refund.png` });
        }
      }
    }

    if (route === "/debts") {
      const chase = page.getByRole("button", { name: "Chase" });
      if (await chase.count()) {
        await chase.first().click();
        await page.waitForTimeout(400);
      }
    }

    const slug = route.replace(/[\/?=]/g, "_") || "_root";
    await page.screenshot({ path: `${OUT}/${vp.name}${slug}.png`, fullPage: false });

    // Walk the checkout steps too — that is where the layout differs most
    // between a phone (full-bleed step) and a desktop (side panel).
    if (route === "/sell") {
      const charge = page.getByRole("button", { name: "Charge" });
      if (await charge.count()) {
        await charge.first().click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/${vp.name}_sell_pay.png` });

        await page.getByRole("button", { name: "Cash", exact: true }).first().click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/${vp.name}_sell_cash.png` });

        // Back out to the payment step, then into the credit step, which now
        // carries the customer picker AND the part-payment block.
        await page.getByRole("button", { name: "Back" }).first().click();
        await page.waitForTimeout(250);
        const credit = page.getByRole("button", { name: /On credit/ });
        if (await credit.count()) {
          await credit.first().click();
          await page.waitForTimeout(300);
          const pick = page.locator("main li button").first();
          if (await pick.count()) {
            await pick.click();
            await page.waitForTimeout(300);
          }
          const partField = page.locator('input[type="number"]').first();
          if (await partField.count()) {
            await partField.fill("100");
            await page.waitForTimeout(300);
          }
          await page.screenshot({ path: `${OUT}/${vp.name}_sell_credit.png` });
        }
      }
    }

    // Horizontal overflow is the classic responsive failure. Measure it.
    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 60)}`),
    }));

    // Every interactive element must still clear 44px.
    const small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("button, a, input, select")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.height < 44) {
          out.push(`${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 24)}" h=${Math.round(r.height)}`);
        }
      }
      return out.slice(0, 6);
    });

    report.push({
      viewport: vp.name,
      route,
      overflowPx: overflow.scrollW - overflow.clientW,
      offenders: overflow.offenders,
      smallTargets: small,
      errors: [...new Set(errors)].slice(0, 3),
    });
    errors.length = 0;
  }
  await ctx.close();
}

// Stale-build recovery must survive refactors: it is the thing that saves a
// shop when a deploy lands while their till is open, and it is invisible until
// it is needed. Verified here rather than trusted.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  const trial = async (message, presetGuard) => {
    await page.evaluate((g) => {
      window.__alive = 1;
      if (g) sessionStorage.setItem("duka-chunk-reload", "1");
      else sessionStorage.removeItem("duka-chunk-reload");
    }, presetGuard);
    await page.evaluate((m) => window.dispatchEvent(new ErrorEvent("error", { message: m })), message);
    await page.waitForTimeout(2000);
    return (await page.evaluate(() => window.__alive ?? null)) === null;
  };

  const recovered = await trial("ChunkLoadError: Loading chunk app/reports/page failed.", false);
  await page.waitForTimeout(400);
  const looped = await trial("ChunkLoadError: again", true);
  const overreacted = await trial("TypeError: unrelated", false);

  // Resource failures throw nothing, so they need their own trial. A missing
  // stylesheet is the nastiest case: the page works perfectly and renders as
  // unstyled HTML, with no error for the handler above to see. This also
  // guards the inline script as a whole — a syntax error in it (a regex
  // mangled by the template literal, say) kills every listener silently.
  const byResource = async (inject) => {
    await page.evaluate(() => {
      window.__alive = 1;
      sessionStorage.removeItem("duka-chunk-reload");
    });
    await page.evaluate(inject);
    await page.waitForTimeout(2200);
    return (await page.evaluate(() => window.__alive ?? null)) === null;
  };

  const cssRecovered = await byResource(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/_next/static/chunks/does-not-exist.css";
    document.head.appendChild(l);
  });
  await page.waitForTimeout(400);
  const imageIgnored = !(await byResource(() => {
    const i = document.createElement("img");
    i.src = "/does-not-exist.png";
    document.body.appendChild(i);
  }));

  const ok = recovered && !looped && !overreacted && cssRecovered && imageIgnored;
  if (!ok) bad++;
  console.log(
    `${ok ? "PASS " : "FAIL "} recovery  stale-build reload    ` +
      `${ok ? "" : `thrown=${recovered} looped=${looped} overreacted=${overreacted} css=${cssRecovered} imageIgnored=${imageIgnored}`}`,
  );
  await ctx.close();
}

// An attendant reaching an owner-only screen by URL (not the hidden link)
// used to succeed completely — the local write happened, an outbox entry
// queued, and RLS only refused it much later on sync, in a shape the sync
// engine did not recognise as final. The fix is a client-side redirect;
// verified here because it is easy to lose silently in a later refactor.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const attendantSession = { ...SESSION, role: "attendant", full_name: "Kamau" };

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.evaluate((session) => {
    return new Promise((res, rej) => {
      const req = indexedDB.open("duka-lite");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ key: "session", value: session });
        tx.oncomplete = () => {
          db.close();
          res();
        };
        tx.onerror = () => rej(tx.error);
      };
      req.onerror = () => rej(req.error);
    });
  }, attendantSession);

  let redirectedFromNew = false;
  let redirectedFromEdit = false;
  try {
    await page.goto(`${BASE}/products/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    redirectedFromNew = !new URL(page.url()).pathname.includes("/products/new");

    await page.goto(`${BASE}/products/edit?id=nonexistent`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    redirectedFromEdit = !new URL(page.url()).pathname.includes("/products/edit");
  } catch {
    /* leave both false — reported below */
  }

  const ok = redirectedFromNew && redirectedFromEdit;
  if (!ok) bad++;
  console.log(
    `${ok ? "PASS " : "FAIL "} guard     attendant blocked from owner screens    ` +
      `${ok ? "" : `new=${redirectedFromNew} edit=${redirectedFromEdit}`}`,
  );
  await ctx.close();
}

await browser.close();

for (const r of report) {
  const problems = [];
  if (r.overflowPx > 0) problems.push(`H-OVERFLOW ${r.overflowPx}px ${JSON.stringify(r.offenders)}`);
  if (r.smallTargets.length) problems.push(`SMALL ${JSON.stringify(r.smallTargets)}`);
  // The seeded session is a local fixture, not a real auth token, so every
  // call to Supabase is refused (401) or unreachable (404 on a project without
  // the latest migrations). That is the point of the fixture — the UI must
  // render regardless — so those are not layout failures.
  const realErrors = r.errors.filter(
    (e) => !/\b(401|404)\b/.test(e) && !e.toLowerCase().includes("supabase"),
  );
  if (realErrors.length) problems.push(`JSERR ${JSON.stringify(realErrors)}`);
  if (problems.length) bad++;
  console.log(
    `${problems.length ? "FAIL " : "PASS "} ${r.viewport.padEnd(8)} ${r.route.padEnd(22)} ${problems.join(" | ")}`,
  );
}
console.log(
  bad === 0
    ? `\nALL LAYOUT CHECKS PASSED (${report.length} screen/width combinations)`
    : `\n${bad} ISSUE(S)`,
);
process.exit(bad === 0 ? 0 : 1);
