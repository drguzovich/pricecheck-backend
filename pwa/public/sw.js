const CACHE = "pricecheck-shell-v4";
const STATIC_ASSETS = ["/", "/offline", "/manifest.json", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;

  // Pages are network-first so scanner fixes and retailer messaging reach testers
  // without asking them to clear Safari's website data. The root page remains a
  // basic offline fallback when a connection is unavailable.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline")));
    return;
  }

  // Never intercept Next.js bundles. Development chunks are not immutable and
  // caching them can pair an old webpack runtime with new page modules.
  // Static shell caching above still provides a safe offline fallback.
});
