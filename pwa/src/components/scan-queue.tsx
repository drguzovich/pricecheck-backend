"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { backendRequest } from "@/lib/backend-api";
import { isGuestFavourite, readGuestFavourites, recordGuestScan, toggleGuestFavourite } from "@/lib/guest-data";
import { addCloudFavourite, cloudFavourites, recordCloudScan } from "@/lib/user-api";
import { retailerName } from "@/lib/price-api";
import { GuestSignupPrompt } from "@/components/guest-signup-prompt";
import { enqueueScan, restoreScanQueue, runBounded, SCAN_COMPARE_CONCURRENCY, SCAN_COMPARE_TIMEOUT_MS, SCAN_QUEUE_KEY, SCAN_QUEUE_LIMIT, SCAN_SAVE_CONCURRENCY, serializeScanQueue, summarizeScanComparison, type ScanQueueItem } from "@/lib/scan-queue";

export type ScanQueueHandle = { add: (barcode: string, source: "manual" | "camera") => ReturnType<typeof enqueueScan>["outcome"] };
type SaveState = { status: "saving" | "saved" | "error"; message: string };
type HistoryCandidate = { owner: string | null; ownerStatus: "authenticated" | "unauthenticated" | null };
const historyKey = (item: ScanQueueItem) => `${item.barcode}:${item.addedAt}`;
const labels = { queued: "Waiting to compare", loading: "Checking retailer prices", success: "Comparison ready", missing: "No confirmed price available", error: "Comparison failed", cancelled: "Comparison cancelled" };

