const SHELL_CACHE = "pricecheck-shell-v5";
const RUNTIME_CACHE = "pricecheck-runtime-v5";
const STATIC_ASSETS = ["/", "/offline", "/manifest.json", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
const PERSONAL_PATHS = ["/account", "/history", "/favourites", "/alerts", "/api/auth", "/api/account-token", "/api/backend/users/", "/api/backend/auth/"];

function isPersonalPath(pathname) {
  return PERSONAL_PATHS.some((path) => pathname === path || pathname.startsWith(path));
}

function isPublicPage(url) {
  if (isPersonalPath(url.pathname)) return false;
  return ["/", "/search", "/scan", "/result", "/offline", "/privacy", "/terms", "/about"].includes(url.pathname);
}

function isPriceApi(url) {
  return url.pathname === "/api/health" || /^\/api\/backend\/price\/\d{8,14}(?:\/refresh)?$/.test(url.pathname) || /^\/api\/backend\/product\/\d{8,14}\/health$/.test(url.pathname);
}

async function staleResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-PriceCheck-Cache", "stale");
  headers.set("X-PriceCheck-Cache-Age", "offline");
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
}

async function networkFirst(request, cache, fallback) {
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return staleResponse(cached);
    return fallback ? fallback() : Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("pricecheck-") && ![SHELL_CACHE, RUNTIME_CACHE].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Mutations, cross-origin requests, and account/auth data are never cached.
  if (request.method !== "GET" || url.origin !== self.location.origin || isPersonalPath(url.pathname)) return;

  if (isPriceApi(url)) {
    event.respondWith(caches.open(RUNTIME_CACHE).then((cache) => networkFirst(request, cache)));
    return;
  }

  if (request.mode === "navigate") {
    if (!isPublicPage(url)) return;
    event.respondWith(caches.open(RUNTIME_CACHE).then((cache) => networkFirst(request, cache, async () => (await caches.match("/offline")) || Response.error())));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || /\.(?:css|js|woff2?|png|svg|ico)$/i.test(url.pathname)) {
    event.respondWith(caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return Response.error();
      }
    }));
  }
});
