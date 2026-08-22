"use client";

import { useEffect, useState } from "react";

type Coverage = {
  tracked_products: number;
  pending_product_requests: number;
  latest_price_update: string | null;
  retailers: { retailer: string; product_count: number }[];
};

const API_BASE_URL = process.env.NEXT_PUBLIC_PRICE_API_URL ?? "https://pricecheck-backend-7tkh.onrender.com";

export function CoverageStatus() {
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    fetch(`${API_BASE_URL}/coverage`, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("coverage unavailable")))
      .then((data) => setCoverage(data as Coverage))
      .catch(() => setCoverage(null))
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, []);

  if (!coverage) return null;
  const listedRetailers = coverage.retailers.length;
  return (
    <section className="coverage-status" aria-label="Live data coverage">
      <span className="coverage-dot" aria-hidden="true" />
      <p><strong>Live coverage:</strong> {coverage.tracked_products} scanned products and {listedRetailers} retailer source{listedRetailers === 1 ? "" : "s"} with confirmed prices.</p>
      {coverage.pending_product_requests > 0 && <span>{coverage.pending_product_requests} product {coverage.pending_product_requests === 1 ? "request" : "requests"} queued for enrichment.</span>}
    </section>
  );
}
