"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { SearchProduct, searchProducts } from "@/lib/price-api";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchProduct[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [message, setMessage] = useState("Search products already seen by the live catalogue.");

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) { setMessage("Enter at least two characters."); return; }
    setStatus("loading");
    try {
      const { response, body } = await searchProducts(query.trim());
      if (!response.ok) throw new Error(body.message || "Search is unavailable");
      setResults(body.results || []);
      setStatus((body.results || []).length ? "idle" : "empty");
      setMessage((body.results || []).length ? "Choose a product to compare current prices." : "No matching products are stored yet. Try scanning or entering its barcode.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Search is unavailable. Try a barcode instead.");
    }
  };

  return (
    <main className="app-shell"><SiteHeader />
      <section className="search-page"><span className="eyebrow">Product search</span><h1>Search by product name.</h1><p>Use a barcode for the most direct lookup. Name search expands as retailer catalogue records are added.</p>
        <form className="search-form" onSubmit={onSubmit}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try Ouma rusks" /><button className="button button-primary" disabled={status === "loading"}>{status === "loading" ? "Searching…" : "Search"}</button></form>
        <p className={`status-message ${status === "error" ? "error" : ""}`}>{message}</p>
        <div className="search-results">{results.map((product) => <Link key={product.barcode} href={`/result?barcode=${product.barcode}`} className="search-result"><span className="product-glyph">▣</span><span><strong>{product.name}</strong><small>{[product.brand, product.pack_size, product.barcode].filter(Boolean).join(" · ")}</small></span><span className="arrow">›</span></Link>)}</div>
      </section>
    </main>
  );
}
