"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { createCloudAlert } from "@/lib/user-api";

export function PriceAlertForm({ barcode }: { barcode: string }) {
  const { status } = useSession();
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = Number(target);
    if (!Number.isFinite(value) || value <= 0) { setMessage("Enter a valid target price in rands."); return; }
    try { await createCloudAlert(barcode, value); setMessage("Alert saved. We will email you when a tracked price is at or below this amount."); setTarget(""); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save price alert."); }
  };
  if (status !== "authenticated") return <aside className="price-alert"><strong>Track a price drop</strong><p>Sign in to receive an email when this item reaches your target price.</p><Link className="button button-secondary" href="/account">Sign in to set an alert</Link></aside>;
  return <form className="price-alert" onSubmit={submit}><strong>Track a price drop</strong><p>Set your target in rands. Alerts check available exact-EAN retailer prices every six hours.</p><label htmlFor="target-price">Target price (R)</label><div><input id="target-price" inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="e.g. 49.99" /><button className="button button-primary" type="submit">Create alert</button></div>{message && <small role="status">{message}</small>}</form>;
}
