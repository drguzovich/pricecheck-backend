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
  const { status } = useSession(); const [scans, setScans] = useState<Scan[]>([]); const [message, setMessage] = useState("");
  useEffect(() => { if (status === "authenticated") cloudHistory().then((data) => setScans(data.scans)).catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load history.")); else if (status === "unauthenticated") setScans(readGuestHistory()); }, [status]);
  return <main className="app-shell list-page"><span className="eyebrow">Your checks</span><h1>Scan history</h1><p className="muted-copy">{status === "authenticated" ? "Private cloud history, newest first." : "Stored only on this device until you sign in."}</p>{!scans.length && status !== "loading" ? <div className="empty-state"><span>◷</span><strong>No scans yet</strong><p>Scan a product or search the catalogue to start your history.</p><Link className="button button-primary" href="/scan">Scan a product</Link></div> : <div className="history-list">{scans.map((scan) => <Link key={`${scan.barcode}-${when(scan)}`} href={`/result?barcode=${scan.barcode}`}><span className="product-glyph">▣</span><span><strong>{productName(scan)}</strong><small>Barcode {scan.barcode} · {new Date(when(scan)).toLocaleDateString("en-ZA")}</small></span><span>›</span></Link>)}</div>}{message && <p className="inline-error">{message}</p>}</main>;
}
