/** Kenyan shillings, comma thousands, no decimals: KES 1,250 */
const KES = new Intl.NumberFormat("en-KE", {
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

export function money(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}KES ${KES.format(Math.abs(Math.round(n)))}`;
}

/** Bare number, same rules, for inputs and tight spaces. */
export function amount(value: number): string {
  return KES.format(Math.round(Number.isFinite(value) ? value : 0));
}

/** Quantities: 3 -> "3", 2.5 -> "2.5" */
export function qty(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

const NAIROBI_OFFSET_MINUTES = 3 * 60; // UTC+3, no DST in Kenya

/**
 * The business day a timestamp belongs to, in Africa/Nairobi.
 * The whole app agrees on this so a sale can never land on two different days
 * depending on which device asks.
 */
export function businessDate(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + NAIROBI_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function todayInNairobi(): string {
  return businessDate();
}

export function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-KE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatClock(iso: string): string {
  const dt = new Date(iso);
  const shifted = new Date(dt.getTime() + NAIROBI_OFFSET_MINUTES * 60_000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
