"use client";

import { useEffect } from "react";

/**
 * Registers the service worker. Nothing else.
 *
 * Stale-build recovery deliberately does NOT live here. A failed chunk stops
 * React hydrating, so a component that only runs in an effect never mounts —
 * the recovery would be disabled by exactly the fault it exists to handle.
 * It is an inline script in the document instead. See app/layout.tsx.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* app still works, it just will not start cold offline */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
  }, []);
  return null;
}
