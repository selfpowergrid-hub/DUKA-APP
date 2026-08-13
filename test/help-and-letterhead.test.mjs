/**
 * Two things that rot quietly, checked here rather than noticed later.
 *
 * A printed report leaves the app. If it goes out without the shop's name and
 * the dates it covers, it is a column of figures nobody can place — and the
 * failure is invisible on screen, because the screen has a sidebar carrying
 * the name and the print does not. So every screen offering a Print button
 * must carry the letterhead.
 *
 * And help is only help if it can be found. Every topic needs a question, an
 * answer, and search terms that actually reach it.
 *
 * Run: npm run test:help
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "src", "app", "(app)");

let failures = 0;
const expect = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
};

// --- 1. Every printable screen carries the letterhead ----------------------
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name === "page.tsx" ? [join(dir, e.name)] : [],
  );

const pages = walk(APP);
const printable = pages.filter((f) => readFileSync(f, "utf8").includes("window.print()"));

expect("there are printable screens to check", printable.length >= 7, `${printable.length} found`);

for (const file of printable) {
  const src = readFileSync(file, "utf8");
  const name = file.slice(file.indexOf("(app)"));
  const ok = src.includes("<ReportHeader");
  expect(`${name} carries a letterhead`, ok, ok ? "" : "no <ReportHeader>");
}

// The letterhead itself must name the shop, or it is just a title. The rail
// that shows the shop name on screen is `no-print`, so this is the only place
// a printout learns whose shop it is.
const header = readFileSync(join(HERE, "..", "src", "components", "report-header.tsx"), "utf8");
expect("the letterhead prints the shop name", header.includes("shop_name"));
expect("...and the period it covers", header.includes("period"));
expect("...and when it was printed", header.includes("Printed"));
// Comments are stripped first: the doc comment explains why the shop name is
// needed by referring to the `no-print` rail, and matching prose rather than
// markup made this fail on a correct file.
const headerMarkup = header.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
expect(
  "...and is not itself marked no-print, which would defeat the purpose",
  !/className="[^"]*no-print/.test(headerMarkup),
);

// --- 2. The help content holds together ------------------------------------
const help = readFileSync(join(HERE, "..", "src", "lib", "help.ts"), "utf8");

const sectionIds = [...help.matchAll(/^    id: "([a-z-]+)",$/gm)].map((m) => m[1]);
expect("help has sections", sectionIds.length >= 8, `${sectionIds.length} sections`);
expect(
  "section ids are unique",
  new Set(sectionIds).size === sectionIds.length,
  sectionIds.join(", "),
);

const questions = [...help.matchAll(/^        q: "(.+?)",$/gm)].map((m) => m[1]);
expect("help has topics", questions.length >= 30, `${questions.length} topics`);
expect(
  "no two topics share a question",
  // The UI keys the open/closed accordion by question text, so a duplicate
  // would open two panels at once.
  new Set(questions).size === questions.length,
  questions.filter((q, i) => questions.indexOf(q) !== i).join(" | "),
);

// Every section must be reachable from the app, or it is writing nobody reads.
const shell = readFileSync(join(HERE, "..", "src", "components", "app-shell.tsx"), "utf8");
const settings = readFileSync(join(APP, "settings", "page.tsx"), "utf8");
expect("help is linked from the app shell", shell.includes('href="/help"'));
expect("help is linked from settings", settings.includes('href="/help"'));

// --- 3. The app is installable ---------------------------------------------
const manifest = JSON.parse(
  readFileSync(join(HERE, "..", "public", "manifest.webmanifest"), "utf8"),
);
expect("the manifest declares a name", Boolean(manifest.name && manifest.short_name));
expect("...and opens standalone", manifest.display === "standalone");
expect("...and has a start url", Boolean(manifest.start_url));
// A portrait lock makes the app unusable installed on a laptop, and awkward on
// a tablet held sideways. The till is used on both.
expect(
  "...and does not lock orientation",
  manifest.orientation === undefined,
  `orientation=${manifest.orientation}`,
);

const sizes = (manifest.icons ?? []).map((i) => i.sizes);
expect("...and ships both icon sizes", sizes.includes("192x192") && sizes.includes("512x512"), sizes.join(" "));
expect(
  "...and one maskable icon, or Android crops it into a circle badly",
  (manifest.icons ?? []).some((i) => (i.purpose ?? "").includes("maskable")),
);

const layout = readFileSync(join(HERE, "..", "src", "app", "layout.tsx"), "utf8");
expect("the manifest is linked from the document", layout.includes("manifest"));

const installer = readFileSync(
  join(HERE, "..", "src", "components", "install-button.tsx"),
  "utf8",
);
expect(
  "the install offer handles Chrome's prompt",
  installer.includes("beforeinstallprompt"),
);
expect(
  "...and iOS, which never fires it and needs instructions instead",
  installer.includes("Add to Home Screen"),
);
expect("...and says so when already installed", installer.includes("display-mode: standalone"));

console.log(
  failures === 0 ? "\nALL HELP & LETTERHEAD CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
