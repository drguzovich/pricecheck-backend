"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ProductIcon, ScanIcon, SearchIcon } from "@/components/icons";

type SearchResult = {
  barcode: string;
  name: string;
  brand: string | null;
  pack_size: string | null;
};

type SearchState = "idle" | "loading" | "error" | "empty";

export function SearchHome() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [state, setState] = useState<SearchState>("idle");
  const [message, setMessage] = useState("");
  const [resultsQuery, setResultsQuery] = useState<string | null>(null);
  const currentQueryRef = useRef(query);
  const searchRequestRef = useRef(0);

  const updateQuery = (nextQuery: string) => {
    currentQueryRef.current = nextQuery;
    setQuery(nextQuery);
    if (state === "loading") {
      searchRequestRef.current += 1;
      setState("idle");
      setMessage("");
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    const barcode = value.replace(/\D/g, "");
    const requestId = ++searchRequestRef.current;
    if (!value) {
      setResults([]);
      setResultsQuery(null);
      setState("error");
      setMessage("Enter a barcode or at least two product-name characters.");
      return;
    }
    if (/^\d{8,14}$/.test(barcode)) {
      router.push(`/result?barcode=${barcode}`);
      return;
    }
    if (value.length < 2) {
      setResults([]);
      setResultsQuery(null);
      setState("error");
      setMessage("Enter at least two product-name characters.");
      return;
    }

    setState("loading");
    setMessage("");
    setResults([]);
    setResultsQuery(null);
    try {
      const response = await fetch(`/api/backend/api/search?q=${encodeURIComponent(value)}`, {
        headers: { Accept: "application/json" },
      });
      const body = await response.json().catch(() => ({})) as { results?: SearchResult[]; message?: string };
      if (requestId !== searchRequestRef.current || currentQueryRef.current.trim() !== value) return;
      if (!response.ok) throw new Error(body.message || "Search is unavailable right now.");
      const nextResults = Array.isArray(body.results) ? body.results : [];
      setResults(nextResults);
      setResultsQuery(value);
      if (nextResults.length) {
        setState("idle");
      } else {
        setState("empty");
        setMessage("No stored products match that search yet. Try scanning its barcode.");
      }
    } catch (error) {
      if (requestId !== searchRequestRef.current || currentQueryRef.current.trim() !== value) return;
      setState("error");
      setMessage(error instanceof Error ? error.message : "Search is unavailable right now.");
    }
  };

  return (
    <div className="home-search">
      <form className="home-search-form" onSubmit={submit} role="search">
        <label className="sr-only" htmlFor="home-product-search">Search by product name or barcode</label>
        <div className="home-search-input-wrap">
          <SearchIcon size={20} />
          <input
            id="home-product-search"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Search a product or enter barcode"
            autoComplete="off"
            inputMode="search"
          />
        </div>
        <button className="button button-primary home-search-submit" type="submit" disabled={state === "loading"}>
          {state === "loading" ? "Searching…" : "Search"}
        </button>
      </form>
      <Link className="home-scan-link" href="/scan">
        <ScanIcon size={20} />
        <span><strong>Scan a barcode</strong><small>Use your camera for the quickest exact match</small></span>
        <span aria-hidden="true" className="home-scan-arrow">›</span>
      </Link>
      {message && <p className={`home-search-message ${state === "error" ? "is-error" : ""}`} role="status">{message}</p>}
      {resultsQuery === query.trim() && results.length > 0 && (
        <div className="home-search-results" aria-label="Product search results">
          {results.slice(0, 5).map((product) => (
            <Link key={product.barcode} href={`/result?barcode=${encodeURIComponent(product.barcode)}`} className="home-search-result">
              <span className="product-glyph"><ProductIcon size={20} /></span>
              <span><strong>{product.name}</strong><small>{[product.brand, product.pack_size, product.barcode].filter(Boolean).join(" · ")}</small></span>
              <span className="arrow" aria-hidden="true">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
