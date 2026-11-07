"use client";

import { useEffect, useState } from "react";
import {
  createStaffMember,
  fetchShopStaff,
  removeStaffMember,
  revokeStaffInvite,
} from "@/lib/auth";
import type { StaffMember } from "@/lib/types";
import { Button, Field, Input, Notice, PasswordInput, Spinner } from "./ui";
import { formatDay } from "@/lib/format";

export function StaffManagement() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function load() {
    try {
      const data = await fetchShopStaff();
      setStaff(data);
    } catch {
      // offline or not owner
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    fetchShopStaff()
      .then((data) => {
        if (mounted) setStaff(data);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleAddStaff(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setError(null);
    setBusy(true);

    try {
      if (password.length < 6) {
        throw new Error("Password must be at least 6 characters");
      }

      await createStaffMember({
        email,
        fullName: name,
        password,
      });

      setMsg(`Cashier account for ${email} has been created. They can sign in immediately with this email and password.`);
      setEmail("");
      setName("");
      setPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign staff member");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string) {
    setActionBusy(userId);
    setError(null);
    setMsg(null);
    try {
      await removeStaffMember(userId);
      setMsg("Staff member removed from shop.");
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove staff member");
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRevoke(inviteEmail: string) {
    setActionBusy(inviteEmail);
    setError(null);
    setMsg(null);
    try {
      await revokeStaffInvite(inviteEmail);
      setMsg(`Invitation for ${inviteEmail} revoked.`);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke invitation");
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 sm:p-6 shadow-sm">
      <div className="border-b border-line pb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-ink">Staff & Cashier Management</h2>
          <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-bold text-brand-dark uppercase tracking-wider">
            Owner Only
          </span>
        </div>
        <p className="mt-1 text-sm text-muted">
          Assign cashiers who can make payments at the till and collect debt repayments. They cannot
          add stock, adjust inventory, record shop expenses, or view profits.
        </p>
      </div>

      {/* Permissions matrix callout */}
      <div className="rounded-xl border border-line bg-panel p-4 text-xs sm:text-sm text-ink leading-relaxed">
        <p className="font-semibold text-brand-dark mb-1">Cashier Role Permissions:</p>
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <li className="flex items-center gap-1.5 text-cash-dark font-medium">
            <span className="font-bold">✓</span> Make sales (Cash & M-Pesa)
          </li>
          <li className="flex items-center gap-1.5 text-danger font-medium">
            <span className="font-bold">✗</span> Cannot add or restock products
          </li>
          <li className="flex items-center gap-1.5 text-cash-dark font-medium">
            <span className="font-bold">✓</span> Collect customer debt payments
          </li>
          <li className="flex items-center gap-1.5 text-danger font-medium">
            <span className="font-bold">✗</span> Cannot adjust or recount stock
          </li>
          <li className="flex items-center gap-1.5 text-cash-dark font-medium">
            <span className="font-bold">✓</span> Count drawer cash on closing
          </li>
          <li className="flex items-center gap-1.5 text-danger font-medium">
            <span className="font-bold">✗</span> Cannot record expenses or refunds
          </li>
        </ul>
      </div>

      {/* Add Cashier Form */}
      <form onSubmit={handleAddStaff} className="flex flex-col gap-4 rounded-xl border border-line bg-canvas p-4">
        <h3 className="text-base font-bold text-ink">Assign a New Cashier</h3>
        
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Staff Email" hint="Used to log in on their phone">
            <Input
              type="email"
              inputMode="email"
              required
              placeholder="cashier@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Full Name" hint="Appears on receipts & shift logs">
            <Input
              required
              placeholder="Kamau Mwangi"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Assign Password" hint="Direct login password for their phone (min 6 chars)">
          <PasswordInput
            required
            minLength={6}
            placeholder="Set a password for them"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}
        {msg && <Notice tone="cash">{msg}</Notice>}

        <Button type="submit" disabled={busy} className="sm:w-56">
          {busy ? <Spinner /> : "+ Assign Cashier"}
        </Button>
      </form>

      {/* Staff List */}
      <div>
        <h3 className="text-base font-bold text-ink mb-3">
          Current Staff Roster ({staff.length})
        </h3>

        {loading ? (
          <div className="flex items-center justify-center p-6 text-muted">
            <Spinner />
          </div>
        ) : staff.length === 0 ? (
          <p className="text-sm text-muted">No staff found. Connect to internet to refresh roster.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
            {staff.map((member, idx) => {
              const isMeOwner = member.role === "owner";
              const key = member.user_id ?? member.email ?? String(idx);
              const isDeleting = confirmDelete === key;
              const isWorking = actionBusy === key || actionBusy === member.user_id || actionBusy === member.email;

              return (
                <li key={key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-ink text-base">
                        {member.full_name || member.email}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          isMeOwner
                            ? "bg-brand-soft text-brand-dark"
                            : member.status === "active"
                            ? "bg-cash-soft text-cash-dark"
                            : "bg-warn-soft text-warn"
                        }`}
                      >
                        {isMeOwner ? "Owner (Admin)" : member.status === "active" ? "Cashier" : "Invited"}
                      </span>
                    </div>
                    <p className="text-sm text-muted truncate">{member.email}</p>
                    <p className="text-xs text-muted mt-0.5">
                      Joined: {formatDay(member.created_at.slice(0, 10))}
                    </p>
                  </div>

                  {!isMeOwner && (
                    <div className="flex items-center gap-2 shrink-0">
                      {isDeleting ? (
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="danger"
                            size="md"
                            disabled={isWorking}
                            onClick={() => {
                              if (member.user_id) {
                                handleRemove(member.user_id);
                              } else {
                                handleRevoke(member.email);
                              }
                            }}
                          >
                            {isWorking ? <Spinner /> : "Confirm Remove"}
                          </Button>
                          <Button
                            type="button"
                            variant="neutral"
                            size="md"
                            disabled={isWorking}
                            onClick={() => setConfirmDelete(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="md"
                          className="text-danger hover:bg-danger-soft"
                          onClick={() => setConfirmDelete(key)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
