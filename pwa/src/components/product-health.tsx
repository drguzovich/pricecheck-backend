"use client";

import { useEffect, useState } from "react";
import { HealthSkeleton } from "@/components/skeleton";
import { LabelDataInput } from "@/components/label-data-input";
import { isHealthData, isSourceImageUrl, NUTRIENT_ROWS, type Nutrition, type ProductHealthData } from "@/lib/product-health";
import "@/styles/product-health.css";

// Preserve existing component imports while keeping the public API contract
// independently testable without mounting a React component.
export { isHealthData, NUTRIENT_ROWS } from "@/lib/product-health";
export type { ProductHealthData } from "@/lib/product-health";

type CachedHealth = { savedAt: string; data: ProductHealthData };
type HealthState = {
  status: "loading" | "ready" | "error";
  data?: ProductHealthData;
  cached?: boolean;
  savedAt?: string | null;
  stale?: boolean;
  refreshing?: boolean;
  retryFailed?: boolean;
  attemptedAt?: string | null;
};

const cacheKey = (barcode: string) => `trolleywise-health:${barcode}`;
const healthCacheAge = 24 * 60 * 60 * 1000;
const disclaimer = "Clean Score is a limited, non-validated, non-medical heuristic, not a nutrition or medical endorsement. It is not medical or allergy advice. Check the physical label for ingredients and allergens; source records can be incomplete or outdated.";
const scoreMethod = "Start at 10. Deduct 1 per distinct E-number additive, capped at 4; 1 if any selected artificial color is present; 1 if any selected preservative is present; 1 for sugar above 20 g per 100g; 1 for sodium above 1 g per 100g; and 1 for Nutri-Score D or E. Minimum 1. Clean: 8 to 10. OK: 5 to 7. Concerning: 1 to 4.";

function readCachedHealth(barcode: string): CachedHealth | null {
  try {
    let raw = window.localStorage.getItem(cacheKey(barcode));
    if (!raw) {
      raw = window.localStorage.getItem(`pricecheck-health:${barcode}`);
      if (raw) window.localStorage.setItem(cacheKey(barcode), raw);
    }
    const cached = JSON.parse(raw || "null") as CachedHealth | null;
    if (!cached || !isHealthData(cached.data) || cached.data.barcode !== barcode || typeof cached.savedAt !== "string") return null;
    const age = Date.now() - new Date(cached.savedAt).getTime();
    const maxAge = cached.data.sourceStatus === "temporarily_unavailable" ? 60_000 : healthCacheAge;
    if (!Number.isFinite(age) || age < 0 || age > maxAge) return null;
    return cached;
  } catch {
    return null;
  }
}

function saveHealth(barcode: string, data: ProductHealthData): string | null {
  const savedAt = new Date().toISOString();
  try {
    window.localStorage.setItem(cacheKey(barcode), JSON.stringify({ savedAt, data }));
    return savedAt;
  } catch {
    // Public lookup storage is optional. User-entered label notes have a separate key.
    return null;
  }
}

function healthClass(score: number) {
  if (score >= 8) return "health-clean";
  if (score >= 5) return "health-ok";
  return "health-concerning";
}

function hasFullScore(data: ProductHealthData): data is ProductHealthData & { cleanScore: number; grade: string } {
  return data.dataAvailable && data.scoreAvailable !== false
    && typeof data.cleanScore === "number" && Number.isInteger(data.cleanScore)
    && data.cleanScore >= 1 && data.cleanScore <= 10
    && ["Clean", "OK", "Concerning"].includes(data.grade || "");
}

function Timestamp({ label, value }: { label: string; value?: string | null }) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  return <span>{label}: <time dateTime={value}>{new Date(value).toLocaleString()}</time></span>;
}

export function NutritionTable({ nutrition }: { nutrition?: Nutrition }) {
  return (
    <table className="health-nutrition-table">
      <caption>Nutrition per 100g</caption>
      <thead><tr><th scope="col">Nutrient</th><th scope="col">Amount</th></tr></thead>
      <tbody>{NUTRIENT_ROWS.map(([key, label, unit]) => {
        const nutrient = nutrition?.[key];
        const value = nutrient?.value;
        const available = typeof value === "number" && Number.isFinite(value);
        return <tr key={key}><th scope="row">{label}{key.startsWith("energy") ? ` (${unit})` : ""}</th><td>
          {available ? <>{value.toLocaleString(undefined, { maximumFractionDigits: 6 })} {unit}{nutrient?.calculated && <small className="health-calculated">Calculated from sodium × 2.5</small>}</> : <span className="health-missing">Not reported</span>}
        </td></tr>;
      })}</tbody>
    </table>
  );
}

