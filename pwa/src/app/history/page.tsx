"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { readGuestHistory, type GuestScan } from "@/lib/guest-data";
import { cloudHistory, type StoredScan } from "@/lib/user-api";

type Scan = GuestScan | StoredScan;
const productName = (scan: Scan) => "product_name" in scan ? scan.product_name : scan.productName;
const when = (scan: Scan) => "scanned_at" in scan ? scan.scanned_at : scan.scannedAt;

export default function HistoryPage() {
  const { data: session, status } = useSession();
  const identity = (session?.user as { id?: string } | undefined)?.id || session?.user?.email || "";
  const ownerKey = status === "authenticated" ? `${status}:${identity}` : status;
  const ownerRef = useRef({ key: ownerKey });
  // A new token also invalidates an old A request after an A → B → A switch.
  if (ownerRef.current.key !== ownerKey) ownerRef.current = { key: ownerKey };
  const owner = ownerRef.current;
  const [history, setHistory] = useState<{ owner: typeof owner; scans: Scan[]; message: string; loading: boolean }>({ owner, scans: [], message: "", loading: true });

  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && ownerRef.current === owner;
    const newestFirst = (entries: Scan[]) => [...entries].sort((a, b) => new Date(when(b)).getTime() - new Date(when(a)).getTime());
    setHistory({ owner, scans: [], message: "", loading: true });
    if (status === "loading") return () => { cancelled = true; };
    if (status === "authenticated") {
      if (!identity) {
        setHistory({ owner, scans: [], message: "Your account could not be identified. Please sign in again to load private history.", loading: false });
        return () => { cancelled = true; };
      }
      void cloudHistory().then((data) => {
        if (!Array.isArray(data.scans)) throw new Error("Unable to load history.");
        if (current()) setHistory({ owner, scans: newestFirst(data.scans), message: "", loading: false });
      }).catch((error) => {
        if (current()) setHistory({ owner, scans: [], message: error instanceof Error ? error.message : "Unable to load history.", loading: false });
      });
      return () => { cancelled = true; };
    }
    const syncGuestHistory = () => {
      if (!current()) return;
      try { setHistory({ owner, scans: newestFirst(readGuestHistory()), message: "", loading: false }); }
      catch { setHistory({ owner, scans: [], message: "Device history could not be read right now.", loading: false }); }
    };
    syncGuestHistory();
    window.addEventListener("pricecheck-guest-data", syncGuestHistory);
    window.addEventListener("trolleywise-guest-data", syncGuestHistory);
    window.addEventListener("storage", syncGuestHistory);
    return () => {
      cancelled = true;
      window.removeEventListener("pricecheck-guest-data", syncGuestHistory);
      window.removeEventListener("trolleywise-guest-data", syncGuestHistory);
      window.removeEventListener("storage", syncGuestHistory);
    };
  }, [identity, owner, status]);

  // Hide the previous principal's state in this render, before passive effects run.
  const { scans, message, loading } = history.owner === owner ? history : { scans: [], message: "", loading: true };
  return <main className="app-shell list-page"><span className="eyebrow">Your checks</span><h1>Scan history</h1><p className="muted-copy">{status === "authenticated" ? "Private cloud history, newest first." : "Stored only on this device until you sign in."}</p>{status === "unauthenticated" && <aside className="guest-banner" role="status">Sign in to sync across devices</aside>}{loading ? <div className="history-list" aria-busy="true"><div className="skeleton-card">Loading scan history…</div><div className="skeleton-card" /></div> : !scans.length ? <div className="empty-state"><span>◷</span><strong>You haven’t scanned anything yet.</strong><p>Scan a product or search the catalogue to start your history.</p><Link className="button button-primary" href="/scan">Scan a product</Link></div> : <div className="history-list">{scans.map((scan) => <Link key={`${scan.barcode}-${when(scan)}`} href={`/result?barcode=${scan.barcode}`}><span className="product-glyph">▣</span><span><strong>{productName(scan)}</strong><small>Barcode {scan.barcode} · {new Date(when(scan)).toLocaleDateString("en-ZA")}</small></span><span>›</span></Link>)}</div>}{message && <p className="inline-error" role="status">{message}</p>}</main>;
}
