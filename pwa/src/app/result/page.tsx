"use client";

import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
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

type LoadState = "loading" | "success" | "not-found" | "error";

function rankFor(index: number) {
  if (index === 0) return { className: "rank-best", label: "Best price" };
  if (index === 1) return { className: "rank-second", label: "2nd" };
  return { className: "rank-third", label: "3rd" };
}

function availabilityReason(item: RetailerResult) {
  const error = (item.error || "").toLowerCase();
  const retailer = retailerName(item.retailer);
  if (item.retailer === "spar") return "SPAR prices vary by branch; no store-level source is connected yet.";
  if (error.includes("exact barcode") || error.includes("exact match")) return `${retailer} has no confirmed listing for this exact EAN. Similar pack sizes are not substituted.`;
  if (error.includes("not found")) return `${retailer} does not currently list this barcode.`;
  if (error.includes("timed out") || error.includes("request failed") || error.includes("http 5")) return `${retailer} is temporarily unavailable. Try Refresh prices later.`;
  return `${retailer} has no price available for this exact barcode.`;
}

function RetailerCard({ item, availableIndex }: { item: RetailerResult; availableIndex: number | null }) {
  const rank = availableIndex === null ? null : rankFor(availableIndex);
  return <article className={`retailer-card ${!item.available ? "unavailable" : ""}`}>
    <div className={`retailer-logo ${retailerClass(item.retailer)}`}>{retailerInitials(item.retailer)}</div>
    <div className="retailer-info"><strong>{retailerName(item.retailer)}</strong><small>{item.available ? relativeTime(item.updated_at) : "Not available"}</small>{!item.available && item.retailer === "spar" && <span className="coming-soon-badge" title="SPAR prices depend on the shopper’s local branch. PriceCheck will show them after a store-level source and location selector are available.">Store pricing coming soon ⓘ</span>}{!item.available && <small className="availability-reason">{availabilityReason(item)}</small>}{item.stale && <small className="warning-text">Showing cached data</small>}</div>
    <div className="retailer-price">{item.available && item.price !== null ? <><b>R{item.price.toFixed(2)}</b>{rank && <span className={`rank-badge ${rank.className}`}>{rank.label}</span>}</> : <span className="not-available">Not available</span>}</div>
  </article>;
}

