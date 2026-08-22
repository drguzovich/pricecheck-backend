"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readRecentSearches, type RecentSearch } from "@/lib/recent-searches";

export function RecentSearches() {
  const [searches, setSearches] = useState<RecentSearch[]>([]);

  useEffect(() => {
    const sync = () => setSearches(readRecentSearches());
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  if (!searches.length) {
    return <div className="recent-empty"><span className="product-glyph">▣</span><div><strong>Your recent searches will appear here.</strong><p>Scan a product or search the live catalogue to build your private on-device history.</p></div></div>;
  }

  return <div className="recent-list">{searches.map((item) => <Link key={item.barcode} className="recent-card" href={`/result?barcode=${item.barcode}`}><span className="product-glyph">▣</span><span><strong>{item.name}</strong><small>Barcode {item.barcode}</small></span><span className="arrow">›</span></Link>)}</div>;
}
