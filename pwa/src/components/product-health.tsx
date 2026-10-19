"use client";

import { useEffect, useState } from "react";
import { HealthSkeleton } from "@/components/skeleton";

type ProductHealthData = {
  barcode: string;
  cleanScore?: number | null;
  grade?: string | null;
  scoreAvailable?: boolean;
  concerns?: string[];
  nutriscore?: string | null;
  ingredientsText?: string | null;
  dataAvailable: boolean;
  missingData?: string[];
  dataCompleteness?: string | number | null;
};

type HealthState =
  | { status: "loading"; data?: ProductHealthData }
  | { status: "ready"; data: ProductHealthData; cached?: boolean }
  | { status: "error" };

const cacheKey = (barcode: string) => `pricecheck-health:${barcode}`;
const healthCacheAge = 24 * 60 * 60 * 1000;

function readCachedHealth(barcode: string) {
  try {
    const cached = JSON.parse(window.localStorage.getItem(cacheKey(barcode)) || "null") as { savedAt?: string; data?: ProductHealthData } | null;
    if (!cached?.data || !cached.savedAt || Date.now() - new Date(cached.savedAt).getTime() > healthCacheAge) return null;
    return cached.data;
  } catch {
    return null;
  }
}

function saveHealth(barcode: string, data: ProductHealthData) {
  try {
    window.localStorage.setItem(cacheKey(barcode), JSON.stringify({ savedAt: new Date().toISOString(), data }));
  } catch {
    // Browser storage is optional. The live endpoint remains the source of truth.
  }
}

function isHealthData(value: unknown): value is ProductHealthData {
  if (!value || typeof value !== "object" || !("dataAvailable" in value)) return false;
  const data = value as ProductHealthData;
  if (typeof data.dataAvailable !== "boolean") return false;
  if (data.scoreAvailable !== undefined && typeof data.scoreAvailable !== "boolean") return false;
  if (data.cleanScore !== undefined && data.cleanScore !== null && (typeof data.cleanScore !== "number" || !Number.isFinite(data.cleanScore))) return false;
  if (data.grade !== undefined && data.grade !== null && typeof data.grade !== "string") return false;
  if (data.concerns !== undefined && (!Array.isArray(data.concerns) || data.concerns.some((concern) => typeof concern !== "string"))) return false;
  if (data.ingredientsText !== undefined && data.ingredientsText !== null && typeof data.ingredientsText !== "string") return false;
  if (data.nutriscore !== undefined && data.nutriscore !== null && typeof data.nutriscore !== "string") return false;
  return data.missingData === undefined || (Array.isArray(data.missingData) && data.missingData.every((field) => typeof field === "string"));
}

function healthClass(score: number) {
  if (score >= 8) return "health-clean";
  if (score >= 5) return "health-ok";
  return "health-concerning";
}

function displayCompleteness(value: ProductHealthData["dataCompleteness"]) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value <= 1 ? `${Math.round(value * 100)}%` : `${Math.round(value)}%`;
  return null;
}

function hasFullScore(data: ProductHealthData): data is ProductHealthData & { cleanScore: number; grade: string } {
  return data.scoreAvailable !== false
    && typeof data.cleanScore === "number"
    && Number.isFinite(data.cleanScore)
    && data.cleanScore >= 1
    && data.cleanScore <= 10
    && typeof data.grade === "string"
    && data.grade.trim().length > 0;
}

export function ProductHealth({ barcode }: { barcode: string }) {
  const [state, setState] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    if (!/^\d{8,14}$/.test(barcode)) return;
    const cached = readCachedHealth(barcode);
    setState(cached ? { status: "ready", data: cached, cached: true } : { status: "loading" });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let cancelled = false;

    fetch(`/api/backend/product/${encodeURIComponent(barcode)}/health`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isHealthData(body)) throw new Error("Health data is unavailable");
        return body;
      })
      .then((data) => {
        if (cancelled) return;
        saveHealth(barcode, data);
        setState({ status: "ready", data });
      })
      .catch(() => {
        if (cancelled || cached) return;
        setState({ status: "error" });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [barcode]);

  if (!/^\d{8,14}$/.test(barcode)) return null;
  if (state.status === "loading") return <HealthSkeleton />;
  if (state.status === "error") {
    return <section className="product-health health-error-panel" aria-labelledby="product-health-heading"><h2 id="product-health-heading">Product Health</h2><p role="status">Product Health is unavailable right now. Price comparison is still available.</p></section>;
  }

  const { data } = state;
  if (!data.dataAvailable) {
    return <section className="product-health health-no-data" aria-labelledby="product-health-heading"><h2 id="product-health-heading">Product Health</h2><p>No ingredient data available for this product</p><small>Product Health uses available public ingredient information. It is not medical advice.</small></section>;
  }

  const completeness = displayCompleteness(data.dataCompleteness);
  const nutriscore = data.nutriscore?.trim().toUpperCase();
  const missingData = data.missingData?.filter((field) => field.trim().length > 0) ?? [];
  const details = <>
    {data.concerns && data.concerns.length > 0 && <div className="health-concerns" aria-label="Ingredient concerns">{data.concerns.map((concern) => <span className="health-pill" key={concern}>{concern}</span>)}</div>}
    {data.ingredientsText && <details className="ingredient-details"><summary>View ingredients</summary><p>{data.ingredientsText}</p></details>}
    {data.dataCompleteness !== null && data.dataCompleteness !== undefined && completeness && <p className="health-partial">Ingredient data completeness: {completeness}. Scores reflect the available source data.</p>}
  </>;

  if (!hasFullScore(data)) {
    return (
      <section className="product-health health-no-data" aria-labelledby="product-health-heading">
        <div className="health-heading"><div><span className="eyebrow">Ingredient information</span><h2 id="product-health-heading">Product Health</h2></div>{state.cached && <small className="health-cached">Saved information</small>}</div>
        <p>Not enough information to calculate a Clean Score</p>
        {missingData.length > 0 && <p className="health-partial">Missing information: {missingData.join(", ")}.</p>}
        {nutriscore && /^[A-E]$/.test(nutriscore) && <p className="health-partial">Nutri-Score: {nutriscore}</p>}
        {details}
        <p className="health-disclaimer">Product Health is based on available public ingredient information and is not medical advice.</p>
      </section>
    );
  }

  const score = Math.round(data.cleanScore);
  const grade = data.grade;

  return (
    <section className={`product-health ${healthClass(score)}`} aria-labelledby="product-health-heading">
      <div className="health-heading"><div><span className="eyebrow">Ingredient information</span><h2 id="product-health-heading">Product Health</h2></div>{state.cached && <small className="health-cached">Saved information</small>}</div>
      <div className="health-summary">
        <div className="health-score" aria-label={`Clean Score ${score} out of 10, ${grade}`}><strong>{score}</strong><span>/10</span></div>
        <div className="health-grade"><strong>{grade}</strong><span>Clean Score</span>{nutriscore && /^[A-E]$/.test(nutriscore) && <span className="nutriscore-badge" aria-label={`Nutri-Score ${nutriscore}`}>Nutri-Score {nutriscore}</span>}</div>
      </div>
      {details}
      <p className="health-disclaimer">Product Health is based on available public ingredient information and is not medical advice.</p>
    </section>
  );
}
