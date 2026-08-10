"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { cachedSession } from "@/lib/auth";
import { start as startSync } from "@/lib/sync";
import type { Session } from "@/lib/types";

type Ctx = {
  session: Session | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<Ctx>({
  session: null,
  loading: true,
  refresh: async () => {},
});

export function useSession() {
  return useContext(SessionContext);
}

const PUBLIC_ROUTES = ["/login", "/signup"];

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = async () => {
    setSession(await cachedSession());
  };

  // Boot from IndexedDB only — no network call decides whether we are signed
  // in, which is what makes a cold start in aeroplane mode work.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await cachedSession();
      if (!alive) return;
      setSession(s);
      setLoading(false);
      if (s) startSync();
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const isPublic = PUBLIC_ROUTES.includes(pathname);
    if (!session && !isPublic) router.replace("/login");
    if (session && isPublic) router.replace("/sell");
  }, [session, loading, pathname, router]);

  return (
    <SessionContext.Provider value={{ session, loading, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}