function sourceMessage(data?: ProductHealthData) {
  if (!data) return "Open Food Facts could not be reached. Price comparison is still separate.";
  if (data.sourceStatus === "temporarily_unavailable") return data.dataAvailable
    ? "Open Food Facts could not be reached. Showing saved source information, which may be outdated."
    : "Open Food Facts is temporarily unavailable. This does not mean the product has no ingredients or nutrition information.";
  if (data.sourceStatus === "not_found") return "This barcode was not found in Open Food Facts. No verified source score is available.";
  if (!data.dataAvailable) return "No ingredient or nutrition fields are available in this Open Food Facts record.";
  return null;
}

export function ProductHealth({ barcode }: { barcode: string }) {
  const [state, setState] = useState<HealthState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!/^\d{8,14}$/.test(barcode)) return;
    const cached = readCachedHealth(barcode);
    const force = retryCount > 0;
    setState((previous) => {
      const data = previous.data?.barcode === barcode ? previous.data : cached?.data;
      return data ? { status: "ready", data, cached: true, savedAt: cached?.savedAt, stale: previous.data?.barcode === barcode ? previous.stale : true, refreshing: true }
        : { status: "loading", refreshing: true };
    });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let cancelled = false;
    const query = force ? `?force=1` : "";

    fetch(`/api/backend/product/${encodeURIComponent(barcode)}/health${query}`, {
      headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store",
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok || !isHealthData(body) || body.barcode !== barcode) throw new Error("Source lookup unavailable");
        const stale = body.stale === true || response.headers.get("X-TrolleyWise-Cache") === "stale" || response.headers.get("X-PriceCheck-Cache") === "stale";
        return { data: body, stale };
      })
      .then(({ data, stale }) => {
        if (cancelled) return;
        const temporary = data.sourceStatus === "temporarily_unavailable";
        const savedAt = !stale && !temporary ? saveHealth(barcode, data) : cached?.savedAt;
        setState((previous) => {
          if (temporary && !data.dataAvailable && previous.data?.barcode === barcode && previous.data.dataAvailable) {
            return { ...previous, status: "ready", refreshing: false, cached: true, stale: true, retryFailed: true,
              data: { ...previous.data, sourceStatus: "temporarily_unavailable", latestAttemptAt: data.checkedAt } };
          }
          return { status: "ready", data, cached: stale || data.cacheStatus === "cached", stale, savedAt, refreshing: false, retryFailed: temporary };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState((previous) => previous.data?.barcode === barcode
          ? { ...previous, status: "ready", cached: true, stale: true, refreshing: false, retryFailed: true, attemptedAt: new Date().toISOString() }
          : { status: "error", refreshing: false, retryFailed: true, attemptedAt: new Date().toISOString() });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [barcode, retryCount]);

  if (!/^\d{8,14}$/.test(barcode)) return null;
  if (state.status === "loading") return <div className="health-loading"><HealthSkeleton /><p role="status">Checking Open Food Facts for ingredients and nutrition...</p></div>;
  // A barcode can change before its effect has run. Never show the previous item.
  if (state.data && state.data.barcode !== barcode) return <HealthSkeleton />;

  const data = state.data;
  const scored = data && hasFullScore(data);
  const nutriscore = data?.nutriscore?.trim().toUpperCase();
  const missingData = data?.missingData?.filter((field) => field.trim()) ?? [];
  const message = sourceMessage(data);
  const ingredients = data?.ingredientsText?.trim();
  const allergens = Array.from(new Set(data?.allergensTags?.map((tag) => tag.trim()).filter(Boolean) ?? []));
  const traces = Array.from(new Set(data?.tracesTags?.map((tag) => tag.trim()).filter(Boolean) ?? []));
  const nutritionImageUrl = data?.imageNutritionUrl && isSourceImageUrl(data.imageNutritionUrl) ? data.imageNutritionUrl : null;
  const cachedLabel = data?.dataAvailable ? "Saved source information" : "Saved lookup result";

  return (
    <section className={`product-health tw-health ${scored ? healthClass(data.cleanScore) : "health-no-data"}`} aria-labelledby="product-health-heading" aria-busy={state.refreshing || false}>
      <div className="health-heading"><div><span className="eyebrow">Ingredients &amp; nutrition</span><h2 id="product-health-heading">Product Health</h2></div>
        <button type="button" className="button button-secondary health-retry" disabled={state.refreshing} onClick={() => setRetryCount((count) => count + 1)}>{state.refreshing ? "Checking..." : "Retry health lookup"}</button>
      </div>
      <div className="health-source">
        <a href={`https://world.openfoodfacts.org/product/${encodeURIComponent(barcode)}`} target="_blank" rel="noreferrer">Source: Open Food Facts</a>
        <Timestamp label={data?.sourceStatus === "temporarily_unavailable" && !data.dataAvailable ? "Lookup attempted" : "Source checked"} value={data?.checkedAt} />
        <Timestamp label="Source record updated" value={data?.sourceModifiedAt} />
        {state.cached && <><span className="health-cached">{cachedLabel}{state.stale ? " (may be outdated)" : ""}</span><Timestamp label="Cached" value={data?.cachedAt || state.savedAt} />{!data?.checkedAt && <span>Original source check time was not supplied.</span>}</>}
        <Timestamp label="Latest lookup attempt" value={data?.latestAttemptAt || state.attemptedAt} />
      </div>
      <div className="health-lookup-status" role="status" aria-live="polite">
        {state.refreshing && <p>Checking the ingredient and nutrition source. Price lookup is unchanged.</p>}
        {message && <p>{message}</p>}
        {state.retryFailed && data?.sourceStatus !== "temporarily_unavailable" && <p>The latest lookup failed. {data ? "The saved lookup is not a fresh source check." : "Try again when the source or your connection is available."}</p>}
        {state.stale && data?.sourceStatus !== "temporarily_unavailable" && !state.retryFailed && <p>Showing saved information, not a fresh source check.</p>}
      </div>

      <div className="health-source-sections">
        <div className="health-ingredients"><h3>Ingredients</h3>{ingredients ? <p className="health-ingredient-text">{ingredients}</p> : <p className="health-missing">Ingredient text is not available from this source.</p>}</div>
        <div className="health-allergens"><h3>Source-reported allergens &amp; traces</h3>
          {allergens.length > 0 ? <p>Allergens reported by Open Food Facts: {allergens.join(", ")}.</p> : <p className="health-missing">Allergen tags are not supplied in the available source data. This does not mean there are no allergens.</p>}
          {traces.length > 0 ? <p>Trace caution reported by Open Food Facts: {traces.join(", ")}. Check the physical label for any may-contain warning.</p> : <p className="health-missing">Trace tags are not supplied in the available source data. Absence of a tag does not rule out traces or cross-contact.</p>}
          <p className="health-partial">These are Open Food Facts source tags, not verified allergy-safety advice. Source data may be incomplete or outdated; always check the physical label. They do not change the Clean Score.</p>
        </div>
        <div className="health-nutrition"><NutritionTable nutrition={data?.nutritionPer100g} />
          {!data?.nutritionAvailable && <p className="health-partial">No per100g nutrient amounts were supplied. Missing values are not zero.</p>}
          <p className="health-partial">These are the source&apos;s standardized per100g fields, not per-serving amounts. For liquids, check whether the physical label uses 100ml.</p>
          {nutritionImageUrl && <p><a href={nutritionImageUrl} target="_blank" rel="noreferrer">View the nutrition-label image supplied by Open Food Facts</a></p>}
        </div>
      </div>

      <div className="health-heuristic">
        {scored ? <div className="health-summary"><div className="health-score" aria-label={`Clean Score ${data.cleanScore} out of 10, ${data.grade}, heuristic band`}><strong>{data.cleanScore}</strong><span>/10</span></div><div className="health-grade"><strong>{data.grade}</strong><span>Clean Score heuristic band</span><span>Limited, non-validated heuristic</span></div></div>
          : <p className="health-score-missing">Clean Score unavailable.{missingData.length > 0 && <span> Missing score inputs: {missingData.join(", ")}.</span>}</p>}
        {nutriscore && /^[A-E]$/.test(nutriscore) && <span className="nutriscore-badge" aria-label={`Source Nutri-Score ${nutriscore}`}>Source Nutri-Score {nutriscore}</span>}
        {!!data?.concerns?.length && <div className="health-concerns" aria-label="Source flags used by the heuristic">{Array.from(new Set(data.concerns)).map((concern) => <span className="health-pill" key={concern}>{concern}</span>)}</div>}
        {!!data?.explanations?.length && <ul className="health-explanations">{data.explanations.map((explanation) => <li key={explanation}>{explanation}</li>)}</ul>}
        <details className="health-method"><summary>How the limited Clean Score works</summary><p>{data?.scoreMethod || scoreMethod}</p><p>Selected color codes: E102, E104, E110, E122, E123, E124, E127, E129, E131, E132, E133, E142, E151, E155, E180.</p><p>Selected preservative codes: E200, E202, E210 to E224, E226 to E228, E230 to E235, E239, E242, E249 to E252.</p><p>All required scoring inputs must be present. Other nutrient amounts may still be missing. No detected flags or a higher band does not mean a food is suitable for you.</p></details>
      </div>
      <p className="health-disclaimer">{disclaimer}</p>
      <LabelDataInput key={barcode} barcode={barcode} />
    </section>
  );
}
