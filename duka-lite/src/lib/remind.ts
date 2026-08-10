import { money } from "./format";
import type { Customer, DebtEntry, ReminderChannel } from "./types";
import type { CustomerDebt } from "./debt";

/**
 * Reminders — the message, and getting it into an app that can actually send it.
 *
 * Duka Lite never sends anything itself. The brief rules out an SMS gateway,
 * and it is right to: a gateway costs money per message, needs a sender ID, and
 * stops working the moment the shop's balance runs out. Handing off to WhatsApp
 * or the phone's own SMS composer costs nothing, works on the number the owner
 * already uses, and — importantly — leaves the owner in control of the wording
 * before it goes.
 *
 * The cost of that choice is that the app cannot know whether the message was
 * actually sent. So the reminder log records what it honestly knows: that the
 * owner opened the message, when, and what was owed at that moment.
 */

/**
 * Kenyan numbers get written every way there is: 0722…, +254722…, 254722…,
 * 722…. WhatsApp's wa.me needs bare international digits or it silently opens
 * a blank chat, which reads to the owner as "the app doesn't work".
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (!digits) return null;
  if (digits.startsWith("254")) return digits.length >= 12 ? digits : null;
  if (digits.startsWith("0")) return `254${digits.slice(1)}`;
  // A bare 7xxxxxxxx / 1xxxxxxxx — how most people key it when in a hurry.
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    return `254${digits}`;
  }
  return null;
}

/** For display: 0722 123 456 rather than 254722123456. */
export function displayPhone(raw: string | null | undefined): string {
  const n = normalisePhone(raw);
  if (!n) return raw ?? "";
  const local = `0${n.slice(3)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`.trim();
}

/**
 * The default message.
 *
 * Deliberately warm and short. A duka's debtors are neighbours who will be back
 * tomorrow; a threatening message collects one debt and loses a customer. It
 * names the amount and asks a question, because "how are you placed?" gets a
 * reply and "PAY YOUR DEBT" gets silence.
 */
export const DEFAULT_TEMPLATE =
  "Habari {name}, hii ni {shop}. Your balance with us is {balance}. " +
  "Whenever you are ready, you can send it to our M-Pesa or bring it to the shop. Asante!";

export const TEMPLATE_TOKENS: Array<{ token: string; means: string }> = [
  { token: "{name}", means: "the customer's name" },
  { token: "{shop}", means: "your shop's name" },
  { token: "{balance}", means: "what they owe right now" },
  { token: "{oldest}", means: "how old the oldest unpaid item is" },
];

export function renderTemplate(
  template: string,
  vars: { name: string; shop: string; balance: number; oldestDays: number },
): string {
  return (template || DEFAULT_TEMPLATE)
    .replaceAll("{name}", vars.name)
    .replaceAll("{shop}", vars.shop)
    .replaceAll("{balance}", money(vars.balance))
    .replaceAll(
      "{oldest}",
      vars.oldestDays > 0 ? `${vars.oldestDays} day${vars.oldestDays === 1 ? "" : "s"}` : "today",
    )
    .trim();
}

/**
 * Where each channel sends the owner.
 *
 * `sms:` uses the `?body=` form. Android and iOS disagree about `?` vs `&`
 * historically, but every currently shipping version of both accepts `?body=`,
 * and the worst case is a composer that opens with the number filled in and no
 * text — recoverable, unlike a link that opens nothing.
 */
export function channelLink(channel: ReminderChannel, phone: string | null, text: string): string | null {
  const n = normalisePhone(phone);
  switch (channel) {
    case "whatsapp":
      return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
    case "sms":
      return n ? `sms:+${n}?body=${encodeURIComponent(text)}` : null;
    case "call":
      return n ? `tel:+${n}` : null;
    case "in_person":
      return null; // nothing to open — it is a record that they were told
  }
}

export const CHANNELS: Array<{
  key: ReminderChannel;
  label: string;
  /** False when it works without a phone number on file. */
  needsPhone: boolean;
}> = [
  { key: "whatsapp", label: "WhatsApp", needsPhone: true },
  { key: "sms", label: "SMS", needsPhone: true },
  { key: "call", label: "Call", needsPhone: true },
  { key: "in_person", label: "Told them in person", needsPhone: false },
];

/**
 * A customer's statement as plain text, for sharing into WhatsApp.
 *
 * "I already paid you" is the argument this settles, and settling it needs the
 * dates and amounts, not a total. It is deliberately plain text rather than a
 * PDF: a duka owner shares from WhatsApp, and text costs no data to send.
 */
export function statementText(
  debt: CustomerDebt,
  entries: DebtEntry[],
  shopName: string,
  formatDate: (d: string) => string,
): string {
  const ordered = [...entries].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const lines = ordered.map((e) => {
    const what =
      e.kind === "charge"
        ? "Goods on credit"
        : e.kind === "payment"
          ? `Paid (${e.payment_method === "mpesa" ? `M-Pesa ${e.mpesa_code ?? ""}`.trim() : "cash"})`
          : "Written off";
    const sign = e.kind === "charge" ? "+" : "-";
    return `${formatDate(e.business_date)}  ${sign}${money(e.amount)}  ${what}`;
  });

  return [
    `${shopName} — statement for ${debt.customer.name}`,
    "",
    ...(lines.length ? lines : ["Nothing recorded yet."]),
    "",
    debt.balance < 0
      ? `PAID AHEAD BY ${money(Math.abs(debt.balance))}`
      : `BALANCE NOW: ${money(debt.balance)}`,
    ...(debt.oldestDays > 0 ? [`Oldest unpaid: ${debt.oldestDays} days`] : []),
  ].join("\n");
}

/**
 * Share via the OS sheet where it exists, fall back to the clipboard.
 *
 * `navigator.share` is present in Android Chrome, which is the overwhelming
 * majority here, but it throws if the user dismisses the sheet — that is a
 * cancellation, not a failure, and must not surface as an error.
 */
export async function shareText(title: string, text: string): Promise<"shared" | "copied" | "cancelled"> {
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await navigator.share({ title, text });
      return "shared";
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return "cancelled";
      // Any other failure falls through to the clipboard rather than dead-ending.
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return "copied";
  }
  return "cancelled";
}

/** Whether this customer can be reached at all — drives what the UI offers. */
export function reachable(customer: Customer): boolean {
  return normalisePhone(customer.phone) != null;
}
