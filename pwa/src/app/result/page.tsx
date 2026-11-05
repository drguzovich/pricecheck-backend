"use client";

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { SiteHeader } from "@/components/site-header";
import { ComparisonResponse, RetailerResult, cacheComparison, getCachedComparison, getComparison, relativeTime, retailerClass, retailerInitials, retailerName, submitProductRequest } from "@/lib/price-api";
import { addRecentSearch } from "@/lib/recent-searches";
import { readGuestHistory, recordGuestScan } from "@/lib/guest-data";
import { getAccountToken } from "@/lib/user-api";
import { backendRequest } from "@/lib/backend-api";
import { FavouriteControl } from "@/components/favourite-control";
import { ShareButton } from "@/components/share-button";
import { PriceAlertForm } from "@/components/price-alert-form";
import { GuestSignupPrompt } from "@/components/guest-signup-prompt";
import { ChevronLeftIcon, InfoIcon, ProductIcon } from "@/components/icons";
import { ProductHealth } from "@/components/product-health";
import { ResultSkeleton } from "@/components/skeleton";

type LoadState = "loading" | "success" | "not-found" | "error";
type RetailerContext = RetailerResult & { store?: string; store_name?: string; provenance?: string };
type SessionOwner = { key: string; status: "loading" | "authenticated" | "unauthenticated"; identity: string; revision: number };
type ScanRecordCandidate = { barcode: string; productName: string; lastPrice: number | null; scannedAt: string; owner: SessionOwner | null; attempted: boolean; recordedOwners: Set<string> };
type HistorySaveState = { owner: SessionOwner; phase: "saving" | "saved" | "error"; message: string };

function rankFor(index: number) {
  if (index === 0) return { className: "rank-best", label: "Best Price" };
  if (index === 1) return { className: "rank-second", label: "2nd" };
  return { className: "rank-third", label: "3rd" };
}

function availabilityReason(item: RetailerResult) {
  const error = (item.error || "").toLowerCase();
  const retailer = retailerName(item.retailer);
  if (item.retailer === "spar") return "SPAR is a franchise — prices differ per store. We’re working on store-specific pricing.";
  if (error.includes("exact barcode") || error.includes("exact match")) return `${retailer} has no confirmed listing for this exact EAN. Similar pack sizes are not substituted.`;
  if (error.includes("not found")) return `${retailer} does not currently list this barcode.`;
  if (error.includes("timed out") || error.includes("request failed") || error.includes("http 5")) return `${retailer} is temporarily unavailable. Try Refresh prices later.`;
  return `${retailer} has no price available for this exact barcode.`;
}

function RetailerCard({ item, availableIndex }: { item: RetailerResult; availableIndex: number | null }) {
  const [sparExplanationOpen, setSparExplanationOpen] = useState(false);
  const rank = availableIndex === null ? null : rankFor(availableIndex);
  const context = item as RetailerContext;
  const store = context.store_name || context.store;
  const explanationId = `spar-explanation-${item.retailer}`;

  return (
    <article className={`retailer-card ${!item.available ? "unavailable" : ""} ${item.retailer === "spar" ? "spar-card" : ""}`}>
      <div className={`retailer-logo ${retailerClass(item.retailer)}`}>{retailerInitials(item.retailer)}</div>
      <div className="retailer-info">
        <strong>{retailerName(item.retailer)}</strong>
        {item.available ? <small>{store ? `${store} · ${relativeTime(item.updated_at)}` : relativeTime(item.updated_at)}</small> : <small>Not available</small>}
        {!item.available && item.retailer === "spar" && (
          <>
            <p className="spar-status">SPAR · Store prices vary · Coming soon</p>
            <button className="spar-info-button" type="button" aria-expanded={sparExplanationOpen} aria-controls={explanationId} onClick={() => setSparExplanationOpen((open) => !open)}>
              <InfoIcon size={16} /> <span>Why prices vary</span>
            </button>
            {sparExplanationOpen && <p id={explanationId} className="spar-explanation">SPAR is a franchise — prices differ per store. We&apos;re working on store-specific pricing.</p>}
          </>
        )}
        {!item.available && item.retailer !== "spar" && <small className="availability-reason">{availabilityReason(item)}</small>}
        {item.stale && <small className="warning-text">Showing cached data</small>}
      </div>
      <div className="retailer-price">
        {item.available && item.price !== null ? <><b>R{item.price.toFixed(2)}</b>{rank && <span className={`rank-badge ${rank.className}`}>{rank.label}</span>}</> : <span className="not-available">Not available</span>}
      </div>
    </article>
  );
}

