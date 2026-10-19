"use client";

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { SiteHeader } from "@/components/site-header";
import { ComparisonResponse, RetailerResult, cacheComparison, getCachedComparison, getComparison, relativeTime, retailerClass, retailerInitials, retailerName, submitProductRequest } from "@/lib/price-api";
import { addRecentSearch } from "@/lib/recent-searches";
import { recordGuestScan } from "@/lib/guest-data";
import { recordCloudScan } from "@/lib/user-api";
import { FavouriteControl } from "@/components/favourite-control";
import { ShareButton } from "@/components/share-button";
import { PriceAlertForm } from "@/components/price-alert-form";
import { GuestSignupPrompt } from "@/components/guest-signup-prompt";
import { ChevronLeftIcon, InfoIcon, ProductIcon } from "@/components/icons";
import { ProductHealth } from "@/components/product-health";
import { ResultSkeleton } from "@/components/skeleton";

type LoadState = "loading" | "success" | "not-found" | "error";
type RetailerContext = RetailerResult & { store?: string; store_name?: string; provenance?: string };
type ScanRecordCandidate = { requestId: number; barcode: string; productName: string; lastPrice: number | null };

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
  return <span className="product-image"><img src={imageUrl} alt={productName ? `${productName} product image` : "Product image"} onError={() => setFailed(true)} /></span>;
}

