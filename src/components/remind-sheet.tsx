"use client";

import { useEffect, useState } from "react";
import { CHANNELS, channelLink, normalisePhone, renderTemplate } from "@/lib/remind";
import { recordReminder, reminderTemplate } from "@/lib/store";
import { useSession } from "@/components/session-provider";
import { Button, Input, Notice } from "@/components/ui";
import { money, todayInNairobi } from "@/lib/format";
import type { CustomerDebt } from "@/lib/debt";
import type { ReminderChannel } from "@/lib/types";

/**
 * Chasing one debt.
 *
 * Two things happen here and they are deliberately kept separate:
 *
 *   1. The message is opened in WhatsApp / SMS / the dialler. The app hands off
 *      and stops knowing anything.
 *   2. What the owner learned is written down — that they chased, and what was
 *      promised. This is the part with lasting value, because a promise is what
 *      turns a list of names into a queue, and it is what tells you three weeks
 *      later that this person has now broken two.
 *
 * The promise field is optional and comes AFTER the send, because at the moment
 * of tapping WhatsApp nobody has promised anything yet. Asking first would get
 * a guess, and a guessed promise is worse than none.
 */
export function RemindSheet({
  debt,
  onClose,
}: {
  debt: CustomerDebt;
  onClose: () => void;
}) {
  const { session } = useSession();
  const [template, setTemplate] = useState<string | null>(null);
  const [channel, setChannel] = useState<ReminderChannel | null>(null);
  const [promise, setPromise] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    reminderTemplate().then(setTemplate);
  }, []);

  const phone = normalisePhone(debt.customer.phone);
  const text =
    template == null
      ? ""
      : renderTemplate(template, {
          name: debt.customer.name.split(" ")[0],
          shop: session?.shop_name ?? "the shop",
          balance: debt.balance,
          oldestDays: debt.oldestDays,
        });

  async function log(ch: ReminderChannel, promised: string | null) {
    setBusy(true);
    setError(null);
    try {
      await recordReminder({
        customer_id: debt.customer.id,
        channel: ch,
        balance_at_time: debt.balance,
        promised_date: promised,
        note: note || null,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the reminder");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open the app, then record. Recording FIRST would log a reminder for a link
   * that never opened; recording after means the log reflects an attempt that
   * actually left this screen. Neither can prove delivery, and the wording in
   * the history is careful not to claim it does.
   */
  async function send(ch: ReminderChannel) {
    const href = channelLink(ch, debt.customer.phone, text);
    if (href) window.open(href, "_blank", "noopener");
    setChannel(ch);
    await log(ch, null);
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">Chase {debt.customer.name}</h2>
          <p className="text-sm text-muted">
            Owes {money(debt.balance)}
            {debt.oldestDays > 0 && ` · oldest ${debt.oldestDays} days`}
          </p>
        </div>
        <Button variant="ghost" className="min-h-10 shrink-0 px-2 text-sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {!phone && (
        <Notice tone="warn">
          No phone number on file, so there is nothing to send to. Add one on their page — it is
          the single thing that decides whether a debt can be chased at all.
        </Notice>
      )}

      {template != null && phone && (
        <div className="rounded-xl bg-panel p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            The message
          </p>
          <p className="whitespace-pre-wrap text-base">{text}</p>
          <p className="mt-2 text-xs text-muted">
            You can still edit it in WhatsApp before sending. Change the standard wording in
            Settings.
          </p>
        </div>
      )}

      {!saved ? (
        <div className="grid grid-cols-2 gap-2">
          {CHANNELS.map((c) => (
            <Button
              key={c.key}
              variant={c.key === "whatsapp" ? "primary" : "neutral"}
              disabled={busy || (c.needsPhone && !phone) || (template == null && c.needsPhone)}
              onClick={() => send(c.key)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl bg-brand-soft p-3">
          <p className="text-base font-semibold text-brand-dark">
            Chased {CHANNELS.find((c) => c.key === channel)?.label ?? ""} — written down.
          </p>
          <label className="block">
            <span className="mb-1 block text-base font-medium">
              Did they promise a day?{" "}
              <span className="font-normal text-muted">Optional</span>
            </span>
            <Input
              type="date"
              min={todayInNairobi()}
              value={promise}
              onChange={(e) => setPromise(e.target.value)}
            />
          </label>
          <Input
            placeholder="Anything they said (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              className="sm:flex-1"
              disabled={busy || !promise}
              onClick={async () => {
                // A promise is its own record, not an edit of the reminder just
                // written — the log is append-only, so "I chased them" and
                // "they said Friday" stay as two separate, honest facts.
                await log(channel ?? "in_person", promise);
                onClose();
              }}
            >
              {promise ? "Save the promise" : "Save"}
            </Button>
            <Button variant="ghost" className="sm:w-32" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}

      {error && <Notice>{error}</Notice>}
    </div>
  );
}