function ProductImage({ imageUrl, productName }: { imageUrl: string | null; productName: string }) {
  const [failed, setFailed] = useState(!imageUrl);
  useEffect(() => setFailed(!imageUrl), [imageUrl]);
  if (failed || !imageUrl) return <span className="product-image product-image-fallback" aria-label="Product image unavailable"><ProductIcon size={30} /></span>;
  return <span className="product-image"><Image src={imageUrl} width={104} height={104} unoptimized alt={productName ? `${productName} product image` : "Product image"} onError={() => setFailed(true)} /></span>;
}

function ResultPageContent() {
  const { data: session, status } = useSession();
  const params = useSearchParams();
  const barcode = params.get("barcode")?.replace(/\D/g, "") ?? "";
  const identity = (session?.user as { id?: string } | undefined)?.id || session?.user?.email || "";
  const key = status === "authenticated" ? `${status}:${identity}` : status;
  const ownerRef = useRef<SessionOwner>({ key, status, identity, revision: 0 });
  if (ownerRef.current.key !== key) ownerRef.current = { key, status, identity, revision: ownerRef.current.revision + 1 };
  // Barcode/context changes reset comparison state; principal changes do not rescrape.
  return <ResultForBarcode key={`${barcode}:${params.get("from") || ""}`} barcode={barcode} params={params} owner={ownerRef.current} ownerRef={ownerRef} />;
}

