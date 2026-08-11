"use client";

import { useEffect, useState } from "react";
import { getStatus, subscribe, kick, type SyncStatus } from "@/lib/sync";

/**
 * Persistent, unobtrusive: "Online" / "Offline · 3 pending".
 * It is never a blocker and never a spinner over the till.
 */
export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus>(getStatus);

  useEffect(() => subscribe(setStatus), []);

  const dot = status.online ? (status.pending ? "bg-warn" : "bg-cash") : "bg-muted";
  const label = status.online ? "Online" : "Offline";

  return (
    <button
      onClick={() => kick()}
      title={status.lastError ?? "Tap to sync now"}
      className="no-print inline-flex min-h-12 items-center gap-2 rounded-full px-3 text-sm font-medium text-muted"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dot} ${status.syncing ? "animate-pulse" : ""}`} />
      <span>{label}</span>
      {status.pending > 0 && (
        <span className="tabular">
          · {status.pending} pending
          {status.stuck > 0 ? ` (${status.stuck} stuck)` : ""}
        </span>
      )}
    </button>
  );
}
