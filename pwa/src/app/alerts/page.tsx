"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { cloudAlerts, removeCloudAlert, type StoredAlert } from "@/lib/user-api";

export default function AlertsPage() {
  const { status } = useSession(); const [alerts, setAlerts] = useState<StoredAlert[]>([]); const [message, setMessage] = useState("");
  const load = () => cloudAlerts().then((data) => setAlerts(data.alerts)).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load alerts."));
  useEffect(() => { if (status === "authenticated") load(); }, [status]);
  const remove = async (id: number) => { try { await removeCloudAlert(id); setAlerts((current) => current.filter((alert) => alert.id !== id)); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove alert."); } };
  if (status !== "authenticated") return <main className="app-shell list-page"><span className="eyebrow">Price tracking</span><h1>Price alerts</h1><div className="empty-state"><span>⌁</span><strong>Sign in to track price drops</strong><p>Alerts are emailed when an available exact-EAN retailer price reaches your target.</p><Link className="button button-primary" href="/account">Sign in</Link></div></main>;
  return <main className="app-shell list-page"><span className="eyebrow">Price tracking</span><h1>Price alerts</h1>{!alerts.length ? <div className="empty-state"><span>⌁</span><strong>No alerts yet</strong><p>Set a target price from any product result page.</p><Link className="button button-primary" href="/search">Find a product</Link></div> : <div className="alert-list">{alerts.map((alert) => <article key={alert.id}><div><strong>Barcode {alert.barcode}</strong><small>Target R{Number(alert.target_price).toFixed(2)}</small></div><button className="button button-secondary" onClick={() => remove(alert.id)}>Remove</button></article>)}</div>}{message && <p className="inline-error">{message}</p>}</main>;
}
