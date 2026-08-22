export type RetailerResult = {
  retailer: string;
  available: boolean;
  price: number | null;
  price_str: string | null;
  currency?: "ZAR";
  updated_at: string | null;
  updatedAt?: string | null;
  url: string | null;
  promo_flag: boolean;
  from_cache: boolean;
  stale: boolean;
  error: string | null;
};

export type ComparisonResponse = {
  barcode: string;
  product: {
    barcode: string;
    name: string | null;
    brand: string | null;
    pack_size: string | null;
    image_url: string | null;
  };
  results: RetailerResult[];
};

export type SearchProduct = {
  barcode: string;
  name: string;
  brand: string | null;
  pack_size: string | null;
  image_url: string | null;
};

export type ProductRequestResponse = {
  message?: string;
  request?: { barcode: string; product_hint: string | null; request_count: number; last_requested_at: string };
  error?: string;
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_PRICE_API_URL ??
  "https://pricecheck-backend-7tkh.onrender.com";
const PRODUCT_CACHE_PREFIX = "pricecheck-result:";

export function cacheComparison(comparison: ComparisonResponse) {
  if (typeof window === "undefined" || !comparison?.barcode) return;
  try { window.localStorage.setItem(`${PRODUCT_CACHE_PREFIX}${comparison.barcode}`, JSON.stringify({ comparison, cachedAt: new Date().toISOString() })); } catch { /* local storage is optional */ }
}

export function getCachedComparison(barcode: string): { comparison: ComparisonResponse; cachedAt: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(`${PRODUCT_CACHE_PREFIX}${barcode}`) || "null");
    if (value?.comparison?.barcode === barcode && Array.isArray(value.comparison.results)) return value;
  } catch { /* ignore malformed browser storage */ }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  // The test backend can cold-start after idle time. Allow one bounded warm-up request
  // instead of aborting before the server can return its typed retailer result.
  const timeout = window.setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...init?.headers },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T;
    return { response, body };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function getComparison(barcode: string, refresh = false) {
  return request<ComparisonResponse & { error?: string; message?: string }>(
    refresh ? `/price/${encodeURIComponent(barcode)}/refresh` : `/price/${encodeURIComponent(barcode)}`,
    refresh ? { method: "POST" } : undefined,
  );
}

export async function searchProducts(query: string) {
  return request<{ results: SearchProduct[]; error?: string; message?: string }>(
    `/search?q=${encodeURIComponent(query)}`,
  );
}

export async function submitProductRequest(barcode: string, productHint: string) {
  return request<ProductRequestResponse>("/product-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode, product_hint: productHint.trim() || undefined }),
  });
}

export function retailerName(retailer: string) {
  return (
    {
      woolworths: "Woolworths",
      pick_n_pay: "Pick n Pay",
      checkers: "Checkers",
      spar: "SPAR",
    }[retailer] ?? retailer
  );
}

export function retailerInitials(retailer: string) {
  return (
    {
      woolworths: "WW",
      pick_n_pay: "PnP",
      checkers: "CH",
      spar: "SP",
    }[retailer] ?? retailer.slice(0, 2).toUpperCase()
  );
}

export function retailerClass(retailer: string) {
  return `retailer-${retailer.replace(/[^a-z_]/g, "")}`;
}

export function relativeTime(timestamp: string | null) {
  if (!timestamp) return "No update yet";
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Update time unavailable";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}
