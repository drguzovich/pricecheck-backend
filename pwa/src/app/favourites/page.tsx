"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { readGuestFavourites, type GuestFavourite } from "@/lib/guest-data";
import { cloudFavourites, cloudWatchlist, refreshWatchlistItem, type StoredFavourite, type WatchlistItem, type WatchlistMonitoring } from "@/lib/user-api";
import { PriceAlertForm } from "@/components/price-alert-form";
import { formatWatchlistTime, retailerLabel, WatchlistMonitoringStatus, WatchlistTrend } from "@/components/watchlist-trend";
import "@/styles/watchlist.css";

type Favourite = GuestFavourite | StoredFavourite | WatchlistItem;
const productName = (favourite: Favourite) => "product_name" in favourite ? favourite.product_name : favourite.productName;
const isWatchlistItem = (favourite: Favourite): favourite is WatchlistItem => "availability" in favourite;
function sourceUrl(value: string | null) {
  try { const url = new URL(value || ""); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function PriceState({ item }: { item: WatchlistItem }) {
  const best = item.best;
  const source = best ? sourceUrl(best.url) : null;
  const availability = item.availability === "failed" ? "Latest check failed" : item.availability === "unavailable" ? "No available price at latest check" : !best ? "Not checked yet" : best.stale ? "Stale recorded price" : "Best recorded price";
  return <div className="watchlist-price-state">
    <span className={`watchlist-badge ${best && !best.stale ? "is-current" : "is-pending"}`}>{availability}</span>
    {best ? <><strong className="watchlist-price">R{Number(best.price).toFixed(2)} <small>at {retailerLabel(best.retailer)}</small></strong><p>Retailer source: {formatWatchlistTime(best.updated_at)}{source && <> · <a href={source} target="_blank" rel="noopener noreferrer">View listing</a></>}</p></> : <p>{item.availability === "failed" ? "A price check could not complete. Try a manual refresh." : item.availability === "unavailable" ? "No current matching retailer listing was returned. Your favourite and target can stay saved." : "No completed price check has been recorded for this item."}</p>}
    {!best && item.lastKnownBest && <p>Last known price: R{Number(item.lastKnownBest.price).toFixed(2)} at {retailerLabel(item.lastKnownBest.retailer)}, source {formatWatchlistTime(item.lastKnownBest.updated_at)}. This is not a current available offer.</p>}
    <p>Last checked: <b>{formatWatchlistTime(item.last_checked_at)}</b></p>
    {best?.stale && <p className="watchlist-warning">This source price is older than six hours or has no reliable timestamp. Refresh before relying on it.</p>}
  </div>;
}
export default function FavouritesPage() {
  const { data: session, status } = useSession();
  const accountKey = session?.user?.email || status;
  const accountRef = useRef(accountKey); accountRef.current = accountKey;
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const [monitoring, setMonitoring] = useState<WatchlistMonitoring | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string[]>([]);
  const [targetBarcode, setTargetBarcode] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFavourites([]); setMonitoring(null); setMessage(""); setTargetBarcode(null); setPending([]);
    if (status === "loading") { setLoading(true); return; }
    if (status === "authenticated") {
      setLoading(true);
      cloudWatchlist().then((data) => {
        if (!cancelled) { setFavourites(data.items.filter((item) => item.favourite)); setMonitoring(data.monitoring); }
      }).catch(async (error) => {
        // Saved products remain usable during a watchlist deployment/outage.
        try { const fallback = await cloudFavourites(); if (!cancelled) setFavourites(fallback.favourites); } catch { /* Preserve the original availability message. */ }
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Watchlist status is temporarily unavailable.");
      }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    const syncGuestFavourites = () => { if (!cancelled) setFavourites(readGuestFavourites()); };
    syncGuestFavourites(); setLoading(false);
    const events = ["pricecheck-guest-data", "trolleywise-guest-data", "storage"];
    events.forEach((name) => window.addEventListener(name, syncGuestFavourites));
    return () => { cancelled = true; events.forEach((name) => window.removeEventListener(name, syncGuestFavourites)); };
  }, [status, accountKey, retry]);
  const refresh = async (barcode: string) => {
    if (pending.includes(barcode)) return;
    const owner = accountKey;
    setPending((current) => [...current, barcode]); setMessage("");
    try {
      const data = await refreshWatchlistItem(barcode);
      if (accountRef.current === owner) {
        setFavourites((current) => current.map((item) => item.barcode === barcode ? data.item : item));
        setMonitoring(data.monitoring);
      }
    } catch (error) { if (accountRef.current === owner) setMessage(error instanceof Error ? error.message : "Could not check prices."); }
    finally { if (accountRef.current === owner) setPending((current) => current.filter((item) => item !== barcode)); }
  };
  return <main className="app-shell list-page watchlist-page">
    <span className="eyebrow">Your grocery watchlist</span><h1>Favourites</h1>
    <p className="muted-copy">{status === "authenticated" ? "Products saved to your private account, with recorded retailer prices and optional targets." : "Products saved on this device. Guest favourites are manual-only and are not checked by a cloud worker."}</p>
    {status === "authenticated" && !loading && <WatchlistMonitoringStatus monitoring={monitoring} />}
    <div className="watchlist-navigation"><Link className="button button-secondary" href="/scan">Scan more items</Link><Link className="button button-secondary" href="/alerts">Manage alerts</Link></div>
    {message && <div className="watchlist-error" role="status"><p>{message}</p><button className="button button-secondary" type="button" onClick={() => setRetry((value) => value + 1)}>Reload watchlist</button></div>}
    {loading ? <div className="history-list" aria-busy="true"><div className="skeleton-card">Loading favourites…</div><div className="skeleton-card" /></div> : !favourites.length ? <div className="empty-state"><strong>{message ? "Favourites could not be loaded." : "No favourites yet."}</strong><p>Save products after a scan or search to build your watchlist. Named products can have a target even before a price is found.</p><Link className="button button-primary" href="/search">Find a product</Link></div> : <div className="watchlist-items">{favourites.map((favourite) => {
      const item = isWatchlistItem(favourite) ? favourite : null;
      const busy = pending.includes(favourite.barcode);
      const targetOpen = targetBarcode === favourite.barcode;
      return <article className="watchlist-item" key={favourite.barcode} aria-busy={busy}>
        <Link className="watchlist-product-link" href={`/result?barcode=${favourite.barcode}`}><span><strong>{productName(favourite)}</strong><small>Barcode {favourite.barcode}</small></span><span aria-hidden="true">›</span></Link>
        {item ? <PriceState item={item} /> : <p className="watchlist-manual">{status === "authenticated" ? "Recorded price status is unavailable. Open the comparison to check manually." : "Manual-only monitoring. Open the comparison to check current retailer prices."}</p>}
        <div className="watchlist-actions">{item ? <button className="button button-secondary" type="button" disabled={busy} onClick={() => void refresh(favourite.barcode)}>{busy ? "Checking…" : "Check prices now"}</button> : <Link className="button button-secondary" href={`/result?barcode=${favourite.barcode}`}>Check prices manually</Link>}<button className="button button-secondary" type="button" aria-expanded={targetOpen} aria-controls={`target-${favourite.barcode}`} onClick={() => setTargetBarcode(targetOpen ? null : favourite.barcode)}>{targetOpen ? "Close target" : "Set price alert"}</button></div>
        {item && <WatchlistTrend barcode={item.barcode} refreshedAt={item.last_checked_at} />}
        {targetOpen && <div id={`target-${favourite.barcode}`}><PriceAlertForm barcode={favourite.barcode} productName={productName(favourite)} watchlist={Boolean(item)} /></div>}
      </article>;
    })}</div>}
    {!!favourites.length && <p className="watchlist-footnote">Prices are indicative, retailer-specific and can change before checkout. Missing prices and history are never replaced with estimates.</p>}
  </main>;
}
