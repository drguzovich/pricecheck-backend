"use client";

import { useEffect, useState } from "react";
import { backendRequest } from "@/lib/backend-api";

type Coverage = {
  tracked_products: number;
  pending_product_requests: number;
  latest_price_update: string | null;
  retailers: { retailer: string; product_count: number }[];
};

export function CoverageStatus() {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    backendRequest("/coverage", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("coverage unavailable")))
      .then((data) => { setCoverage(data as Coverage); setState("ready"); })
      .catch(() => { setCoverage(null); setState("unavailable"); })
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);

  if (state === "loading") return <section className="coverage-status skeleton-card" aria-busy="true" aria-label="Loading live coverage" />;
  if (!coverage) return <section className="coverage-status" role="status"><p>Live coverage details are temporarily unavailable.</p></section>;
  const listedRetailers = coverage.retailers.length;
  return (
    <section className="coverage-status" aria-label="Live data coverage">
      <span className="coverage-dot" aria-hidden="true" />
      <p><strong>Live coverage:</strong> {coverage.tracked_products} scanned products and {listedRetailers} retailer source{listedRetailers === 1 ? "" : "s"} with confirmed prices.</p>
      {coverage.pending_product_requests > 0 && <span>{coverage.pending_product_requests} product {coverage.pending_product_requests === 1 ? "request" : "requests"} queued for enrichment.</span>}
    </section>
  );
}
