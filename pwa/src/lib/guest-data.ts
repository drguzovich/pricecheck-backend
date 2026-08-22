export type GuestScan = { barcode: string; productName: string; lastPrice: number | null; scannedAt: string };
export type GuestFavourite = { barcode: string; productName: string; addedAt: string };

const HISTORY_KEY = "pricecheck-guest-history";
const FAVOURITES_KEY = "pricecheck-guest-favourites";
const LIMIT = 100;

function read<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try { const value = JSON.parse(window.localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
function write<T>(key: string, entries: T[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(entries.slice(0, LIMIT)));
}

export function readGuestHistory() { return read<GuestScan>(HISTORY_KEY).filter((scan) => Boolean(scan?.barcode && scan?.productName)); }
export function recordGuestScan(scan: GuestScan) {
  const next = [scan, ...readGuestHistory().filter((item) => item.barcode !== scan.barcode)];
  write(HISTORY_KEY, next);
  window.dispatchEvent(new Event("pricecheck-guest-data"));
}
export function readGuestFavourites() { return read<GuestFavourite>(FAVOURITES_KEY).filter((item) => Boolean(item?.barcode && item?.productName)); }
export function isGuestFavourite(barcode: string) { return readGuestFavourites().some((item) => item.barcode === barcode); }
export function toggleGuestFavourite(favourite: GuestFavourite) {
  const existing = readGuestFavourites();
  const saved = !existing.some((item) => item.barcode === favourite.barcode);
  write(FAVOURITES_KEY, saved ? [favourite, ...existing] : existing.filter((item) => item.barcode !== favourite.barcode));
  window.dispatchEvent(new Event("pricecheck-guest-data"));
  return saved;
}
export function guestDataPayload() { return { scans: readGuestHistory(), favourites: readGuestFavourites() }; }
export function clearGuestData() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(HISTORY_KEY);
  window.localStorage.removeItem(FAVOURITES_KEY);
  window.dispatchEvent(new Event("pricecheck-guest-data"));
}
