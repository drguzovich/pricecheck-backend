export type GuestScan = { id: string; barcode: string; productName: string; lastPrice: number | null; scannedAt: string };
export type GuestFavourite = { id: string; barcode: string; productName: string; addedAt: string };

const HISTORY_KEY = "pricecheck-guest-history";
const FAVOURITES_KEY = "pricecheck-guest-favourites";
const SCAN_COUNT_KEY = "pricecheck-guest-scan-count";
const LIMIT = 100;

function read<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try { const value = JSON.parse(window.localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
function write<T>(key: string, entries: T[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(entries.slice(0, LIMIT)));
}

function stableId(kind: "scan" | "favourite", barcode: string, timestamp: string) {
  return `${kind}:${barcode}:${timestamp}`;
}

function normalizeScan(scan: Partial<GuestScan>): GuestScan | null {
  if (!scan?.barcode || !scan.productName || !scan.scannedAt) return null;
  return {
    id: scan.id || stableId("scan", String(scan.barcode), String(scan.scannedAt)),
    barcode: String(scan.barcode),
    productName: String(scan.productName),
    lastPrice: scan.lastPrice === null || scan.lastPrice === undefined ? null : Number.isFinite(Number(scan.lastPrice)) ? Number(scan.lastPrice) : null,
    scannedAt: String(scan.scannedAt),
  };
}

function normalizeFavourite(favourite: Partial<GuestFavourite>): GuestFavourite | null {
  if (!favourite?.barcode || !favourite.productName || !favourite.addedAt) return null;
  return {
    id: favourite.id || stableId("favourite", String(favourite.barcode), String(favourite.addedAt)),
    barcode: String(favourite.barcode),
    productName: String(favourite.productName),
    addedAt: String(favourite.addedAt),
  };
}

export function readGuestHistory() {
  return read<Partial<GuestScan>>(HISTORY_KEY)
    .map(normalizeScan)
    .filter((scan): scan is GuestScan => Boolean(scan))
    .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
}
export function readGuestScanCount() {
  if (typeof window === "undefined") return 0;
  const stored = window.localStorage.getItem(SCAN_COUNT_KEY);
  if (stored !== null) {
    const count = Number(stored);
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return readGuestHistory().length;
}
export function recordGuestScan(scan: Omit<GuestScan, "id"> & { id?: string }) {
  const normalized = normalizeScan({ ...scan, id: scan.id || stableId("scan", scan.barcode, scan.scannedAt) });
  if (!normalized) return;
  const next = [normalized, ...readGuestHistory().filter((item) => item.barcode !== normalized.barcode)];
  write(HISTORY_KEY, next);
  window.localStorage.setItem(SCAN_COUNT_KEY, String(readGuestScanCount() + 1));
  window.dispatchEvent(new Event("pricecheck-guest-data"));
}
export function readGuestFavourites() {
  return read<Partial<GuestFavourite>>(FAVOURITES_KEY)
    .map(normalizeFavourite)
    .filter((favourite): favourite is GuestFavourite => Boolean(favourite))
    .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
}
export function isGuestFavourite(barcode: string) { return readGuestFavourites().some((item) => item.barcode === barcode); }
export function toggleGuestFavourite(favourite: Omit<GuestFavourite, "id"> & { id?: string }) {
  const existing = readGuestFavourites();
  const saved = !existing.some((item) => item.barcode === favourite.barcode);
  const normalized = normalizeFavourite({ ...favourite, id: favourite.id || stableId("favourite", favourite.barcode, favourite.addedAt) });
  if (!normalized) return false;
  write(FAVOURITES_KEY, saved ? [normalized, ...existing] : existing.filter((item) => item.barcode !== favourite.barcode));
  window.dispatchEvent(new Event("pricecheck-guest-data"));
  return saved;
}
function clientId() {
  if (typeof window === "undefined") return "";
  const key = "pricecheck-guest-client-id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(key, created);
  return created;
}

export function guestDataPayload() {
  return { schemaVersion: 1, clientId: clientId(), scans: readGuestHistory(), favourites: readGuestFavourites() };
}
export function clearGuestData() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(HISTORY_KEY);
  window.localStorage.removeItem(FAVOURITES_KEY);
  window.localStorage.removeItem(SCAN_COUNT_KEY);
  window.dispatchEvent(new Event("pricecheck-guest-data"));
}
