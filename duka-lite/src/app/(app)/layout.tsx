"use client";

import { AppShell } from "@/components/app-shell";
import { useSession } from "@/components/session-provider";

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();

  // Booting reads IndexedDB only, so this is a few milliseconds, not a network
  // round trip. The redirect to /login is handled by SessionProvider.
  if (loading || !session) {
    return <div className="min-h-dvh bg-canvas" />;
  }

  return <AppShell>{children}</AppShell>;
}
