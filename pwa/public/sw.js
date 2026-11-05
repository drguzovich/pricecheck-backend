const SHELL_CACHE = "trolleywise-shell-v6";
const RUNTIME_CACHE = "trolleywise-runtime-v6";
const STATIC_ASSETS = ["/", "/offline", "/manifest.json", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
const PERSONAL_PATHS = ["/account", "/history", "/favourites", "/alerts", "/demo", "/api/auth", "/api/account-token", "/api/backend/users/", "/api/backend/auth/"];
function isPersonalPath(pathname) { return PERSONAL_PATHS.some((path) => pathname === path || pathname.startsWith(path)); }
function isPublicPage(url) { return !isPersonalPath(url.pathname) && ["/", "/search", "/scan", "/result", "/offline", "/privacy", "/terms", "/about"].includes(url.pathname); }
function isPriceApi(url) { return /^\/api\/backend\/price\/\d{8,14}$/.test(url.pathname) || /^\/api\/backend\/product\/\d{8,14}\/health$/.test(url.pathname); }
function hasHealthSourceFacts(data) {
  if (!data || typeof data !== "object") return false;
  const hasText = (value) => typeof value === "string" && Boolean(value.trim());
  return data.dataAvailable === true || hasText(data.ingredientsText) || hasText(data.nutriscore)
    || hasText(data.imageNutritionUrl)
    || [data.additives, data.allergensTags, data.tracesTags].some((list) => Array.isArray(list) && list.some(hasText))
    || Object.values(data.nutritionPer100g || {}).some((nutrient) => nutrient && typeof nutrient.value === "number" && Number.isFinite(nutrient.value) && nutrient.value >= 0);
}
async function shouldCacheHealth(request, response, cache) {
  if (!/^\/api\/backend\/product\/\d{8,14}\/health$/.test(new URL(request.url).pathname)) return true;
  try {
    const data = await response.clone().json();
    if (data.sourceStatus !== "temporarily_unavailable" || hasHealthSourceFacts(data)) return true;
    const previous = await cache.match(request);
    return !previous || !hasHealthSourceFacts(await previous.json());
  } catch {
    // Keep the existing behavior for non-typed responses; never consume the
    // response body that will be passed to the caller.
    return true;
  }
}
async function staleResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-PriceCheck-Cache", "stale");
  headers.set("X-TrolleyWise-Cache", "stale");
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
}
async function networkFirst(request, cache, fallback) {
  try {
    const response = await fetch(request);
    // Typed 404 comparisons are useful offline; unavailable transport responses
    // are not cached over a previously useful comparison.
    // A typed health outage with no facts must not evict saved source facts.
    // Still return the actual network result, not a fabricated cached success.
    if ((response.ok || (response.status === 404 && response.headers.get("content-type")?.includes("application/json")))
      && await shouldCacheHealth(request, response, cache)) await cache.put(request, response.clone());
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
  event.waitUntil((async () => {
    const runtime = await caches.open(RUNTIME_CACHE);
    const keys = await caches.keys();
    // Preserve old public API comparisons, including their original timestamps.
    // Do not carry over old document HTML, brand icons or personal requests.
    for (const key of keys.filter((key) => key.startsWith("pricecheck-runtime-"))) {
      const previous = await caches.open(key);
      for (const request of await previous.keys()) {
        const url = new URL(request.url);
        if (isPriceApi(url) && !url.search && !(await runtime.match(request))) {
          const response = await previous.match(request);
          if (response) await runtime.put(request, response);
        }
      }
    }
    await Promise.all(keys.filter((key) => /^(pricecheck|trolleywise)-/.test(key) && ![SHELL_CACHE, RUNTIME_CACHE].includes(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || isPersonalPath(url.pathname)) return;
  // A forced health lookup is an operation, not a fresh fact. Never replace
  // normal cached source information with a forced lookup/error response.
  if (url.searchParams.get("force") === "1") return;
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
      try { const response = await fetch(request); if (response.ok) await cache.put(request, response.clone()); return response; }
      catch { return Response.error(); }
    }));
  }
});