function ResultPageContent() {
  const { status } = useSession();
  const params = useSearchParams();
  const barcode = params.get("barcode")?.replace(/\D/g, "") ?? "";
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [message, setMessage] = useState("Checking prices across available retailers…");
  const [productHint, setProductHint] = useState("");
  const [requestState, setRequestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [requestMessage, setRequestMessage] = useState("");
  const [offlineCached, setOfflineCached] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!/^\d{8,14}$/.test(barcode)) { setState("error"); setMessage("Enter a valid 8 to 14 digit barcode."); return; }
    setState("loading");
    setMessage(refresh ? "Refreshing prices…" : "Checking prices across available retailers…");
    try {
      const { response, body } = await getComparison(barcode, refresh);
      if (response.status === 404) { setData(body); setState("not-found"); setMessage(body.message || "No retailer listing was found for this barcode."); return; }
      if (!response.ok) throw new Error(body.message || "Price comparison is unavailable");
      setData(body); setState("success"); setOfflineCached(false); cacheComparison(body);
      addRecentSearch({ barcode, name: body.product?.name || barcode, viewedAt: new Date().toISOString() });
      const lowest = body.results.filter((item) => item.available && item.price !== null).map((item) => item.price as number).sort((a, b) => a - b)[0] ?? null;
      const productName = body.product?.name || barcode;
      if (status === "authenticated") recordCloudScan(barcode, productName, lowest).catch(() => undefined);
      else recordGuestScan({ barcode, productName, lastPrice: lowest, scannedAt: new Date().toISOString() });
    } catch (error) {
      const cached = !refresh ? getCachedComparison(barcode) : null;
      if (cached) {
        setData(cached.comparison); setState("success"); setOfflineCached(true);
        setMessage(`Showing your saved comparison from ${new Date(cached.cachedAt).toLocaleString("en-ZA")}.`);
        return;
      }
      setState("error");
      setMessage(error instanceof Error && error.name === "AbortError" ? "The price service is still waking up. Please retry once, or return to search and try again shortly." : error instanceof Error ? error.message : "Price comparison is unavailable.");
    }
  }, [barcode, status]);

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
  let availablePosition = 0;

  return <main className="app-shell"><SiteHeader />
    <section className="result-page">
      <Link href="/search" className="back-link">‹ Back to search</Link>
      {state === "loading" && <div className="loading-panel"><span className="spinner" /><h1>Checking prices…</h1><p>{message}</p><small>Retailer lookups can take a few seconds. After a quiet period, the first check can take up to 35 seconds while the test service wakes up.</small></div>}
      {state === "error" && <div className="error-panel"><h1>We could not compare prices.</h1><p>{message}</p><div><button className="button button-primary" onClick={() => load()}>Retry</button><Link className="button button-secondary" href="/scan">Enter another barcode</Link></div></div>}
      {state === "not-found" && <div className="error-panel"><h1>{data?.product?.name ? "Product found, but no prices yet." : "No listings found yet."}</h1><p>{message}</p><p className="muted-copy">Retailers may not stock this exact barcode, or its listing is not in the current coverage set.</p><form className="product-request" onSubmit={requestMissingProduct}><label htmlFor="product-hint">Help us identify this product</label><p>Optional: add the product name or pack size so we can query retailer catalogues more precisely.</p><div><input id="product-hint" value={productHint} onChange={(event) => setProductHint(event.target.value)} placeholder={data?.product?.name || "e.g. Robertson BBQ spice 100g"} maxLength={140} /><button className="button button-primary" type="submit" disabled={requestState === "sending" || requestState === "sent"}>{requestState === "sent" ? "Saved" : requestState === "sending" ? "Adding…" : "Add details"}</button></div>{requestState !== "idle" && <small className={requestState === "error" ? "request-message error" : "request-message"} aria-live="polite">{requestMessage}</small>}{requestState === "sent" && <button className="button button-secondary request-retry" type="button" onClick={() => load(true)}>Check using details</button>}</form><div><button className="button button-secondary" onClick={() => load(true)}>Refresh prices</button><Link className="button button-secondary" href="/scan">Try another barcode</Link></div></div>}
      {state === "success" && data && <>
        <div className="result-product"><span className="product-hero-glyph">▣</span><div><span className="eyebrow">Price comparison</span><h1>{data.product.name || "Product lookup"}</h1><p>{[data.product.brand, data.product.pack_size, `Barcode ${barcode}`].filter(Boolean).join(" · ")}</p></div><FavouriteControl barcode={barcode} productName={data.product.name || barcode} /></div>
        <div className="result-header"><div><h2>Retailer prices</h2><p>Prices are sorted from the lowest available offer.</p></div><div className="result-actions"><ShareButton title={data.product.name || "PriceCheck product"} /><button className="button button-secondary" onClick={() => load(true)}>Refresh prices</button></div></div>
        <div className="retailer-list">{sorted.map((item) => { const index = item.available && item.price !== null ? availablePosition++ : null; return <RetailerCard key={item.retailer} item={item} availableIndex={index} />; })}</div>
        {offlineCached && <p className="offline-result-note" role="status">{message} Connect to the internet and refresh before relying on prices.</p>}
        <p className="coverage-note">{sorted.filter((item) => item.available).length} of {sorted.length} retailers currently have an exact barcode listing. PriceCheck never substitutes a similar product or pack size; SPAR needs a store-specific source.</p>
        <p className="data-disclaimer">PriceCheck shows source timestamps and availability so you can decide whether to verify an offer before shopping.</p>
        <PriceAlertForm barcode={barcode} />
        <GuestSignupPrompt />
      </>}
    </section>
  </main>;
}

export default function ResultPage() {
  return (
    <Suspense fallback={<main className="app-shell"><SiteHeader /><section className="loading-panel"><span className="spinner" /><h1>Loading result…</h1></section></main>}>
      <ResultPageContent />
    </Suspense>
  );
}
