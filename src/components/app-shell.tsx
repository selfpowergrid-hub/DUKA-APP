"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SyncIndicator } from "./sync-indicator";
import { useSession } from "./session-provider";
import { signOut } from "@/lib/auth";

/**
 * Two layouts, one breakpoint.
 *
 *   < lg   phone and tablet-portrait: thumb-reachable tab bar pinned to the
 *          bottom, because that is where the hand already is.
 *   >= lg  laptop and tablet-landscape: a persistent left rail, because a
 *          bottom bar on a 1400px screen is a long way from anything.
 *
 * The tap targets do not shrink on desktop. A shop counter often has a cheap
 * touchscreen laptop on it, and a 48px target is not wrong with a mouse.
 */

const TABS = [
  { href: "/sell", label: "Sell" },
  { href: "/products", label: "Products" },
  { href: "/debts", label: "Debts" },
  { href: "/closing", label: "Closing" },
  { href: "/reports", label: "Reports" },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, refresh } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      await refresh();
      router.replace("/login");
    } catch (err) {
      setSigningOut(false);
      alert(err instanceof Error ? err.message : "Could not sign out");
    }
  }

  return (
    <div className="min-h-dvh bg-canvas">
      {/* ---------------------------------------------- desktop left rail --- */}
      <aside className="no-print fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-panel lg:flex xl:w-64">
        <Link
          href="/settings"
          className="flex min-h-16 items-center gap-2 border-b border-line px-5 text-lg font-bold"
        >
          <span className="truncate">{session?.shop_name ?? "Duka Lite"}</span>
        </Link>

        <nav className="flex-1 p-3">
          <ul className="flex flex-col gap-1">
            {TABS.map((t) => {
              const active = isActive(pathname, t.href);
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex min-h-14 items-center rounded-xl px-4 text-lg font-semibold transition-colors ${
                      active
                        ? "bg-brand-soft text-brand-dark before:absolute before:top-2 before:bottom-2 before:left-0 before:w-1 before:rounded-full before:bg-brand"
                        : "text-muted hover:bg-surface hover:text-ink"
                    }`}
                  >
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-line px-3 py-3 flex flex-col gap-2">
          <SyncIndicator />
          {/* Help is deliberately here rather than in the tab list: it is not
              a place you go to work, it is a place you go when stuck, and it
              must not cost the till a tab. */}
          <Link
            href="/help"
            className="flex min-h-10 items-center px-3 text-sm text-muted hover:text-ink"
          >
            Help
          </Link>

          <div className="mt-1 flex items-center justify-between rounded-xl border border-line bg-surface p-2.5">
            <Link
              href="/settings"
              className="flex min-w-0 flex-1 flex-col justify-center text-xs text-muted hover:text-ink"
              title="View settings"
            >
              <span className="truncate font-semibold text-ink text-sm">
                {session?.full_name ?? session?.email}
              </span>
              <span className="capitalize text-muted">{session?.role}</span>
            </Link>

            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="ml-2 flex min-h-9 items-center justify-center rounded-lg bg-danger-soft px-2.5 text-xs font-semibold text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50 shrink-0"
              title="Sign out of account"
            >
              {signingOut ? "..." : "Sign out"}
            </button>
          </div>
        </div>
      </aside>

      {/* --------------------------------------------------- content well --- */}
      <div className="print-full flex min-h-dvh flex-col lg:pl-60 xl:pl-64">
        {/* Mobile/tablet header. The rail replaces it on desktop. */}
        <header className="no-print sticky top-0 z-10 border-b border-line bg-surface lg:hidden">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-3">
            <Link href="/settings" className="flex min-h-12 items-center gap-2 font-semibold">
              <span className="max-w-[9rem] truncate sm:max-w-xs md:max-w-lg">
                {session?.shop_name ?? "Duka Lite"}
              </span>
            </Link>
            <span className="flex items-center gap-2">
              <Link
                href="/help"
                aria-label="Help"
                className="flex h-10 w-10 items-center justify-center rounded-full text-base font-bold text-muted hover:text-ink"
              >
                ?
              </Link>
              <SyncIndicator />
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="flex min-h-9 items-center justify-center rounded-lg bg-danger-soft px-2.5 text-xs font-semibold text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
              >
                {signingOut ? "..." : "Sign out"}
              </button>
            </span>
          </div>
        </header>

        <main className="mx-auto w-full max-w-3xl flex-1 pb-28 lg:max-w-none lg:pb-10">
          {children}
        </main>
      </div>

      {/* ------------------------------------------ mobile/tablet tab bar --- */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-20 mx-auto max-w-3xl border-t border-line bg-surface lg:hidden">
        <ul className="grid grid-cols-5">
          {TABS.map((t) => {
            const active = isActive(pathname, t.href);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1 text-base font-semibold ${
                    active ? "text-brand-dark" : "text-muted"
                  }`}
                >
                  <span>{t.label}</span>
                  <span
                    className={`h-0.5 w-8 rounded-full ${active ? "bg-brand" : "bg-transparent"}`}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