function ResultPageContent() {
  const { status } = useSession();
  const params = useSearchParams();
  const barcode = params.get("barcode")?.replace(/\D/g, "") ?? "";
  const validBarcode = /^\d{8,14}$/.test(barcode);
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [message, setMessage] = useState("Checking prices across available retailers…");
  const [productHint, setProductHint] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [requestMessage, setRequestMessage] = useState("");
  const [offlineCached, setOfflineCached] = useState(false);
  const sessionStatusRef = useRef(status);
  const comparisonRequestRef = useRef(0);
  const pendingScanRef = useRef<ScanRecordCandidate | null>(null);
  const recordedScanRequestRef = useRef<number | null>(null);

  const recordSuccessfulScan = useCallback(() => {
    const candidate = pendingScanRef.current;
    if (!candidate || recordedScanRequestRef.current === candidate.requestId || sessionStatusRef.current === "loading") return;
    recordedScanRequestRef.current = candidate.requestId;
    if (sessionStatusRef.current === "authenticated") {
      recordCloudScan(candidate.barcode, candidate.productName, candidate.lastPrice).catch(() => undefined);
    } else {
      recordGuestScan({ barcode: candidate.barcode, productName: candidate.productName, lastPrice: candidate.lastPrice, scannedAt: new Date().toISOString() });
    }
  }, []);

  useEffect(() => {
    sessionStatusRef.current = status;
    recordSuccessfulScan();
  }, [recordSuccessfulScan, status]);

  const load = useCallback(async (refresh = false) => {
    if (!/^\d{8,14}$/.test(barcode)) {
      setState("error");
      setMessage("Enter a valid 8 to 14 digit barcode.");
      return;
    }
    setState("loading");
    setMessage(refresh ? "Refreshing prices…" : "Checking prices across available retailers…");
    const requestId = ++comparisonRequestRef.current;
    try {
      const { response, body } = await getComparison(barcode, refresh);
      if (requestId !== comparisonRequestRef.current) return;
      const isStaleCacheResponse = response.headers.get("X-PriceCheck-Cache") === "stale";
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
        return;
      }
      if (!response.ok) throw new Error(body.message || "Price comparison is unavailable");
      setData(comparison);
      setState("success");
      setOfflineCached(isStaleCacheResponse);
      if (isStaleCacheResponse) {
        setMessage("Showing a saved comparison while you are offline.");
        return;
      }
      cacheComparison(comparison);
      addRecentSearch({ barcode, name: comparison.product?.name || barcode, viewedAt: new Date().toISOString() });
      const lowest = comparison.results.filter((item) => item.available && item.price !== null).map((item) => item.price as number).sort((a, b) => a - b)[0] ?? null;
      pendingScanRef.current = { requestId, barcode, productName: comparison.product?.name || barcode, lastPrice: lowest };
      recordSuccessfulScan();
    } catch (error) {
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
  }, [barcode, recordSuccessfulScan]);

  useEffect(() => { load(); }, [load]);

  const requestMissingProduct = async (event: FormEvent) => {
    event.preventDefault();
    setRequestState("sending");
    setRequestMessage("Adding this barcode to the coverage queue…");
    try {
      const { response, body } = await submitProductRequest(barcode, productHint || data?.product?.name || "");
      if (!response.ok) throw new Error(body.message || "We could not save this request right now.");
      setRequestState("sent");
      setRequestMessage("Saved. Check again using these details to query the retailer sources with this product name.");
    } catch (error) {
      setRequestState("error");
      setRequestMessage(error instanceof Error ? error.message : "We could not save this request right now.");
    }
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.results].sort((a, b) => (a.available && a.price !== null ? a.price : Infinity) - (b.available && b.price !== null ? b.price : Infinity));
  }, [data]);
  const bestOffer = sorted.find((item) => item.available && item.price !== null) || null;
  let availablePosition = 0;

  return (
    <main className="app-shell">
      <SiteHeader />
      <section className="result-page">
        <Link href="/search" className="back-link"><ChevronLeftIcon size={17} /> <span>Back to search</span></Link>
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
            {data?.product?.name && <FavouriteControl barcode={barcode} productName={data.product.name} />}
            {data && sorted.length > 0 && <><div className="result-header"><div><h2>Retailer availability</h2><p>We only show prices for confirmed exact barcode listings.</p></div></div><div className="retailer-list">{sorted.map((item) => { const index = item.available && item.price !== null ? availablePosition++ : null; return <RetailerCard key={item.retailer} item={item} availableIndex={index} />; })}</div></>}
            <form className="product-request" onSubmit={requestMissingProduct}>
              <label htmlFor="product-hint">Help us identify this product</label>
              <p>Optional: add the product name or pack size so we can query retailer catalogues more precisely.</p>
              <div><input id="product-hint" value={productHint} onChange={(event) => setProductHint(event.target.value)} placeholder={data?.product?.name || "e.g. Robertson BBQ spice 100g"} maxLength={140} /><button className="button button-primary" type="submit" disabled={requestState === "sending" || requestState === "sent"}>{requestState === "sent" ? "Saved" : requestState === "sending" ? "Adding…" : "Add details"}</button></div>
              {requestState !== "idle" && <small className={requestState === "error" ? "request-message error" : "request-message"} aria-live="polite">{requestMessage}</small>}
              {requestState === "sent" && <button className="button button-secondary request-retry" type="button" onClick={() => load(true)}>Check using details</button>}
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
            <div className="result-header"><div><h2>Retailer prices</h2><p>Prices are sorted from the lowest available offer.</p></div><div className="result-actions"><ShareButton productName={data.product.name || "PriceCheck product"} bestPrice={bestOffer?.price ?? null} bestRetailer={bestOffer ? retailerName(bestOffer.retailer) : null} /><button className="button button-secondary" onClick={() => load(true)}>Refresh prices</button></div></div>
            <div className="retailer-list">{sorted.map((item) => { const index = item.available && item.price !== null ? availablePosition++ : null; return <RetailerCard key={item.retailer} item={item} availableIndex={index} />; })}</div>
            <ProductHealth barcode={barcode} />
            {offlineCached && <p className="offline-result-note" role="status">{message} Connect to the internet and refresh before relying on prices.</p>}
            <p className="coverage-note">{sorted.filter((item) => item.available).length} of {sorted.length} retailers currently have an exact barcode listing. PriceCheck never substitutes a similar product or pack size; SPAR needs a store-specific source.</p>
            <p className="data-disclaimer">PriceCheck shows source timestamps and availability so you can decide whether to verify an offer before shopping.</p>
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
