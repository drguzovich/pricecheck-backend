"use client";

import { useEffect, useState } from "react";
import { watchlistTrend, type WatchlistMonitoring, type WatchlistTrendPoint } from "@/lib/user-api";
import "@/styles/watchlist.css";

export function formatWatchlistTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
export function retailerLabel(value: string) {
  const names: Record<string, string> = { woolworths: "Woolworths", pick_n_pay: "Pick n Pay", pnp: "Pick n Pay", checkers: "Checkers", spar: "SPAR" };
  return names[value] || value.replace(/_/g, " ");
}
export function WatchlistMonitoringStatus({ monitoring }: { monitoring: WatchlistMonitoring | null }) {
  if (!monitoring) return <aside className="watchlist-status"><strong>Scheduled checking not confirmed</strong><p>Use a manual check while monitoring status is unavailable.</p></aside>;
  const latest = monitoring.latestRun;
  const overdue = monitoring.lastSuccessfulRunAt && Date.now() - new Date(monitoring.lastSuccessfulRunAt).getTime() > 12 * 60 * 60 * 1000;
  return <aside className="watchlist-status" aria-label="Scheduled monitoring status">
    <strong>{monitoring.workerConfigured ? "Six-hour schedule configured" : "Scheduled checking not configured"}</strong>
    <p>{monitoring.lastSuccessfulRunAt ? `Last completed scheduled batch: ${formatWatchlistTime(monitoring.lastSuccessfulRunAt)}.` : "No completed scheduled batch has been confirmed yet."} {overdue ? "Scheduled checks may be delayed. " : ""}Configuration does not guarantee future checks. Large watchlists rotate across runs.</p>
    {latest && <p>Latest batch: <b>{latest.state}</b>{latest.finished_at ? ` at ${formatWatchlistTime(latest.finished_at)}` : `, started ${formatWatchlistTime(latest.started_at)}`}.{typeof latest.metrics.checked === "number" ? ` ${latest.metrics.checked} products checked.` : ""}{(latest.metrics.remaining ?? latest.metrics.deferred ?? 0) > 0 ? ` ${latest.metrics.remaining ?? latest.metrics.deferred} products were not checked in this batch.` : ""}</p>}
    <p>{monitoring.deliveryEnabled ? "Email settings are configured. Saving a target does not verify delivery." : "Email notifications are not configured. Price checking is independent of email."}</p>
  </aside>;
}
function TrendChart({ points }: { points: WatchlistTrendPoint[] }) {
  const valid = points.filter((point) => point.best_price !== null && Number.isFinite(point.best_price) && point.best_price > 0);
  if (valid.length < 2) return null;
  const times = points.map((point) => new Date(point.checked_at).getTime());
  const minTime = Math.min(...times); const maxTime = Math.max(...times);
  const prices = valid.map((point) => Number(point.best_price));
  const low = Math.min(...prices); const high = Math.max(...prices);
  const position = (point: WatchlistTrendPoint) => ({
    x: 12 + ((new Date(point.checked_at).getTime() - minTime) / (maxTime - minTime || 1)) * 296,
    y: 12 + ((high - Number(point.best_price)) / (high - low || 1)) * 72,
  });
  const segments: string[] = [];
  let segment: string[] = []; let previousTime: number | null = null;
  for (const point of points) {
    const time = new Date(point.checked_at).getTime();
    if (point.best_price === null || !Number.isFinite(point.best_price) || point.best_price <= 0 || (previousTime !== null && time - previousTime > 36 * 60 * 60 * 1000)) {
      if (segment.length) segments.push(segment.join(" ")); segment = [];
    }
    if (point.best_price !== null && Number.isFinite(point.best_price) && point.best_price > 0) {
      const { x, y } = position(point); segment.push(`${x},${y}`);
    }
    previousTime = time;
  }
  if (segment.length) segments.push(segment.join(" "));
  return <div className="watchlist-chart">
    <svg viewBox="0 0 320 100" role="img" aria-label={`Observed daily lowest prices ranged from R${low.toFixed(2)} to R${high.toFixed(2)}. Values are listed in the table below.`}>
      {segments.map((path, index) => <polyline key={index} points={path} fill="none" stroke="currentColor" strokeWidth="2.5" />)}
      {valid.map((point) => { const { x, y } = position(point); return <circle key={point.checked_at} cx={x} cy={y} r="3" fill="currentColor" />; })}
    </svg>
    <div><span>R{low.toFixed(2)} low</span><span>R{high.toFixed(2)} high</span></div>
  </div>;
}
export function WatchlistTrend({ barcode, refreshedAt }: { barcode: string; refreshedAt: string | null }) {
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<WatchlistTrendPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(""); setPoints([]);
    watchlistTrend(barcode).then((data) => {
      if (!cancelled) setPoints(data.points.filter((point) => Number.isFinite(new Date(point.checked_at).getTime())));
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Price history is temporarily unavailable."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, barcode, refreshedAt, retry]);
  return <details className="watchlist-trend" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Price history <span>Last 30 days</span></summary>
    {open && <div aria-busy={loading}>
      <p>Daily lowest price observed during completed checks, not a guaranteed store price. Gaps mean no available price was recorded.</p>
      {loading ? <p role="status">Loading recorded prices…</p> : error ? <><p className="inline-error" role="status">{error}</p><button className="button button-secondary" type="button" onClick={() => setRetry((value) => value + 1)}>Retry history</button></> : !points.length ? <p>No recorded trend yet. History builds from completed checks.</p> : <>
        <TrendChart points={points} />
        <div className="watchlist-table-wrap"><table><caption className="sr-only">Daily lowest observed prices for barcode {barcode}</caption><thead><tr><th scope="col">Date</th><th scope="col">Lowest observed</th><th scope="col">Checks</th></tr></thead><tbody>{points.map((point) => <tr key={point.checked_at}><th scope="row">{new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(point.checked_at))}</th><td>{point.best_price !== null && Number.isFinite(point.best_price) && point.best_price > 0 ? `R${point.best_price.toFixed(2)}` : "Unavailable"}</td><td>{point.available_checks}/{point.checks}</td></tr>)}</tbody></table></div>
      </>}
    </div>}
  </details>;
}
