export const SCAN_QUEUE_KEY = "trolleywise-scan-queue:v1";
export const SCAN_QUEUE_LIMIT = 100;
export const SCAN_COMPARE_CONCURRENCY = 2;
export const SCAN_SAVE_CONCURRENCY = 2;
export const SCAN_COMPARE_TIMEOUT_MS = 35_000;

export type ScanQueueStatus = "queued" | "loading" | "success" | "missing" | "error" | "cancelled";
export type ScanQueueOffer = {
  price: number;
  retailer: string;
  updatedAt: string | null;
  stale: boolean;
  fromCache: boolean;
};
export type ScanQueueItem = {
  barcode: string;
  source: "camera" | "manual";
  addedAt: string;
  status: ScanQueueStatus;
  productName: string | null;
  offer: ScanQueueOffer | null;
  checkedAt: string | null;
  error: string | null;
  historyRecorded: boolean;
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}
function text(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

/** Keep leading zeroes. Do not convert unrelated letters into a plausible barcode. */
export function normalizeScanBarcode(value: string): string | null {
  const normalized = value.trim().replace(/[\s-]/g, "");
  return /^\d{8,14}$/.test(normalized) ? normalized : null;
}

export function enqueueScan(
  items: readonly ScanQueueItem[], value: string, source: ScanQueueItem["source"], now = new Date().toISOString(),
): { items: ScanQueueItem[]; outcome: "added" | "duplicate" | "invalid" | "full"; barcode: string | null } {
  const barcode = normalizeScanBarcode(value);
  if (!barcode) return { items: [...items], outcome: "invalid", barcode: null };
  if (items.some((item) => item.barcode === barcode)) return { items: [...items], outcome: "duplicate", barcode };
  if (items.length >= SCAN_QUEUE_LIMIT) return { items: [...items], outcome: "full", barcode };
  return {
    items: [...items, { barcode, source, addedAt: now, status: "queued", productName: null, offer: null, checkedAt: null, error: null, historyRecorded: false }],
    outcome: "added", barcode,
  };
}

/** A retailer list belongs to ONE barcode, not to multiple scanned products. */
export function summarizeScanComparison(value: unknown, barcode: string, checkedAt: string, staleResponse = false): Pick<ScanQueueItem, "status" | "productName" | "offer" | "checkedAt" | "error"> {
  const body = object(value);
  const product = object(body?.product);
  if (!body || body.barcode !== barcode || (product?.barcode !== undefined && product.barcode !== barcode)) {
    throw new Error("The price service returned a different or invalid barcode. Retry this item.");
  }
  const offers = (Array.isArray(body.results) ? body.results : []).flatMap((value) => {
    const row = object(value);
    const retailer = text(row?.retailer, 60);
    if (!row || row.available !== true || !retailer || typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0 || (row.currency !== undefined && row.currency !== "ZAR")) return [];
    return [{ price: row.price, retailer, updatedAt: timestamp(row.updated_at) || timestamp(row.updatedAt), stale: staleResponse || row.stale === true, fromCache: staleResponse || row.from_cache === true }];
  }).sort((a, b) => a.price - b.price);
  const offer = offers[0] || null;
  return { status: offer ? "success" : "missing", productName: text(product?.name, 240), offer, checkedAt, error: null };
}

/** Restore only a bounded, validated summary. Interrupted work requires an explicit retry. */
export function restoreScanQueue(raw: string | null): ScanQueueItem[] {
  if (!raw) return [];
  if (raw.length > 256_000) throw new Error("The saved queue is too large to restore safely.");
  const stored: unknown = JSON.parse(raw);
  const payload = object(stored);
  if (payload?.version !== 1 || !Array.isArray(payload.items)) throw new Error("The saved queue format is not supported.");
  const items: ScanQueueItem[] = [];
  const seen = new Set<string>();
  for (const value of payload.items) {
    if (items.length >= SCAN_QUEUE_LIMIT) break;
    const row = object(value);
    const barcode = typeof row?.barcode === "string" ? normalizeScanBarcode(row.barcode) : null;
    const addedAt = timestamp(row?.addedAt);
    if (!row || !barcode || !addedAt || seen.has(barcode)) continue;
    seen.add(barcode);
    const validStatus = ["queued", "loading", "success", "missing", "error", "cancelled"].includes(String(row.status));
    const status = validStatus && row.status !== "loading" ? row.status as ScanQueueStatus : "cancelled";
    const savedOffer = object(row.offer);
    const retailer = text(savedOffer?.retailer, 60);
    const offer = savedOffer && retailer && typeof savedOffer.price === "number" && Number.isFinite(savedOffer.price) && savedOffer.price > 0
      ? { price: savedOffer.price, retailer, updatedAt: timestamp(savedOffer.updatedAt), stale: true, fromCache: true } : null;
    items.push({ barcode, addedAt, source: row.source === "camera" ? "camera" : "manual", status: status === "success" && !offer ? "missing" : status, productName: text(row.productName, 240), offer, checkedAt: timestamp(row.checkedAt), error: status === "cancelled" ? "Comparison interrupted. Retry when you are ready." : text(row.error, 300), historyRecorded: row.historyRecorded === true });
  }
  return items;
}

export function serializeScanQueue(items: readonly ScanQueueItem[]): string {
  return JSON.stringify({ version: 1, items: items.slice(0, SCAN_QUEUE_LIMIT) });
}

/** Each task settles independently; callers handle per-item errors without stopping later items. */
export async function runBounded<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  }));
}
