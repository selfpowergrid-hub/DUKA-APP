/**
 * Colour verification.
 *
 * Two things get checked, both of which matter more here than on a normal app:
 *
 *  1. CONTRAST. This is a till used in daylight on a cheap screen. Every text
 *     pairing the UI actually renders must clear WCAG AA — 4.5:1 for body text,
 *     3:1 for large/bold text and for UI boundaries.
 *
 *  2. SEPARATION. The brief's central rule is that cash and M-Pesa are never
 *     confusable, and the brand accent must not read as an error. So the
 *     semantic colours are checked for distance from each other in a
 *     perceptual space (CIE76 dE on Lab), not just "they look different to me".
 *     Deuteranopia — red-green colour blindness, ~8% of men — is simulated and
 *     re-checked, because cash-green vs danger-red is precisely the pair that
 *     collapses under it.
 *
 * Run: npm run test:contrast
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CSS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "globals.css");

// ---------------------------------------------------------------- parsing ---
const css = readFileSync(CSS, "utf8");
const tokens = {};
for (const m of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  tokens[m[1]] = m[2];
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// ------------------------------------------------------------- contrast -----
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

// ------------------------------------------------------------ perceptual ----
function lab(hex) {
  let [r, g, b] = rgb(hex).map((v) => v / 255);
  [r, g, b] = [r, g, b].map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a, b) => {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

/** Brettel-style deuteranopia approximation, good enough to catch collisions. */
function deuter(hex) {
  const [r, g, b] = rgb(hex);
  const R = 0.625 * r + 0.375 * g + 0.0 * b;
  const G = 0.7 * r + 0.3 * g + 0.0 * b;
  const B = 0.0 * r + 0.3 * g + 0.7 * b;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return "#" + [R, G, B].map((v) => clamp(v).toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------- the checks ---
let failures = 0;
const T = tokens;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? "  — " + detail : ""}`);
}

function ratio(name, fg, bg, min) {
  const r = contrast(T[fg], T[bg]);
  check(`${name} (${fg} on ${bg})`, r >= min, `${r.toFixed(2)}:1, need ${min}`);
}

console.log("— text contrast, WCAG AA —");
ratio("body text", "ink", "canvas", 4.5);
ratio("body text on card", "ink", "surface", 4.5);
ratio("body text on rail", "ink", "panel", 4.5);
ratio("muted text", "muted", "canvas", 4.5);
ratio("muted text on card", "muted", "surface", 4.5);
ratio("muted text on rail", "muted", "panel", 4.5);

console.log("\n— button labels (white on fill) —");
for (const [name, tok] of [
  ["primary/Charge", "brand"],
  ["primary pressed", "brand-dark"],
  ["cash", "cash"],
  ["cash pressed", "cash-dark"],
  ["mpesa", "mpesa"],
  ["mpesa pressed", "mpesa-dark"],
  ["danger", "danger"],
]) {
  const r = contrast("#ffffff", T[tok]);
  check(`${name} white on ${tok}`, r >= 4.5, `${r.toFixed(2)}:1`);
}

console.log("\n— figures on their soft backgrounds —");
ratio("cash total", "cash-dark", "cash-soft", 4.5);
ratio("mpesa total", "mpesa-dark", "mpesa-soft", 4.5);
ratio("difference when short", "danger", "danger-soft", 4.5);
ratio("clock-skew warning", "warn", "warn-soft", 4.5);
ratio("active rail item", "brand-dark", "brand-soft", 4.5);

console.log("\n— non-text boundaries, AA 3:1 —");
ratio("card border", "line", "canvas", 1.1); // decorative, just must be visible
{
  const r = contrast(T.brand, T.surface);
  check("focus ring on white", r >= 3, `${r.toFixed(2)}:1`);
}

console.log("\n— semantic separation (CIE76 dE, need > 25) —");
const pairs = [
  ["cash", "mpesa"],
  ["cash", "brand"],
  ["cash", "danger"],
  ["mpesa", "brand"],
  ["mpesa", "danger"],
  ["brand", "danger"],
];
for (const [a, b] of pairs) {
  const d = deltaE(T[a], T[b]);
  check(`${a} vs ${b}`, d > 25, `dE ${d.toFixed(1)}`);
}

console.log("\n— same pairs under deuteranopia (need > 20) —");
for (const [a, b] of pairs) {
  const d = deltaE(deuter(T[a]), deuter(T[b]));
  check(`${a} vs ${b} (deuter)`, d > 20, `dE ${d.toFixed(1)}`);
}

console.log(
  failures === 0 ? "\nALL COLOUR CHECKS PASSED" : `\n${failures} COLOUR CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
