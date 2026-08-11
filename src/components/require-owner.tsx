"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "./session-provider";

/**
 * Blocks a screen that only the shop owner should reach.
 *
 * RLS already refuses the underlying write server-side — an attendant calling
 * `sync_new_product` gets correctly rejected. But nothing stopped the ATTEMPT:
 * the product list only hides the "+ Add product" link, and a direct URL (a
 * bookmark, browser back/forward, a shared link) reached the form regardless.
 * The local write still happened, queued an outbox entry doomed to fail, and
 * because sync_sale is one atomic transaction, any sale later rung up against
 * that phantom product got its own foreign-key violation and was parked too —
 * money taken from a customer, never reaching the server.
 *
 * This does not replace the server check; it stops the attempt before it ever
 * queues, which is what actually prevents the downstream failure.
 */
export function useRequireOwner(): boolean {
  const { session, loading } = useSession();
  const router = useRouter();
  const allowed = loading || session?.role === "owner";

  useEffect(() => {
    if (!loading && session && session.role !== "owner") {
      router.replace("/products");
    }
  }, [loading, session, router]);

  return allowed;
}
