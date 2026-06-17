// ps-access service worker — NETWORK-FIRST by design.
//
// Caching this app caused real grief before, so the rule here is simple and safe:
// when online, ALWAYS serve fresh from the network (no stale class of bugs). The cache
// is only a fallback for offline use. New versions take over immediately (skipWaiting +
// clients.claim), so a deploy is never masked by the service worker.

const CACHE = "ps-access-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting(); // activate the new SW without waiting for tabs to close
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);           // network first — always current when online
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(req);    // offline fallback
      if (cached) return cached;
      if (req.mode === "navigate") return caches.match("./");
      throw new Error("offline and not cached");
    }
  })());
});
