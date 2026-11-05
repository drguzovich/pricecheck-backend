export const NUTRIENT_ROWS = [
  ["energyKJ", "Energy", "kJ"],
  ["energyKcal", "Energy", "kcal"],
  ["fat", "Fat", "g"],
  ["saturatedFat", "Saturated fat", "g"],
  ["carbohydrate", "Carbohydrate", "g"],
  ["sugar", "Sugar", "g"],
  ["protein", "Protein", "g"],
  ["fibre", "Fibre", "g"],
  ["salt", "Salt", "g"],
  ["sodium", "Sodium", "g"],
] as const;

type NutrientKey = typeof NUTRIENT_ROWS[number][0];
type NutrientValue = { value: number | null; unit: string; calculated?: boolean; calculation?: string; sourceField?: string | null };
export type Nutrition = { basis: "per100g" } & Record<NutrientKey, NutrientValue>;
type SourceStatus = "available" | "fields_missing" | "not_found" | "temporarily_unavailable";
export type ProductHealthData = {
  barcode: string;
  cleanScore?: number | null;
  grade?: string | null;
  scoreAvailable?: boolean;
  concerns?: string[];
  nutriscore?: string | null;
  ingredientsText?: string | null;
  ingredientsAvailable?: boolean;
  nutritionAvailable?: boolean;
  nutritionPer100g?: Nutrition;
  // Source-reported tags only. An empty/missing list never means allergen-free.
  allergensTags?: string[];
  tracesTags?: string[];
  imageNutritionUrl?: string | null;
  dataAvailable: boolean;
  missingData?: string[];
  sourceStatus?: SourceStatus;
  source?: string;
  checkedAt?: string | null;
  cachedAt?: string | null;
  latestAttemptAt?: string | null;
  sourceModifiedAt?: string | null;
  cacheStatus?: "live" | "cached";
  stale?: boolean;
  explanations?: string[];
  scoreMethod?: string;
  message?: string;
};

export function isSourceImageUrl(value: string): boolean {
  try { return ["https:", "http:"].includes(new URL(value).protocol); }
  catch { return false; }
}

export function isHealthData(value: unknown): value is ProductHealthData {
  if (!value || typeof value !== "object") return false;
  const data = value as ProductHealthData;
  if (typeof data.barcode !== "string" || typeof data.dataAvailable !== "boolean") return false;
  for (const flag of [data.scoreAvailable, data.ingredientsAvailable, data.nutritionAvailable, data.stale]) {
    if (flag !== undefined && typeof flag !== "boolean") return false;
  }
  if (data.cleanScore !== undefined && data.cleanScore !== null && (typeof data.cleanScore !== "number" || !Number.isFinite(data.cleanScore))) return false;
  for (const text of [data.grade, data.ingredientsText, data.nutriscore, data.source, data.checkedAt, data.cachedAt, data.latestAttemptAt, data.sourceModifiedAt, data.scoreMethod, data.message, data.imageNutritionUrl]) {
    if (text !== undefined && text !== null && typeof text !== "string") return false;
  }
  if (data.imageNutritionUrl && !isSourceImageUrl(data.imageNutritionUrl)) return false;
  for (const list of [data.concerns, data.missingData, data.explanations, data.allergensTags, data.tracesTags]) {
    if (list !== undefined && (!Array.isArray(list) || list.some((entry) => typeof entry !== "string"))) return false;
  }
  if (data.sourceStatus !== undefined && !["available", "fields_missing", "not_found", "temporarily_unavailable"].includes(data.sourceStatus)) return false;
  if (data.nutritionPer100g !== undefined) {
    if (!data.nutritionPer100g || data.nutritionPer100g.basis !== "per100g") return false;
    for (const [key, , unit] of NUTRIENT_ROWS) {
      const nutrient = data.nutritionPer100g[key];
      if (!nutrient || nutrient.unit !== unit) return false;
      if (nutrient.value !== null && (typeof nutrient.value !== "number" || !Number.isFinite(nutrient.value) || nutrient.value < 0)) return false;
      if (nutrient.calculated !== undefined && typeof nutrient.calculated !== "boolean") return false;
      if (nutrient.calculation !== undefined && typeof nutrient.calculation !== "string") return false;
    }
  }
  return true;
}
