"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { inviteAttendant, signOut } from "@/lib/auth";
import {
  describeEntry,
  describeSyncError,
  discardOutboxEntry,
  isMoneyEntry,
  requeueDiscarded,
  unsyncedReport,
  MAX_ATTEMPTS,
} from "@/lib/sync";
import { reminderTemplate, saveReminderTemplate } from "@/lib/store";
import { DEFAULT_TEMPLATE, shareText, TEMPLATE_TOKENS } from "@/lib/remind";
import { useSession } from "@/components/session-provider";
import { Button, Field, Input, Notice } from "@/components/ui";
import type { OutboxKind } from "@/lib/types";

const KIND_LABELS: Record<OutboxKind, string> = {
  sale: "A sale",
  movement: "A stock change",
  cash_count: "A cash count",
  product: "A product edit",
  new_product: "A new product",
  category: "A category",
  unit: "A unit",
  portions: "A product's measures",
  customer: "A customer",
  debt_entry: "A debt payment",
  reminder: "A debt reminder",
  refund: "A refunded sale",
  product_image: "A product photo",
  batch: "A stock batch",
  expense: "An expense",
};

export default function SettingsPage() {
  const { session, refresh } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const [templateSaved, setTemplateSaved] = useState(false);

  const queue = useLiveQuery(() => db.outbox.toArray(), []) ?? [];
  const archived = useLiveQuery(() => db.discarded.toArray(), []) ?? [];
  const stuck = queue.filter((e) => e.attempts >= MAX_ATTEMPTS);

  useEffect(() => {
    reminderTemplate().then(setTemplate);
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      await inviteAttendant(email, name);
      setMsg(
        `${email} can now create an account at the sign-up page and will join this shop as an attendant.`,
      );
      setEmail("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add staff");
    }
  }

  async function discard(seq: number) {
    setDiscarding(seq);
    try {
      await discardOutboxEntry(seq);
      setConfirmDiscard(null);
    } finally {
      setDiscarding(null);
    }
  }

  async function exportUnsynced() {
    setError(null);
    setMsg(null);
    try {
      const report = await unsyncedReport();
      const outcome = await shareText("Duka Lite — unsynced records", report.text);
      if (outcome === "copied") setMsg("Copied. Paste it somewhere safe — WhatsApp to yourself.");
    } catch {
      setError("Could not share the list.");
    }
  }

  async function out() {
    setError(null);
    try {
      await signOut();
      await refresh();
      router.replace("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-2xl font-bold lg:text-3xl">Settings</h1>

      <div className="rounded-2xl border border-line bg-surface p-4">
        <p className="text-sm text-muted">Shop</p>
        <p className="text-lg font-bold">{session?.shop_name}</p>
        <p className="mt-2 text-sm text-muted">Signed in as</p>
        <p className="font-semibold">
          {session?.full_name ?? session?.email}{" "}
          <span className="font-normal text-muted">({session?.role})</span>
        </p>
      </div>

      {session?.role === "owner" && (
        <form onSubmit={invite} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Add an attendant</h2>
          <p className="text-sm text-muted">
            Invite by email, then have them sign up with that same email. They will join this
            shop automatically. Needs internet.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Their email">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Their name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          {msg && <Notice tone="cash">{msg}</Notice>}
          <Button type="submit" className="sm:w-48">
            Add attendant
          </Button>
        </form>
      )}

      {/* The reminder message. Kept here rather than on the Debts screen so the
          owner sets it once when they have a minute, not while a customer is
          waiting at the counter. */}
      {template != null && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <h2 className="text-lg font-bold">Reminder message</h2>
          <p className="text-sm text-muted">
            What gets loaded into WhatsApp or SMS when you chase a debt. You can still edit each
            message before sending it.
          </p>
          <textarea
            rows={4}
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              setTemplateSaved(false);
            }}
            className="w-full rounded-xl border-2 border-line bg-surface px-4 py-3 text-base outline-none focus:border-brand"
          />
          <p className="text-sm text-muted">
            {TEMPLATE_TOKENS.map((t) => `${t.token} = ${t.means}`).join(" · ")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="sm:w-40"
              onClick={async () => {
                await saveReminderTemplate(template);
                setTemplate((t) => (t ?? "").trim() || DEFAULT_TEMPLATE);
                setTemplateSaved(true);
              }}
            >
              {templateSaved ? "Saved" : "Save message"}
            </Button>
            <Button
              variant="ghost"
              className="sm:w-40"
              onClick={() => {
                setTemplate(DEFAULT_TEMPLATE);
                setTemplateSaved(false);
              }}
            >
              Reset to default
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-lg font-bold">Sync queue</h2>
        <p className="mt-1 text-sm text-muted">
          {queue.length === 0
            ? "Everything on this device has reached the server."
            : `${queue.length} item(s) waiting.`}
        </p>

        {/* A phone that dies takes its unsynced records with it — that is
            inherent to working offline and cannot be engineered away. What it
            can be is recoverable: one share turns a lost phone into an
            afternoon of retyping instead of lost sales and lost debts. */}
        {(queue.length > 0 || archived.length > 0) && (
          <>
            <ul className="mt-3 flex flex-col gap-1">
              {queue.slice(0, 12).map((e) => (
                <li key={e.seq} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className={isMoneyEntry(e) ? "font-semibold" : "text-muted"}>
                    {describeEntry(e)}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {e.attempts >= MAX_ATTEMPTS ? "rejected" : "waiting"}
                  </span>
                </li>
              ))}
              {queue.length > 12 && (
                <li className="text-sm text-muted">…and {queue.length - 12} more</li>
              )}
            </ul>
            <Button variant="neutral" className="mt-3 min-h-12 text-sm" onClick={exportUnsynced}>
              Save a copy of everything not yet sent
            </Button>
          </>
        )}

        {stuck.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
            <p className="text-sm text-muted">
              The server would not accept {stuck.length} item{stuck.length === 1 ? "" : "s"}.
              Nothing was lost — they stay on this device until you decide what to do with them.
            </p>
            <ul className="flex flex-col gap-2">
              {stuck.map((e) => (
                <li key={e.seq} className="rounded-xl bg-danger-soft p-3">
                  <p className="font-semibold text-danger">{KIND_LABELS[e.kind]}</p>
                  <p className="text-sm text-danger">{describeEntry(e)}</p>
                  <p className="mt-1 text-sm text-danger">
                    {describeSyncError(e.last_error ?? "Unknown error")}
                  </p>

                  {confirmDiscard === e.seq ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {/* Money gets a real confirmation. Stopping delivery of a
                          sale or a debt means it exists on this phone and
                          nowhere else — on the owner's device it simply is not
                          there, and no shop can be expected to notice that. */}
                      <p className="text-sm font-semibold text-danger">
                        {isMoneyEntry(e)
                          ? `This is money: ${describeEntry(e)}. It will stop trying to reach the server and will only exist on this device. Kept in the archive below so you can still see it or try again.`
                          : "It will stop trying to reach the server. Kept in the archive below."}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="danger"
                          className="min-h-12 px-3 text-sm"
                          disabled={discarding === e.seq}
                          onClick={() => discard(e.seq!)}
                        >
                          {discarding === e.seq ? "Stopping…" : "Yes, stop sending it"}
                        </Button>
                        <Button
                          variant="ghost"
                          className="min-h-12 px-3 text-sm"
                          onClick={() => setConfirmDiscard(null)}
                        >
                          Keep trying
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="neutral"
                      className="mt-2 min-h-12 px-3 text-sm"
                      onClick={() => setConfirmDiscard(e.seq!)}
                    >
                      Stop trying to send this
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* The archive. The cause of a rejection is usually fixable — a
            renamed product, a promoted user — and when it is, the record
            should go where it always belonged. */}
        {archived.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
            <h3 className="font-bold">Given up on ({archived.length})</h3>
            <p className="text-sm text-muted">
              Still here, still on this device. Fix whatever the server objected to, then try
              again.
            </p>
            <ul className="flex flex-col gap-2">
              {archived.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 rounded-xl bg-panel p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-semibold">{a.summary}</p>
                    <p className="text-sm text-muted">
                      {describeSyncError(a.last_error ?? "Unknown error")}
                    </p>
                  </div>
                  <Button
                    variant="neutral"
                    className="min-h-12 shrink-0 px-3 text-sm"
                    onClick={() => requeueDiscarded(a.id)}
                  >
                    Try again
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {error && <Notice>{error}</Notice>}

      <Button variant="danger" size="lg" onClick={out} className="sm:w-48">
        Sign out
      </Button>
      <p className="text-sm text-muted">
        Signing out erases this device&apos;s local copy, so it is blocked while sales are still
        waiting to sync.
      </p>
    </div>
  );
}