export const ScanQueue = forwardRef<ScanQueueHandle>(function ScanQueue(_, ref) {
  const { data: session, status } = useSession();
  const [items, setItems] = useState<ScanQueueItem[]>([]);
  const [ready, setReady] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [favouritesReady, setFavouritesReady] = useState(false);
  const [favouritesError, setFavouritesError] = useState("");
  const [favouritesVersion, setFavouritesVersion] = useState(0);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({});
  const [workVersion, setWorkVersion] = useState(0);
  const itemsRef = useRef<ScanQueueItem[]>([]);
  const mounted = useRef(false);
  const storageEnabled = useRef(true);
  const comparisons = useRef(new Map<string, AbortController>());
  const recordingHistory = useRef(new Set<string>());
  // Deliberately never restored from device storage. Only add / explicit history retry creates a candidate.
  const historyCandidates = useRef(new Map<string, HistoryCandidate>());
  const saving = useRef(new Set<string>());
  const historyFailures = useRef(new Set<string>());
  const batchBusyRef = useRef(false);
  const accountKey = status === "authenticated" ? (session?.user as { id?: string })?.id || session?.user?.email?.toLowerCase() || null : status;
  const accountRef = useRef(accountKey);
  accountRef.current = accountKey;
  const sessionStatusRef = useRef(status);
  sessionStatusRef.current = status;

  const commit = useCallback((update: (current: ScanQueueItem[]) => ScanQueueItem[]) => {
    if (!mounted.current) return;
    const next = update(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const activeComparisons = comparisons.current;
    try {
      const restored = restoreScanQueue(window.localStorage.getItem(SCAN_QUEUE_KEY));
      itemsRef.current = restored;
      setItems(restored);
    } catch {
      storageEnabled.current = false;
      setPersistenceError("Your saved queue could not be read. It has not been overwritten. New scans will stay in this tab until device saving is reset.");
    }
    setReady(true);
    return () => {
      mounted.current = false;
      activeComparisons.forEach((controller) => controller.abort());
      activeComparisons.clear();
    };
  }, []);

  useEffect(() => {
    if (!ready || !storageEnabled.current) return;
    try {
      window.localStorage.setItem(SCAN_QUEUE_KEY, serializeScanQueue(items));
      setPersistenceError("");
    } catch {
      setPersistenceError("Device storage is unavailable or full. This queue is only kept in this tab. Free some space and retry device saving.");
    }
  }, [items, ready]);

  useImperativeHandle(ref, () => ({ add(value, source) {
    const result = enqueueScan(itemsRef.current, value, source);
    if (result.outcome === "added") {
      const item = result.items[result.items.length - 1];
      const ownerStatus = sessionStatusRef.current;
      historyCandidates.current.set(historyKey(item), {
        owner: ownerStatus === "loading" ? null : accountRef.current,
        ownerStatus: ownerStatus === "loading" ? null : ownerStatus,
      });
      commit(() => result.items);
      setNotice(`Added barcode ${result.barcode}. Keep scanning to add your next product.`);
    } else if (result.outcome === "full") {
      setNotice(`Your queue has ${SCAN_QUEUE_LIMIT} products. Remove an item or clear the queue before adding more.`);
    } else if (result.outcome === "duplicate" && source === "manual") {
      setNotice(`Barcode ${result.barcode} is already in your queue. Use its Retry or View comparison action.`);
    }
    return result.outcome;
  } }), [commit]);

  useEffect(() => {
    if (!ready) return;
    const capacity = SCAN_COMPARE_CONCURRENCY - comparisons.current.size;
    for (const item of itemsRef.current.filter((row) => row.status === "queued" && !comparisons.current.has(row.barcode)).slice(0, capacity)) {
      const controller = new AbortController();
      comparisons.current.set(item.barcode, controller);
      commit((current) => current.map((row) => row.barcode === item.barcode ? { ...row, status: "loading", error: null } : row));
      void (async () => {
        let timedOut = false;
        const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, SCAN_COMPARE_TIMEOUT_MS);
        try {
          const response = await backendRequest(`/price/${encodeURIComponent(item.barcode)}`, { signal: controller.signal });
          const body = await response.json();
          if (!response.ok && response.status !== 404) throw new Error(response.status === 429 ? "Too many price requests. Wait a moment, then retry this product." : "The price service is temporarily unavailable. Retry this product.");
          const stale = response.headers.get("X-TrolleyWise-Cache") === "stale" || response.headers.get("X-PriceCheck-Cache") === "stale";
          const summary = summarizeScanComparison(body, item.barcode, new Date().toISOString(), stale);
          if (!controller.signal.aborted && comparisons.current.get(item.barcode) === controller) {
            commit((current) => current.map((row) => row.barcode === item.barcode && row.status === "loading" ? { ...row, ...summary } : row));
          }
        } catch (error) {
          if (!controller.signal.aborted || timedOut) {
            commit((current) => current.map((row) => row.barcode === item.barcode && row.status === "loading" ? { ...row, status: "error", error: timedOut ? "The comparison timed out. Retry this product when you are ready." : error instanceof Error ? error.message : "Could not compare this product. Please retry." } : row));
          }
        } finally {
          window.clearTimeout(timer);
          if (comparisons.current.get(item.barcode) === controller) comparisons.current.delete(item.barcode);
          if (mounted.current) setWorkVersion((version) => version + 1);
        }
      })();
    }
  }, [commit, items, ready, workVersion]);

  useEffect(() => {
    if (!ready || status === "loading" || !accountKey) return;
    historyCandidates.current.forEach((candidate, key) => {
      // A scan added while loading belongs to the FIRST settled owner, not a later account.
      if (candidate.owner === null) { candidate.owner = accountKey; candidate.ownerStatus = status; }
      else if (candidate.owner !== accountKey || candidate.ownerStatus !== status) historyCandidates.current.delete(key);
    });
    const candidates = itemsRef.current.filter((item) => {
      const key = historyKey(item);
      const candidate = historyCandidates.current.get(key);
      return !item.historyRecorded && (item.status === "success" || item.status === "missing") && candidate?.owner === accountKey && candidate.ownerStatus === status && !recordingHistory.current.has(key) && !historyFailures.current.has(key);
    }).slice(0, Math.max(0, 2 - recordingHistory.current.size));
    for (const item of candidates) {
      const owner = accountKey;
      const ownerStatus = status;
      const key = historyKey(item);
      const candidate = historyCandidates.current.get(key);
      const shouldProceed = () => mounted.current && accountRef.current === owner && sessionStatusRef.current === ownerStatus && historyCandidates.current.get(key) === candidate && itemsRef.current.some((row) => historyKey(row) === key);
      const lastPrice = item.offer?.stale ? null : item.offer?.price ?? null;
      recordingHistory.current.add(key);
      void (async () => {
        try {
          if (!shouldProceed()) throw new Error("The account or scan queue changed.");
          if (ownerStatus === "authenticated") {
            const response = await recordCloudScan(item.barcode, item.productName || item.barcode, lastPrice, { scannedAt: item.addedAt, expectedIdentity: owner, shouldProceed });
            if (response.scan?.barcode !== item.barcode) throw new Error("History save was not confirmed.");
          } else {
            recordGuestScan({ barcode: item.barcode, productName: item.productName || item.barcode, lastPrice, scannedAt: item.addedAt });
          }
          if (shouldProceed()) {
            commit((current) => current.map((row) => historyKey(row) === key ? { ...row, historyRecorded: true } : row));
            historyCandidates.current.delete(key);
          }
        } catch {
          historyFailures.current.add(key);
          if (mounted.current && accountRef.current === owner && sessionStatusRef.current === ownerStatus) {
            setHistoryErrors((current) => ({ ...current, [key]: "This scan's history save is not confirmed. You can still view its comparison." }));
          }
        } finally {
          recordingHistory.current.delete(key);
          if (mounted.current) setWorkVersion((version) => version + 1);
        }
      })();
    }
  }, [accountKey, commit, items, ready, status, workVersion]);

  useEffect(() => {
    let active = true;
    setFavouritesReady(false);
    setFavouritesError("");
    setSaved(new Set());
    if (status === "authenticated") {
      cloudFavourites().then(({ favourites }) => {
        if (!Array.isArray(favourites)) throw new Error("Saved products returned an invalid response.");
        if (active) { setSaved(new Set(favourites.map((item) => item.barcode))); setFavouritesReady(true); }
      }).catch(() => { if (active) setFavouritesError("Could not check your cloud favourites. Retry before saving products."); });
    } else if (status === "unauthenticated") {
      setSaved(new Set(readGuestFavourites().map((item) => item.barcode)));
      setFavouritesReady(true);
    }
    return () => { active = false; };
  }, [accountKey, favouritesVersion, status]);

  useEffect(() => {
    setSaveStates({});
    setSelected(new Set());
    setHistoryErrors({});
  }, [accountKey]);

  useEffect(() => {
    const refresh = () => setFavouritesVersion((version) => version + 1);
    window.addEventListener("storage", refresh);
    window.addEventListener("pricecheck-guest-data", refresh);
    window.addEventListener("trolleywise-guest-data", refresh);
    window.addEventListener("trolleywise-favourites-changed", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("pricecheck-guest-data", refresh);
      window.removeEventListener("trolleywise-guest-data", refresh);
      window.removeEventListener("trolleywise-favourites-changed", refresh);
    };
  }, []);

  const saveProducts = async (barcodes: string[]) => {
    if (!favouritesReady || batchBusyRef.current || status === "loading") return;
    const owner = accountKey;
    const ownerStatus = status;
    const candidates = itemsRef.current.filter((item) => barcodes.includes(item.barcode) && !saved.has(item.barcode) && !saving.current.has(item.barcode));
    batchBusyRef.current = true;
    setBatchBusy(true);
    await runBounded(candidates, SCAN_SAVE_CONCURRENCY, async (item) => {
      const shouldProceed = () => mounted.current && accountRef.current === owner && sessionStatusRef.current === ownerStatus && itemsRef.current.some((row) => historyKey(row) === historyKey(item));
      if (!shouldProceed() || !owner) return;
      saving.current.add(item.barcode);
      setSaveStates((current) => ({ ...current, [item.barcode]: { status: "saving", message: ownerStatus === "authenticated" ? "Saving to your account…" : "Saving on this device…" } }));
      try {
        if (ownerStatus === "authenticated") {
          const result = await addCloudFavourite(item.barcode, item.productName || item.barcode, { expectedIdentity: owner, shouldProceed });
          if (result.favourite?.barcode !== item.barcode) throw new Error("The save was not confirmed. Retry this product.");
        } else if (!isGuestFavourite(item.barcode)) {
          if (readGuestFavourites().length >= SCAN_QUEUE_LIMIT) throw new Error("You have 100 device favourites. Remove a favourite before saving more.");
          const confirmed = toggleGuestFavourite({ barcode: item.barcode, productName: item.productName || item.barcode, addedAt: new Date().toISOString() });
          if (!confirmed || !isGuestFavourite(item.barcode)) throw new Error("Device storage did not confirm this save. Please retry.");
        }
        if (mounted.current && accountRef.current === owner) {
          setSaved((current) => new Set(current).add(item.barcode));
          setSelected((current) => { const next = new Set(current); next.delete(item.barcode); return next; });
          setSaveStates((current) => ({ ...current, [item.barcode]: { status: "saved", message: ownerStatus === "authenticated" ? "Saved to your account." : "Saved on this device only." } }));
        }
      } catch (error) {
        if (mounted.current && accountRef.current === owner) setSaveStates((current) => ({ ...current, [item.barcode]: { status: "error", message: error instanceof Error ? error.message : "This product was not saved. Retry it." } }));
      } finally {
        saving.current.delete(item.barcode);
      }
    });
    batchBusyRef.current = false;
    if (mounted.current) setBatchBusy(false);
    if (mounted.current && ownerStatus === "authenticated" && accountRef.current === owner) window.dispatchEvent(new Event("trolleywise-favourites-changed"));
  };

  const cancel = (barcode?: string) => {
    comparisons.current.forEach((controller, code) => { if (!barcode || barcode === code) controller.abort(); });
    commit((current) => current.map((item) => (!barcode || item.barcode === barcode) && (item.status === "queued" || item.status === "loading") ? { ...item, status: "cancelled", error: "Comparison cancelled. Retry when you are ready." } : item));
  };
  const retry = (barcode: string) => commit((current) => current.map((item) => item.barcode === barcode ? { ...item, status: "queued", error: null, offer: null } : item));
  const retryHistory = (item: ScanQueueItem) => {
    const key = historyKey(item);
    if (status === "loading" || !accountKey || recordingHistory.current.has(key)) return;
    if (!window.confirm("An earlier save may have completed. Check your history first; retrying may create a duplicate. Retry this save for the current account?")) return;
    historyCandidates.current.set(key, { owner: accountKey, ownerStatus: status });
    historyFailures.current.delete(key);
    setHistoryErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    setWorkVersion((version) => version + 1);
  };
  const remove = (barcode: string) => {
    const item = itemsRef.current.find((row) => row.barcode === barcode);
    if (item) {
      const key = historyKey(item);
      historyCandidates.current.delete(key);
      historyFailures.current.delete(key);
      setHistoryErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    }
    comparisons.current.get(barcode)?.abort();
    commit((current) => current.filter((item) => item.barcode !== barcode));
    setSelected((current) => { const next = new Set(current); next.delete(barcode); return next; });
    setSaveStates((current) => { const next = { ...current }; delete next[barcode]; return next; });
  };
  const clear = () => {
    if (!window.confirm("Clear this scan queue? Your saved favourites and history will stay.")) return;
    cancel();
    commit(() => []);
    setSelected(new Set());
    setSaveStates({});
    setHistoryErrors({});
    historyFailures.current.clear();
    historyCandidates.current.clear();
    setNotice("Queue cleared. Your favourites and history have not been removed.");
  };
  const selectable = items.filter((item) => !saved.has(item.barcode));
  const pending = items.filter((item) => item.status === "queued" || item.status === "loading").length;

  return <section className="scan-queue" aria-labelledby="scan-queue-heading">
    <div className="scan-queue-heading"><div><span className="eyebrow">Your scan queue</span><h2 id="scan-queue-heading">{items.length ? `${items.length} product${items.length === 1 ? "" : "s"}` : "Ready for your next shop"}</h2></div><span className="scan-queue-count">{items.length} / {SCAN_QUEUE_LIMIT}</span></div>
    <p className="scan-queue-description">Real barcode lookups, one product per row. This queue stays on this device, including when you sign in. Demo samples are separate.</p>
    {notice && <p className="scan-queue-notice" role="status">{notice}</p>}
    {!ready && <p role="status">Loading your saved queue…</p>}
    {persistenceError && <aside className="scan-queue-error" role="status"><p>{persistenceError}</p><button className="button button-secondary" type="button" onClick={() => {
      if (!storageEnabled.current && !window.confirm("Replace the unreadable saved queue with the products in this tab?")) return;
      try { window.localStorage.setItem(SCAN_QUEUE_KEY, serializeScanQueue(itemsRef.current)); storageEnabled.current = true; setPersistenceError(""); } catch { setPersistenceError("Device saving is still unavailable. Your queue remains in this tab."); }
    }}>Retry device saving</button></aside>}
    {favouritesError && <aside className="scan-queue-error" role="status"><p>{favouritesError}</p><button className="button button-secondary" type="button" onClick={() => setFavouritesVersion((version) => version + 1)}>Retry favourites</button></aside>}
    {items.length > 0 && <div className="scan-queue-toolbar">
      <button className="button button-secondary" type="button" disabled={!favouritesReady || batchBusy || !selectable.length} onClick={() => setSelected(selected.size === selectable.length ? new Set() : new Set(selectable.map((item) => item.barcode)))}>{selected.size === selectable.length && selectable.length > 0 ? "Deselect all" : "Select unsaved"}</button>
      <button className="button button-primary" type="button" disabled={!selected.size || !favouritesReady || batchBusy} onClick={() => void saveProducts(Array.from(selected))}>{batchBusy ? "Saving products…" : `Save selected${selected.size ? ` (${selected.size})` : ""}`}</button>
      {pending > 0 && <button className="button button-secondary" type="button" onClick={() => cancel()}>Cancel pending</button>}
      <button className="button button-secondary" type="button" disabled={batchBusy} onClick={clear}>Clear queue</button>
    </div>}
    {items.length === 0 && ready && <div className="scan-queue-empty"><strong>Scan continuously or enter a barcode.</strong><p>Each unique barcode is compared separately. Repeated camera reads are not added again.</p></div>}
    <ol className="scan-queue-list">{items.map((item) => {
      const saveState = saveStates[item.barcode];
      const isSaved = saved.has(item.barcode);
      const working = item.status === "queued" || item.status === "loading";
      const key = historyKey(item);
      const recording = recordingHistory.current.has(key);
      const candidate = historyCandidates.current.get(key);
      const historyNeedsRetry = historyFailures.current.has(key) || !candidate || (candidate.owner !== null && (candidate.owner !== accountKey || candidate.ownerStatus !== status));
      return <li className="scan-queue-item" key={key}>
        <div className="scan-queue-product"><label className="scan-queue-select"><input type="checkbox" checked={selected.has(item.barcode)} disabled={!favouritesReady || isSaved || batchBusy} aria-label={`Select ${item.productName || `barcode ${item.barcode}`} for saving`} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.barcode); else next.delete(item.barcode); return next; })} /></label><div><h3>{item.productName || "Product name unavailable"}</h3><p>Barcode {item.barcode} · {item.source === "camera" ? "Camera scan" : "Manual entry"}</p></div></div>
        <p className={`scan-queue-status status-${item.status}`} role="status">{labels[item.status]}</p>
        {item.offer && <div className="scan-queue-offer"><strong>R{item.offer.price.toFixed(2)}</strong><span>Lowest returned price at {retailerName(item.offer.retailer)}</span><small>{item.offer.stale ? "Saved comparison, may be out of date. " : item.offer.fromCache ? "Retailer price from cache. " : ""}{item.offer.updatedAt ? `Source updated ${new Date(item.offer.updatedAt).toLocaleString("en-ZA")}.` : "Source update time unavailable."}</small></div>}
        {item.checkedAt && <small className="scan-queue-checked">Compared {new Date(item.checkedAt).toLocaleString("en-ZA")}</small>}
        {item.error && <p className="scan-queue-error" role="status">{item.error}</p>}
        {!item.historyRecorded && (item.status === "success" || item.status === "missing") && <div className={historyNeedsRetry ? "scan-queue-error" : "scan-queue-save-note"} role="status"><p>{historyErrors[key] || (recording ? "Saving this scan to history…" : historyNeedsRetry ? "This scan's history save is not confirmed. Check your history before retrying for the current account." : "This scan's history save is pending confirmation.")}</p>{historyNeedsRetry && <button className="button button-secondary" type="button" disabled={recording || status === "loading" || !accountKey} onClick={() => retryHistory(item)}>Retry history save</button>}</div>}
        <div className="scan-queue-row-actions"><Link className="button button-secondary" href={`/result?barcode=${item.barcode}&from=${item.historyRecorded ? "scan-queue" : "scan-queue-pending"}`}>View comparison</Link>
          {working ? <button className="button button-secondary" type="button" onClick={() => cancel(item.barcode)}>Cancel comparison</button> : <button className="button button-secondary" type="button" onClick={() => retry(item.barcode)}>{item.status === "success" ? "Recheck price" : "Retry comparison"}</button>}
          <button className="button button-primary" type="button" disabled={!favouritesReady || isSaved || batchBusy} onClick={() => void saveProducts([item.barcode])}>{isSaved ? "Saved favourite" : saveState?.status === "error" ? "Retry save" : item.productName ? "Save favourite" : "Save barcode"}</button>
          <button className="button button-secondary" type="button" disabled={batchBusy || recording} onClick={() => remove(item.barcode)}>Remove</button></div>
        {saveState && <p className={saveState.status === "error" ? "scan-queue-error" : "scan-queue-save-note"} role="status">{saveState.message}</p>}
      </li>;
    })}</ol>
    {items.length > 0 && <p className="scan-queue-description">{status === "authenticated" ? "Favourites save to your signed-in account only after the service confirms them." : status === "loading" ? "Checking your account before saving favourites…" : "Guest favourites stay on this device. Sign in to sync them across devices."} Missing prices are never estimated.</p>}
    <GuestSignupPrompt />
  </section>;
});
