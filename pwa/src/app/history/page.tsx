"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { readGuestHistory, type GuestScan } from "@/lib/guest-data";
import { cloudHistory, type StoredScan } from "@/lib/user-api";

type Scan = GuestScan | StoredScan;
const productName = (scan: Scan) => "product_name" in scan ? scan.product_name : scan.productName;
const when = (scan: Scan) => "scanned_at" in scan ? scan.scanned_at : scan.scannedAt;

export default function HistoryPage() {
  const { status } = useSession();
  const [scans, setScans] = useState<Scan[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const newestFirst = (entries: Scan[]) => [...entries].sort((a, b) => new Date(when(b)).getTime() - new Date(when(a)).getTime());
    if (status === "loading") { setLoading(true); return; }
    if (status === "authenticated") {
      setLoading(true);
      cloudHistory().then((data) => { if (!cancelled) setScans(newestFirst(data.scans)); }).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Unable to load history."); }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    const syncGuestHistory = () => { if (!cancelled) setScans(newestFirst(readGuestHistory())); };
    syncGuestHistory();
    setLoading(false);
    window.addEventListener("pricecheck-guest-data", syncGuestHistory);
    window.addEventListener("storage", syncGuestHistory);
    return () => { cancelled = true; window.removeEventListener("pricecheck-guest-data", syncGuestHistory); window.removeEventListener("storage", syncGuestHistory); };
  }, [status]);

  return <main className="app-shell list-page"><span className="eyebrow">Your checks</span><h1>Scan history</h1><p className="muted-copy">{status === "authenticated" ? "Private cloud history, newest first." : "Stored only on this device until you sign in."}</p>{status === "unauthenticated" && <aside className="guest-banner" role="status">Sign in to sync across devices</aside>}{loading ? <div className="history-list" aria-busy="true"><div className="skeleton-card">Loading scan history…</div><div className="skeleton-card" /></div> : !scans.length ? <div className="empty-state"><span>◷</span><strong>You haven’t scanned anything yet.</strong><p>Scan a product or search the catalogue to start your history.</p><Link className="button button-primary" href="/scan">Scan a product</Link></div> : <div className="history-list">{scans.map((scan) => <Link key={`${scan.barcode}-${when(scan)}`} href={`/result?barcode=${scan.barcode}`}><span className="product-glyph">▣</span><span><strong>{productName(scan)}</strong><small>Barcode {scan.barcode} · {new Date(when(scan)).toLocaleDateString("en-ZA")}</small></span><span>›</span></Link>)}</div>}{message && <p className="inline-error" role="status">{message}</p>}</main>;
}
