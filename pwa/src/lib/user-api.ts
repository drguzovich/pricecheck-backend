import { guestDataPayload } from "@/lib/guest-data";

const API_BASE_URL = process.env.NEXT_PUBLIC_PRICE_API_URL ?? "https://pricecheck-backend-7tkh.onrender.com";

export async function registerDirectAccount(input: { displayName: string; email: string; password: string }) {
  const response = await fetch(`${API_BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ displayName: input.displayName, email: input.email, password: input.password }),
  });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || "Unable to create an account right now.");
  return body;
}

export async function getAccountToken() {
  const response = await fetch("/api/account-token", { cache: "no-store" });
  if (!response.ok) return null;
  const body = await response.json() as { token?: string };
  return body.token ?? null;
}

export async function userRequest<T>(path: string, init?: RequestInit) {
  const token = await getAccountToken();
  if (!token) throw new Error("Sign in is required for this action.");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...init?.headers },
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
export type StoredAlert = { id: number; barcode: string; target_price: number; active: boolean; created_at: string };

export function accountSummary() { return userRequest<{ summary: AccountSummary }>("/users/me"); }
export function cloudHistory() { return userRequest<{ scans: StoredScan[] }>("/users/scans"); }
export function recordCloudScan(barcode: string, productName: string, lastPrice: number | null) {
  return userRequest<{ scan: StoredScan }>("/users/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, product_name: productName, last_price: lastPrice, scanned_at: new Date().toISOString() }) });
}
export function cloudFavourites() { return userRequest<{ favourites: StoredFavourite[] }>("/users/favourites"); }
export function addCloudFavourite(barcode: string, productName: string) {
  return userRequest<{ favourite: StoredFavourite }>("/users/favourites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, product_name: productName }) });
}
export function removeCloudFavourite(barcode: string) { return userRequest<{ removed: boolean }>(`/users/favourites?barcode=${encodeURIComponent(barcode)}`, { method: "DELETE" }); }
export function cloudAlerts() { return userRequest<{ alerts: StoredAlert[] }>("/users/alerts"); }
export function createCloudAlert(barcode: string, targetPrice: number) {
  return userRequest<{ alert: StoredAlert }>("/users/alerts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcode, target_price: targetPrice }) });
}
export function removeCloudAlert(id: number) { return userRequest<{ removed: boolean }>(`/users/alerts?id=${id}`, { method: "DELETE" }); }
