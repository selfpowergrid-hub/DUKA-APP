/*
 * Duka Lite service worker.
 *
 * Hand-written rather than generated. The caching rules here are short enough
 * to audit in one sitting, and getting them wrong means a shop cannot sell.
 *
 * Rules:
 *   - Next's hashed build output (/_next/static/*) is immutable -> cache first,
 *     forever. This is what makes a cold start in aeroplane mode work.
 *   - Navigations -> network first with a short timeout, falling back to the
 *     cached page, falling back to the cached app shell. The user never sees a
 *     browser error page.
 *   - Supabase and any other API call -> NEVER cached. IndexedDB is the cache;
 *     a stale API response would be a lie about money.
 */

// Stamped at build time by scripts/build-sw.mjs. This MUST change every
// deploy: `activate` below deletes caches that do not match it, and with a
// hardcoded value it deleted nothing — the previous build's app-shell HTML
// stayed cached for ever, and on a slow connection the network-first timeout
// served that stale HTML pointing at chunks the server no longer has.
const VERSION = "__SW_VERSION__";
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;
const SHELL = "/sell";

const PRECACHE = [
  "/",
  "/sell",
  "/products",
  "/products/new",
  "/products/edit",
  "/products/adjust",
  "/products/history",
  "/products/restock",
  "/products/low-stock",
  "/debts",
  "/debts/customer",
  "/closing",
  "/reports",
  "/settings",
  "/login",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PAGE_CACHE);
      // Best effort: a failed precache must not block installation.
      await Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" }))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".webmanifest")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Anything that is not our own origin (Supabase above all) goes straight to
  // the network, uncached. If it fails, the sync engine retries later.
  if (url.origin !== self.location.origin) return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(networkFirstPage(req));
    return;
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await withTimeout(fetch(request), 3000);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match(new URL(request.url).pathname)) ||
      (await cache.match(SHELL)) ||
      new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })
    );
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
