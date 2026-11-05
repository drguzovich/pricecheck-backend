"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { cloudAlerts, cloudWatchlist, removeCloudAlert, type StoredAlert, type WatchlistItem, type WatchlistMonitoring } from "@/lib/user-api";
import { PriceAlertForm } from "@/components/price-alert-form";
import { formatWatchlistTime, retailerLabel, WatchlistMonitoringStatus } from "@/components/watchlist-trend";
import "@/styles/watchlist.css";

function activeUniqueAlerts(alerts: StoredAlert[]) {
  const unique = new Map<string, StoredAlert>();
  for (const alert of alerts) {
    if (!alert.active) continue;
    const prior = unique.get(alert.barcode);
    if (!prior || Number(alert.id) > Number(prior.id)) unique.set(alert.barcode, alert);
  }
  return Array.from(unique.values());
}
export default function AlertsPage() {
  const { data: session, status } = useSession();
  const accountKey = session?.user?.email || status;
  const accountRef = useRef(accountKey); accountRef.current = accountKey;
  const [alerts, setAlerts] = useState<StoredAlert[]>([]);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [monitoring, setMonitoring] = useState<WatchlistMonitoring | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<number[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setAlerts([]); setItems([]); setMonitoring(null); setMessage(""); setPending([]); setEditing(null);
    if (status === "loading") { setLoading(true); return; }
    if (status !== "authenticated") { setLoading(false); return; }
    setLoading(true);
    cloudAlerts().then(async (data) => {
      if (!cancelled) setAlerts(activeUniqueAlerts(data.alerts));
      try {
        const watchlist = await cloudWatchlist();
        if (!cancelled) { setItems(watchlist.items); setMonitoring(watchlist.monitoring); }
      } catch { /* Keep actual saved alerts usable if monitoring is unavailable. */ }
    }).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Unable to load alerts."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, accountKey, retry]);
  const remove = async (id: number) => {
    if (pending.includes(id)) return;
    const owner = accountKey;
    setPending((current) => [...current, id]); setMessage("");
    try {
      await removeCloudAlert(id);
      if (accountRef.current === owner) setAlerts((current) => current.filter((alert) => alert.id !== id));
    } catch (error) { if (accountRef.current === owner) setMessage(error instanceof Error ? error.message : "Could not remove alert."); }
    finally { if (accountRef.current === owner) setPending((current) => current.filter((value) => value !== id)); }
  };
  if (status === "loading" || loading) return <main className="app-shell list-page"><span className="eyebrow">Optional price targets</span><h1>Price alerts</h1><div className="alert-list" aria-busy="true"><div className="skeleton-card">Loading price alerts…</div><div className="skeleton-card" /></div></main>;
  if (status !== "authenticated") return <main className="app-shell list-page"><span className="eyebrow">Optional price targets</span><h1>Price alerts</h1><div className="empty-state"><strong>Sign in to save private targets</strong><p>Guest favourites are manual-only. After sign-in, a saved target can qualify for a notification when an available retailer price is strictly below it. Worker and email readiness still matter.</p><Link className="button button-primary" href="/account">Sign in</Link><Link className="button button-secondary" href="/favourites">View device favourites</Link></div></main>;
  return <main className="app-shell list-page watchlist-page">
    <span className="eyebrow">Optional price targets</span><h1>Price alerts</h1>
    <p className="muted-copy">Active targets only. A retailer price must be strictly below your target, not equal to it. You can set one even when no price is available yet.</p>
    <WatchlistMonitoringStatus monitoring={monitoring} />
    <div className="watchlist-navigation"><Link className="button button-secondary" href="/favourites">View favourites</Link><button className="button button-secondary" type="button" onClick={() => setRetry((value) => value + 1)}>Reload alerts</button></div>
    {message && <p className="inline-error" role="status">{message}</p>}
    {!alerts.length ? <div className="empty-state"><strong>{message ? "Alerts could not be loaded" : "No active alerts yet"}</strong><p>Set a target from a product result or a named favourite.</p><Link className="button button-primary" href="/favourites">Choose a favourite</Link></div> : <div className="watchlist-items">{alerts.map((alert) => {
      const item = items.find((candidate) => candidate.barcode === alert.barcode);
      const name = alert.product_name || item?.product_name || `Barcode ${alert.barcode}`;
      const open = editing === alert.barcode;
      return <article className="watchlist-item" key={alert.id} aria-busy={pending.includes(alert.id)}>
        <Link className="watchlist-product-link" href={`/result?barcode=${alert.barcode}`}><span><strong>{name}</strong><small>Barcode {alert.barcode}</small></span><span aria-hidden="true">›</span></Link>
        <div className="watchlist-price-state"><span className="watchlist-badge is-current">Active target</span><strong className="watchlist-price">Below R{Number(alert.target_price).toFixed(2)}</strong>
          {item?.best ? <p>Best recorded: R{Number(item.best.price).toFixed(2)} at {retailerLabel(item.best.retailer)}{item.best.stale ? " (stale)" : ""}. Source {formatWatchlistTime(item.best.updated_at)}.</p> : <p>{item?.availability === "unavailable" ? "No available price at the latest check." : item?.availability === "failed" ? "The latest price check failed." : "A current retailer price has not been confirmed."}</p>}
          {item && <p>Last checked: {formatWatchlistTime(item.last_checked_at)}</p>}
          {alert.last_sent_at && <p>Last notification sent: {formatWatchlistTime(alert.last_sent_at)}. Inbox delivery is not guaranteed.</p>}
        </div>
        <div className="watchlist-actions"><button className="button button-secondary" type="button" aria-expanded={open} aria-controls={`edit-alert-${alert.id}`} onClick={() => setEditing(open ? null : alert.barcode)}>{open ? "Close target" : "Change target"}</button><button className="button button-secondary" type="button" disabled={pending.includes(alert.id)} onClick={() => void remove(alert.id)}>{pending.includes(alert.id) ? "Removing…" : "Remove alert"}</button></div>
        {open && <div id={`edit-alert-${alert.id}`}><PriceAlertForm barcode={alert.barcode} productName={name} watchlist={Boolean(item)} /><p className="watchlist-footnote">Reload alerts after saving to see the updated target.</p></div>}
      </article>;
    })}</div>}
    <p className="watchlist-footnote">Saving the same product again updates its target instead of creating another active alert. Repeated same-price emails are suppressed for 24 hours. Price checking does not depend on email readiness.</p>
  </main>;
}
