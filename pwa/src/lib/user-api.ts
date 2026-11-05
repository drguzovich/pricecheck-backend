import { guestDataPayload } from "@/lib/guest-data";
import { backendRequest } from "@/lib/backend-api";

export async function registerDirectAccount(input: { displayName: string; email: string; password: string }) {
  const response = await backendRequest("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ displayName: input.displayName, email: input.email, password: input.password }),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || "Unable to create an account right now.");
  return body;
}

export async function getAccountToken(expectedIdentity?: string) {
  const response = await fetch("/api/account-token", { cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as { token?: string };
  if (body.token && expectedIdentity) {
    try {
      const encoded = body.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)))) as { account_id?: string; google_id?: string; email?: string };
      if (payload.account_id !== expectedIdentity && payload.google_id !== expectedIdentity && payload.email?.toLowerCase() !== expectedIdentity.toLowerCase()) throw new Error("Changed account");
    } catch {
      throw new Error("Your signed-in account changed. Check the current account before retrying.");
    }
  }
  return body.token ?? null;
}

export type AccountRequestGuard = { expectedIdentity?: string; shouldProceed?: () => boolean };

export async function userRequest<T>(path: string, init?: RequestInit, guard?: AccountRequestGuard) {
  const checkOwner = () => {
    if (guard?.shouldProceed && !guard.shouldProceed()) throw new Error("Your signed-in account or scan queue changed. Check the current account before retrying.");
  };
  checkOwner();
  const token = await getAccountToken(guard?.expectedIdentity);
  // Token issuance is asynchronous: never start a mutation after its owner changed.
  checkOwner();
  if (!token) throw new Error("Sign in is required for this action.");
  const response = await backendRequest(path, {
    ...init,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error((body as { message?: string }).message || "Account data is temporarily unavailable.");
  return body;
}

export async function migrateGuestData() {
  return userRequest<{ summary: { scanCount: number; favouritesCount: number; alertsCount: number } }>("/users/migrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(guestDataPayload()),
  });
}

export type AccountSummary = { scanCount: number; favouritesCount: number; alertsCount: number };
export type StoredScan = { id: number; barcode: string; product_name: string; last_price: number | null; scanned_at: string };
export type StoredFavourite = { id: number; barcode: string; product_name: string; added_at: string };
export type StoredAlert = { id: number; barcode: string; product_name?: string | null; target_price: number; active: boolean; created_at: string; last_sent_at?: string | null; last_sent_price?: number | null };

export type WatchlistPrice = { retailer: string; price: number; currency: "ZAR"; updated_at: string | null; url: string | null; stale: boolean };
export type WatchlistItem = {
  barcode: string; product_name: string; favourite: boolean;
  availability: "available" | "unavailable" | "failed" | "not_checked";
  best: WatchlistPrice | null; lastKnownBest: WatchlistPrice | null;
  last_checked_at: string | null; last_available_at: string | null; stale: boolean;
};
export type WatchlistMonitoring = {
  workerConfigured: boolean; databaseConfigured: boolean; scheduleHours: number;
  lastSuccessfulRunAt: string | null;
  latestRun: { started_at: string; finished_at: string | null; state: string; metrics: { checked?: number; available?: number; unavailable?: number; deferred?: number; remaining?: number; queueTotal?: number; watchedTotal?: number; sent?: number } } | null;
  deliveryEnabled: boolean; deliveryStatus?: string; deliveryMessage?: string;
};
export type WatchlistTrendPoint = { checked_at: string; best_price: number | null; checks: number; available_checks: number };
export type AlertSaveResponse = { alert: StoredAlert; deliveryEnabled: boolean; deliveryMessage?: string; monitoring?: WatchlistMonitoring };

export function cloudWatchlist() { return userRequest<{ items: WatchlistItem[]; monitoring: WatchlistMonitoring }>("/users/watchlist"); }
export function watchlistTrend(barcode: string) { return userRequest<{ points: WatchlistTrendPoint[]; description: string }>(`/users/watchlist/${encodeURIComponent(barcode)}/trend`); }
export function refreshWatchlistItem(barcode: string) { return userRequest<{ item: WatchlistItem; monitoring: WatchlistMonitoring }>(`/users/watchlist/${encodeURIComponent(barcode)}/refresh`, { method: "POST" }); }
export function createWatchlistAlert(barcode: string, targetPrice: number) {
  return userRequest<AlertSaveResponse>(`/users/watchlist/${encodeURIComponent(barcode)}/alert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_price: targetPrice }) });
}

export function accountSummary() { return userRequest<{ summary: AccountSummary }>("/users/me"); }
export function cloudHistory() { return userRequest<{ scans: StoredScan[] }>("/users/scans"); }
export function recordCloudScan(barcode: string, productName: string, lastPrice: number | null, options?: AccountRequestGuard & { scannedAt?: string }) {
  return userRequest<{ scan: StoredScan }>("/users/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, product_name: productName, last_price: lastPrice, scanned_at: options?.scannedAt ?? new Date().toISOString() }) }, options);
}
export function cloudFavourites() { return userRequest<{ favourites: StoredFavourite[] }>("/users/favourites"); }
export function addCloudFavourite(barcode: string, productName: string, guard?: AccountRequestGuard) {
  return userRequest<{ favourite: StoredFavourite }>("/users/favourites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, product_name: productName }) }, guard);
}
export function removeCloudFavourite(barcode: string) { return userRequest<{ removed: boolean }>(`/users/favourites?barcode=${encodeURIComponent(barcode)}`, { method: "DELETE" }); }
export function cloudAlerts() { return userRequest<{ alerts: StoredAlert[] }>("/users/alerts"); }
export function createCloudAlert(barcode: string, targetPrice: number) {
  return userRequest<AlertSaveResponse>("/users/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, target_price: targetPrice }) });
}
export function removeCloudAlert(id: number) { return userRequest<{ removed: boolean }>(`/users/alerts?id=${id}`, { method: "DELETE" }); }
