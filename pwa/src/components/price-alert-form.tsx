"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { createCloudAlert, createWatchlistAlert } from "@/lib/user-api";
import "@/styles/watchlist.css";

export function PriceAlertForm({ barcode, productName, watchlist = false }: { barcode: string; productName?: string; watchlist?: boolean }) {
  const { status } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!watchlist && status === "authenticated" && new URLSearchParams(window.location.search).get("alert") === "1") inputRef.current?.focus();
  }, [status, watchlist]);
  useEffect(() => { setTarget(""); setMessage(""); }, [barcode, status]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const value = Number(target);
    if (!Number.isFinite(value) || value <= 0 || value > 100000) {
      setFailed(true); setMessage("Enter a target price between R0.01 and R100000."); return;
    }
    setPending(true); setFailed(false); setMessage("");
    try {
      const response = await (watchlist ? createWatchlistAlert(barcode, value) : createCloudAlert(barcode, value));
      const monitoring = response.monitoring;
      const schedule = monitoring?.lastSuccessfulRunAt
        ? "A previous scheduled check completed. Future checks depend on worker availability."
        : monitoring?.workerConfigured
          ? "Scheduled checking is configured, but a successful run has not yet been confirmed."
          : "Scheduled checking has not been confirmed. You can check prices manually.";
      const delivery = response.deliveryEnabled
        ? "Email settings are configured. Saving an alert does not confirm email delivery."
        : "Email notifications are not configured. Price checks can still run without email.";
      setMessage(`Target saved. Only an available price strictly below R${value.toFixed(2)} qualifies. ${schedule} ${delivery}`);
      setTarget("");
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : "Could not save price alert.");
    } finally { setPending(false); }
  };
  if (status === "loading") return <aside className="price-alert skeleton-card" aria-busy="true">Loading price alerts…</aside>;
  if (status !== "authenticated") return <aside className="price-alert"><strong>Set a target price</strong><p>Guest favourites are saved only on this device and are not checked automatically. Sign in to save a private target alert.</p><Link className="button button-secondary" href="/account">Sign in to set an alert</Link></aside>;
  return <form className="price-alert watchlist-alert-form" onSubmit={submit} aria-busy={pending}>
    <strong>{productName ? `Target for ${productName}` : "Set a target price"}</strong>
    <p>A current price is not required. A notification qualifies only when a future available retailer price is strictly below your target. Scheduled checks and email delivery depend on service readiness.</p>
    <label htmlFor={inputId}>Alert me when price drops below R</label>
    <div><input ref={inputRef} id={inputId} inputMode="decimal" type="number" min="0.01" max="100000" step="0.01" required value={target} disabled={pending} onChange={(event) => setTarget(event.target.value)} placeholder="Target in rands" /><button className="button button-primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save target"}</button></div>
    {message && <small className={failed ? "inline-error" : "watchlist-feedback"} role="status">{message}</small>}
  </form>;
}