function ResultForBarcode({ barcode, params, owner, ownerRef }: { barcode: string; params: ReturnType<typeof useSearchParams>; owner: SessionOwner; ownerRef: { current: SessionOwner } }) {
  const validBarcode = /^\d{8,14}$/.test(barcode);
  const recordedByQueue = params.get("from") === "scan-queue";
  const queueHistoryPending = params.get("from") === "scan-queue-pending";
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [message, setMessage] = useState("Checking prices across available retailers…");
  const [productHint, setProductHint] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [requestMessage, setRequestMessage] = useState("");
  const [offlineCached, setOfflineCached] = useState(false);
  const [historySave, setHistorySave] = useState<HistorySaveState | null>(null);
  const [, updateHistoryProgress] = useState(0);
  const mounted = useRef(false);
  const comparisonRequestRef = useRef(0);
  const pendingScanRef = useRef<ScanRecordCandidate | null>(null);
  const historyInFlight = useRef<{ controller: AbortController; owner: SessionOwner } | null>(null);
  const productRequestInFlight = useRef(false);
  const productRequestOwner = useRef<SessionOwner | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      comparisonRequestRef.current += 1;
      historyInFlight.current?.controller.abort();
    };
  }, []);

  const recordSuccessfulScan = useCallback(async (retry = false) => {
    if (recordedByQueue) return;
    const candidate = pendingScanRef.current;
    const capturedOwner = ownerRef.current;
    if (!mounted.current || !candidate || historyInFlight.current || capturedOwner.status === "loading") return;
    if (candidate.recordedOwners.has(capturedOwner.key)) {
      setHistorySave({ owner: capturedOwner, phase: "saved", message: capturedOwner.status === "authenticated" ? "Saved to your private history." : "Saved to history on this device." });
      return;
    }
    // Only the first settled owner may auto-save. Refreshes and account switches never retry writes.
    if (!retry && (candidate.attempted || (candidate.owner && candidate.owner !== capturedOwner) || queueHistoryPending)) return;
    if (capturedOwner.status === "authenticated" && !capturedOwner.identity) {
      setHistorySave({ owner: capturedOwner, phase: "error", message: "Your account could not be identified. Sign in again before saving history." });
      return;
    }
    if (retry && (candidate.attempted || queueHistoryPending || (candidate.owner && candidate.owner !== capturedOwner)) && !window.confirm("Check your history first: an earlier save may have completed. Retrying here or in the scan queue may create a duplicate. Save this scan to the current history?")) return;
    const controller = new AbortController();
    const attempt = { controller, owner: capturedOwner };
    historyInFlight.current = attempt;
    candidate.owner = capturedOwner;
    candidate.attempted = true;
    const current = () => mounted.current && !controller.signal.aborted && ownerRef.current === capturedOwner && pendingScanRef.current === candidate;
    setHistorySave({ owner: capturedOwner, phase: "saving", message: capturedOwner.status === "authenticated" ? "Saving this scan to your private history…" : "Saving this scan on your device…" });
    try {
      if (capturedOwner.status === "authenticated") {
        // Check ownership again after token issuance, before starting any mutation.
        const token = await getAccountToken(capturedOwner.identity);
        if (!current()) return;
        if (!token) throw new Error("Sign in is required to save this scan.");
        const response = await backendRequest("/users/scans", {
          method: "POST", signal: controller.signal, cache: "no-store",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ barcode: candidate.barcode, product_name: candidate.productName, last_price: candidate.lastPrice, scanned_at: candidate.scannedAt }),
        });
        const body = await response.json().catch(() => ({})) as { scan?: { barcode?: string }; message?: string };
        if (!current()) return;
        if (!response.ok) throw new Error(body.message || "The history service is temporarily unavailable.");
        if (body.scan?.barcode !== candidate.barcode) throw new Error("The service did not confirm this barcode's history save.");
      } else {
        recordGuestScan({ barcode: candidate.barcode, productName: candidate.productName, lastPrice: candidate.lastPrice, scannedAt: candidate.scannedAt });
        if (!readGuestHistory().some((scan) => scan.barcode === candidate.barcode && scan.scannedAt === candidate.scannedAt)) throw new Error("Device storage did not confirm this history save.");
      }
      if (!current()) return;
      candidate.recordedOwners.add(capturedOwner.key);
      setHistorySave({ owner: capturedOwner, phase: "saved", message: capturedOwner.status === "authenticated" ? "Saved to your private history." : "Saved to history on this device." });
    } catch (error) {
      if (current()) setHistorySave({ owner: capturedOwner, phase: "error", message: `${error instanceof Error ? error.message : "History could not be saved."} The save is not confirmed. Check your history before retrying; your comparison is still available.` });
    } finally {
      if (historyInFlight.current === attempt) historyInFlight.current = null;
      if (mounted.current) updateHistoryProgress((version) => version + 1);
    }
  }, [ownerRef, queueHistoryPending, recordedByQueue]);

  useEffect(() => {
    if (historyInFlight.current && historyInFlight.current.owner !== owner) historyInFlight.current.controller.abort();
    const candidate = pendingScanRef.current;
    // An initial loading session may settle once; an already-owned candidate needs explicit consent.
    if (candidate && !candidate.owner && !candidate.attempted && owner.status !== "loading") void recordSuccessfulScan();
  }, [owner, recordSuccessfulScan]);

  const load = useCallback(async (refresh = false) => {
    if (!/^\d{8,14}$/.test(barcode)) {
      setState("error");
      setMessage("Enter a valid 8 to 14 digit barcode.");
      return;
    }
    setState("loading");
    setMessage(refresh ? "Refreshing prices…" : "Checking prices across available retailers…");
    const requestId = ++comparisonRequestRef.current;
    const startedOwner = ownerRef.current;
    try {
      const { response, body } = await getComparison(barcode, refresh);
      if (!mounted.current || requestId !== comparisonRequestRef.current) return;
      const isStaleCacheResponse = response.headers.get("X-TrolleyWise-Cache") === "stale" || response.headers.get("X-PriceCheck-Cache") === "stale";
      const resultItems = Array.isArray(body.results) ? body.results : [];
      const comparison = {
        ...body,
        results: isStaleCacheResponse ? resultItems.map((item) => ({ ...item, stale: true, from_cache: true })) : resultItems,
      };
      if (response.status === 404) {
        setData(comparison);
        setOfflineCached(isStaleCacheResponse);
        setState("not-found");
        setMessage(isStaleCacheResponse ? "Showing a saved comparison while you are offline." : body.message || "No retailer listing was found for this barcode.");
      } else {
        if (!response.ok) throw new Error(body.message || "Price comparison is unavailable");
        setData(comparison);
        setState("success");
        setOfflineCached(isStaleCacheResponse);
      }
      if (isStaleCacheResponse) {
        setMessage("Showing a saved comparison while you are offline.");
        return;
      }
      cacheComparison(comparison);
      try { addRecentSearch({ barcode, name: comparison.product?.name || barcode, viewedAt: new Date().toISOString() }); } catch { /* Optional recent searches must not prevent saving history. */ }
      const knownIdentity = (comparison.barcode === barcode || comparison.product?.barcode === barcode) && (!comparison.barcode || comparison.barcode === barcode) && (!comparison.product?.barcode || comparison.product.barcode === barcode);
      if (knownIdentity && !pendingScanRef.current && !recordedByQueue) {
        const lowest = response.status === 404 ? null : comparison.results.filter((item) => item.available && item.price !== null).map((item) => item.price as number).sort((a, b) => a - b)[0] ?? null;
        const waitingForFirstOwner = startedOwner.status === "loading" && ownerRef.current.revision <= startedOwner.revision + 1;
        pendingScanRef.current = { barcode, productName: comparison.product?.name || barcode, lastPrice: lowest, scannedAt: new Date().toISOString(), owner: waitingForFirstOwner ? null : startedOwner, attempted: false, recordedOwners: new Set() };
        updateHistoryProgress((version) => version + 1);
        void recordSuccessfulScan();
      }
    } catch (error) {
      if (!mounted.current || requestId !== comparisonRequestRef.current) return;
      const cached = !refresh ? getCachedComparison(barcode) : null;
      if (cached) {
        setData({ ...cached.comparison, results: cached.comparison.results.map((item) => ({ ...item, stale: true, from_cache: true })) });
        setState("success");
        setOfflineCached(true);
        setMessage(`Showing your saved comparison from ${new Date(cached.cachedAt).toLocaleString("en-ZA")}.`);
        return;
      }
      setState("error");
      setMessage(error instanceof Error && error.name === "AbortError" ? "The price service is still waking up. Please retry once, or return to search and try again shortly." : error instanceof Error ? error.message : "Price comparison is unavailable.");
    }
  }, [barcode, ownerRef, recordedByQueue, recordSuccessfulScan]);

  useEffect(() => { void load(); }, [load]);

  const requestMissingProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (!mounted.current || productRequestInFlight.current) return;
    if ((requestState === "error" || (productRequestOwner.current && productRequestOwner.current !== ownerRef.current)) && !window.confirm("An earlier coverage request may have completed. Submit these details again?")) return;
    const capturedOwner = ownerRef.current;
    productRequestInFlight.current = true;
    productRequestOwner.current = capturedOwner;
    setRequestState("sending");
    setRequestMessage("Adding this barcode to the coverage queue…");
    try {
      const { response, body } = await submitProductRequest(barcode, productHint || data?.product?.name || "");
      if (!mounted.current || ownerRef.current !== capturedOwner) return;
      if (!response.ok) throw new Error(body.message || "We could not save this request right now.");
      setRequestState("sent");
      setRequestMessage("Saved. Check again using these details to query the retailer sources with this product name.");
    } catch (error) {
      if (mounted.current && ownerRef.current === capturedOwner) {
        setRequestState("error");
        setRequestMessage(error instanceof Error ? error.message : "We could not save this request right now.");
      }
    } finally { productRequestInFlight.current = false; if (mounted.current) updateHistoryProgress((version) => version + 1); }
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.results].sort((a, b) => (a.available && a.price !== null ? a.price : Infinity) - (b.available && b.price !== null ? b.price : Infinity));
  }, [data]);
  const bestOffer = sorted.find((item) => item.available && item.price !== null) || null;
  let availablePosition = 0;
  const candidate = pendingScanRef.current;
  const savedForOwner = Boolean(candidate?.recordedOwners.has(owner.key));
  const historyPhase = owner.status === "loading" ? "pending" : savedForOwner ? "saved" : historySave?.owner === owner ? historySave.phase : "pending";
  const historyMessage = owner.status === "loading" ? "Checking your account before saving history…" : savedForOwner ? (owner.status === "authenticated" ? "Saved to your private history." : "Saved to history on this device.") : historySave?.owner === owner ? historySave.message : queueHistoryPending ? "The scan queue has not confirmed this history save. Check history before retrying here or in the queue; using both may create a duplicate." : "This comparison is not saved to the current history. Your account may have changed. Check history before saving again.";
  const coverageOwnerChanged = Boolean(productRequestOwner.current && productRequestOwner.current !== owner);
  const visibleRequestState = coverageOwnerChanged ? "error" : requestState;
  const visibleRequestMessage = coverageOwnerChanged ? "Your account changed before this coverage request could be confirmed. It may already have completed. Check before submitting details again." : requestMessage;

  return (
    <main className="app-shell">
      <SiteHeader />
      <section className="result-page">
        <Link href={params.get("from")?.startsWith("scan-queue") ? "/scan" : "/search"} className="back-link"><ChevronLeftIcon size={17} /> <span>{params.get("from")?.startsWith("scan-queue") ? "Back to scan queue" : "Back to search"}</span></Link>
        <Link className="button button-secondary" href="/scan">Scan next item</Link>
        {!recordedByQueue && candidate && <aside className={historyPhase === "error" ? "inline-error" : "offline-result-note"} role="status" aria-live="polite" aria-busy={historyPhase === "saving"}>
          <p>{historyMessage}</p>
          {historyPhase !== "saved" && <div><Link className="button button-secondary" href="/history">Check history</Link><button className="button button-secondary" type="button" disabled={owner.status === "loading" || Boolean(historyInFlight.current)} onClick={() => void recordSuccessfulScan(true)}>{historyPhase === "saving" ? "Saving history…" : "Retry history save"}</button></div>}
        </aside>}
        {state === "loading" && <ResultSkeleton message={message} />}
        {state === "error" && (
          <div className="error-panel">
            <h1>We could not compare prices.</h1>
            <p>{message}</p>
            <div><button className="button button-primary" onClick={() => load()}>Retry</button><Link className="button button-secondary" href="/scan">Enter another barcode</Link></div>
          </div>
        )}
        {state === "not-found" && (
          <div className="error-panel result-not-found">
            <h1>{data?.product?.name ? "Product found, but no prices yet." : "No listings found yet."}</h1>
            <p>{message}</p>
            <p className="muted-copy">Retailers may not stock this exact barcode, or its listing is not in the current coverage set.</p>
            {data?.product?.name && <><FavouriteControl barcode={barcode} productName={data.product.name} /><PriceAlertForm barcode={barcode} productName={data.product.name} /></>}
            {data && sorted.length > 0 && <><div className="result-header"><div><h2>Retailer availability</h2><p>We only show prices for confirmed exact barcode listings.</p></div></div><div className="retailer-list">{sorted.map((item) => { const index = item.available && item.price !== null ? availablePosition++ : null; return <RetailerCard key={item.retailer} item={item} availableIndex={index} />; })}</div></>}
            <form className="product-request" onSubmit={requestMissingProduct}>
              <label htmlFor="product-hint">Help us identify this product</label>
              <p>Optional: add the product name or pack size so we can query retailer catalogues more precisely.</p>
              <div><input id="product-hint" value={productHint} onChange={(event) => setProductHint(event.target.value)} placeholder={data?.product?.name || "e.g. Robertson BBQ spice 100g"} maxLength={140} /><button className="button button-primary" type="submit" disabled={productRequestInFlight.current || visibleRequestState === "sent"}>{visibleRequestState === "sent" ? "Saved" : productRequestInFlight.current ? "Adding…" : "Add details"}</button></div>
              {visibleRequestState !== "idle" && <small className={visibleRequestState === "error" ? "request-message error" : "request-message"} aria-live="polite">{visibleRequestMessage}</small>}
              {visibleRequestState === "sent" && <button className="button button-secondary request-retry" type="button" onClick={() => load(true)}>Check using details</button>}
            </form>
            <div><button className="button button-secondary" onClick={() => load(true)}>Refresh prices</button><Link className="button button-secondary" href="/scan">Try another barcode</Link></div>
          </div>
        )}
        {state === "success" && data && (
          <>
            <div className="result-product">
              <ProductImage imageUrl={data.product.image_url} productName={data.product.name || "Product"} />
              <div className="result-product-copy"><span className="eyebrow">Price comparison</span><h1>{data.product.name || "Product lookup"}</h1><p>{[data.product.brand, data.product.pack_size, `Barcode ${barcode}`].filter(Boolean).join(" · ")}</p></div>
              <FavouriteControl barcode={barcode} productName={data.product.name || barcode} />
            </div>
            <div className="result-header"><div><h2>Retailer prices</h2><p>Prices are sorted from the lowest available offer.</p></div><div className="result-actions"><ShareButton productName={data.product.name || "TrolleyWise product"} bestPrice={bestOffer?.price ?? null} bestRetailer={bestOffer ? retailerName(bestOffer.retailer) : null} /><button className="button button-secondary" onClick={() => load(true)}>Refresh prices</button></div></div>
            <div className="retailer-list">{sorted.map((item) => { const index = item.available && item.price !== null ? availablePosition++ : null; return <RetailerCard key={item.retailer} item={item} availableIndex={index} />; })}</div>
            <ProductHealth barcode={barcode} />
            {offlineCached && <p className="offline-result-note" role="status">{message} Connect to the internet and refresh before relying on prices.</p>}
            <p className="coverage-note">{sorted.filter((item) => item.available).length} of {sorted.length} retailers currently have an exact barcode listing. TrolleyWise never substitutes a similar product or pack size; SPAR needs a store-specific source.</p>
            <p className="data-disclaimer">TrolleyWise shows source timestamps and availability so you can decide whether to verify an offer before shopping.</p>
            <PriceAlertForm barcode={barcode} />
            <GuestSignupPrompt />
          </>
        )}
        {validBarcode && state !== "success" && <ProductHealth barcode={barcode} />}
      </section>
    </main>
  );
}

export default function ResultPage() {
  return (
    <Suspense fallback={<main className="app-shell"><SiteHeader /><section className="result-page"><ResultSkeleton message="Loading result…" /></section></main>}>
      <ResultPageContent />
    </Suspense>
  );
}
