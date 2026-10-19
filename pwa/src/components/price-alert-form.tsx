"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { createCloudAlert } from "@/lib/user-api";

export function PriceAlertForm({ barcode }: { barcode: string }) {
  const { status } = useSession();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (status === "authenticated" && params.get("alert") === "1") inputRef.current?.focus();
  }, [params, status]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(target);
    if (!Number.isFinite(value) || value <= 0) { setMessage("Enter a valid target price in rands."); return; }
    try {
      const response = await createCloudAlert(barcode, value);
      setMessage(response.deliveryEnabled
        ? "Alert saved. We will email you when a tracked price drops below this amount."
        : `Alert saved. Email notifications are not configured.${response.deliveryMessage ? ` ${response.deliveryMessage}` : ""}`);
      setTarget("");
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save price alert."); }
  };
  if (status === "loading") return <aside className="price-alert skeleton-card" aria-busy="true">Loading price alerts…</aside>;
  if (status !== "authenticated") return <aside className="price-alert"><strong>Track a price drop</strong><p>Sign in to save an alert when this item drops below your target price.</p><Link className="button button-secondary" href="/account">Sign in to set an alert</Link></aside>;
  return <form className="price-alert" onSubmit={submit}><strong>Track a price drop</strong><p>Alerts check available exact-EAN retailer prices every six hours.</p><label htmlFor="target-price">Alert me when price drops below R</label><div><input ref={inputRef} id="target-price" aria-label="Price target in rands" inputMode="decimal" type="number" min="0.01" step="0.01" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="49.99" /><button className="button button-primary" type="submit">Create alert</button></div>{message && <small role="status">{message}</small>}</form>;
}
