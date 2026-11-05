'use strict';

/** Public source data only. A missing field is never an affirmative health claim. */
const OPEN_FOOD_FACTS_URL = 'https://world.openfoodfacts.org/api/v2/product';
const configuredTimeout = Number(process.env.HEALTH_TIMEOUT_MS || 5000);
const HEALTH_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5000;
const DISCLAIMER = 'Clean Score is a limited, non-validated, non-medical ingredient-data heuristic, not a nutrition or medical endorsement. It is not medical or allergy advice. Check the physical label for ingredients and allergens; source records can be incomplete or outdated.';
const SCORE_METHOD = 'Start at 10; subtract 1 per distinct E-number additive (maximum 4), 1 if any selected artificial color is present, 1 if any selected preservative is present, 1 if sugar exceeds 20 g per 100g, 1 if sodium exceeds 1 g per 100g, and 1 for Nutri-Score D or E. Minimum 1. Bands: 8 to 10 Clean, 5 to 7 OK, 1 to 4 Concerning. These are heuristic bands, not personal food-suitability advice.';

const ARTIFICIAL_COLORS = new Set([
  'e102', 'e104', 'e110', 'e122', 'e123', 'e124', 'e127', 'e129', 'e131', 'e132', 'e133', 'e142', 'e151', 'e155', 'e180',
]);
const ARTIFICIAL_PRESERVATIVES = new Set([
  'e200', 'e202', 'e210', 'e211', 'e212', 'e213', 'e214', 'e215', 'e216', 'e217', 'e218', 'e219', 'e220', 'e221', 'e222', 'e223',
  'e224', 'e226', 'e227', 'e228', 'e230', 'e231', 'e232', 'e233', 'e234', 'e235', 'e239', 'e242', 'e249', 'e250', 'e251', 'e252',
]);
const NUTRIENT_FIELDS = {
  energyKJ: ['energy-kj_100g', 'kJ'],
  energyKcal: ['energy-kcal_100g', 'kcal'],
  fat: ['fat_100g', 'g'],
  saturatedFat: ['saturated-fat_100g', 'g'],
  carbohydrate: ['carbohydrates_100g', 'g'],
  sugar: ['sugars_100g', 'g'],
  protein: ['proteins_100g', 'g'],
  fibre: ['fiber_100g', 'g'],
  salt: ['salt_100g', 'g'],
  sodium: ['sodium_100g', 'g'],
};
const healthCache = new Map();
const MAX_CACHE_ENTRIES = 300;
const SOURCE_CACHE_MS = 4 * 60 * 60 * 1000;
const MISS_CACHE_MS = 60 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;

function toFiniteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sourceStringTags(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()))]
    : [];
}

function sourceNutritionImage(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return ['https:', 'http:'].includes(new URL(value.trim()).protocol) ? value.trim() : null;
  } catch {
    return null;
  }
}

function ingredientSelection(product) {
  const fields = ['ingredients_text', 'ingredients_text_en'];
  const language = typeof product?.lang === 'string' ? product.lang : product?.lc;
  if (typeof language === 'string' && /^[a-z]{2,3}$/.test(language)) fields.push(`ingredients_text_${language}`);
  for (const field of [...new Set(fields)]) {
    if (typeof product?.[field] === 'string' && product[field].trim()) {
      return { text: product[field].trim(), field };
    }
  }
  const texts = Array.isArray(product?.ingredients)
    ? product.ingredients.map((ingredient) => ingredient?.text || ingredient?.id || '').filter((text) => typeof text === 'string' && text.trim()).map((text) => text.trim())
    : [];
  return { text: [...new Set(texts)].join(', ') || null, field: texts.length ? 'ingredients' : null };
}

function extractENumbers(product) {
  const found = new Set();
  // Search all supplied translations for factual tags, but display only one text.
  const sources = [ingredientSelection(product).text, product?.ingredients_text, product?.ingredients_text_en,
    ...(Array.isArray(product?.additives_tags) ? product.additives_tags : [])];
  for (const source of sources) {
    const matches = String(source || '').matchAll(/\be\s*[-–]?\s*(\d{3,4}[a-z]?)\b/gi);
    for (const match of matches) found.add(`e${match[1].toLowerCase()}`);
  }
  return [...found].sort();
}

function nutritionPer100g(product) {
  const nutriments = product?.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {};
  const nutrition = { basis: 'per100g' };
  for (const [name, [field, unit]] of Object.entries(NUTRIENT_FIELDS)) {
    const value = toFiniteNumber(nutriments[field]);
    nutrition[name] = { value, unit, calculated: false, sourceField: value === null ? null : field };
  }
  // OFF standardized *_100g mass values are grams, regardless of *_unit input.
  // Generic energy_100g is standardized kJ. Never substitute *_serving values.
  if (nutrition.energyKJ.value === null) {
    const value = toFiniteNumber(nutriments.energy_100g);
    if (value !== null) nutrition.energyKJ = { value, unit: 'kJ', calculated: false, sourceField: 'energy_100g' };
  }
  // This is the only conversion performed here and is always disclosed.
  // Do not reverse-convert salt to sodium for the original scoring rule.
  if (nutrition.salt.value === null && nutrition.sodium.value !== null) {
    nutrition.salt = {
      value: toFiniteNumber(nutrition.sodium.value * 2.5), unit: 'g', calculated: true,
      sourceField: 'sodium_100g', calculation: 'Calculated from sodium: sodium × 2.5',
    };
  }
  return nutrition;
}

function gradeForScore(score) {
  if (score >= 8) return { grade: 'Clean', color: 'green' };
  if (score >= 5) return { grade: 'OK', color: 'amber' };
  return { grade: 'Concerning', color: 'red' };
}

function concernTags(additives, sugar, sodium, nutriScore) {
  const tags = [];
  if (additives.length) tags.push(`${additives.length} additive${additives.length === 1 ? '' : 's'}`);
  if (additives.some((additive) => ARTIFICIAL_COLORS.has(additive))) tags.push('Artificial colors');
  if (additives.some((additive) => ARTIFICIAL_PRESERVATIVES.has(additive))) tags.push('Artificial preservatives');
  if (sugar !== null && sugar > 20) tags.push('High sugar');
  if (sodium !== null && sodium > 1) tags.push('High sodium');
  if (nutriScore === 'D' || nutriScore === 'E') tags.push(`Nutri-Score ${nutriScore}`);
  return tags;
}

function ruleExplanations(additives, sugar, sodium, nutriScore) {
  const explanations = [];
  if (additives.length) explanations.push(`${additives.length} distinct E-number additive${additives.length === 1 ? '' : 's'} identified in the source: ${additives.map((item) => item.toUpperCase()).join(', ')}. Additive deduction is capped at 4 points.`);
  const colors = additives.filter((item) => ARTIFICIAL_COLORS.has(item));
  if (colors.length) explanations.push(`Selected color code${colors.length === 1 ? '' : 's'}: ${colors.map((item) => item.toUpperCase()).join(', ')}. One additional point is deducted by this rule.`);
  const preservatives = additives.filter((item) => ARTIFICIAL_PRESERVATIVES.has(item));
  if (preservatives.length) explanations.push(`Selected preservative code${preservatives.length === 1 ? '' : 's'}: ${preservatives.map((item) => item.toUpperCase()).join(', ')}. One additional point is deducted by this rule.`);
  if (sugar !== null && sugar > 20) explanations.push(`Sugar is ${sugar} g per 100g, above this heuristic's 20 g threshold.`);
  if (sodium !== null && sodium > 1) explanations.push(`Sodium is ${sodium} g per 100g, above this heuristic's 1 g threshold. Sodium and salt are not the same measurement.`);
  if (nutriScore === 'D' || nutriScore === 'E') explanations.push(`The source reports Nutri-Score ${nutriScore}. This heuristic deducts one point for D or E.`);
  return explanations;
}

function sourceMetadata(barcode, sourceStatus, metadata = {}) {
  return {
    source: 'Open Food Facts', sourceUrl: `https://world.openfoodfacts.org/product/${encodeURIComponent(barcode)}`,
    sourceStatus, sourceReason: sourceStatus === 'available' ? null : sourceStatus,
    checkedAt: null, cachedAt: null, cacheStatus: 'live', stale: false, ...metadata,
  };
}

function noData(barcode, reason = 'The Open Food Facts record has no ingredient or nutrition fields.', sourceStatus = 'fields_missing', metadata = {}) {
  return {
    barcode, dataAvailable: false, scoreAvailable: false, cleanScore: null,
    concerns: [], knownConcerns: [], nutriscore: null, ingredientsText: null,
    ingredientsAvailable: false, ingredientsSourceField: null, nutritionAvailable: false,
    allergensTags: [], tracesTags: [], imageNutritionUrl: null,
    nutritionPer100g: nutritionPer100g(null), score: null, grade: null, gradeColor: null,
    tags: [], nutriScore: null, additives: [], explanations: [],
    dataCompleteness: 'none', missingData: ['ingredients', 'nutrition'],
    ...sourceMetadata(barcode, sourceStatus, metadata), disclaimer: DISCLAIMER, scoreMethod: SCORE_METHOD, message: reason,
  };
}

/** Pure scorer. Synthetic fixtures must not be treated as real lookup evidence. */
function scoreProductHealth(barcode, product, metadata = {}) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return noData(barcode, undefined, 'fields_missing', metadata);
  const ingredients = ingredientSelection(product);
  const additives = extractENumbers(product);
  const nutrition = nutritionPer100g(product);
  const sugar = nutrition.sugar.value;
  const sodium = nutrition.sodium.value;
  // Preserve only the fields actually supplied by OFF. Empty tags are unknown,
  // not evidence of allergen absence, and are not inputs to the Clean Score.
  const allergensTags = sourceStringTags(product.allergens_tags);
  const tracesTags = sourceStringTags(product.traces_tags);
  const imageNutritionUrl = sourceNutritionImage(product.image_nutrition_url);
  const rawNutriScore = String(product.nutrition_grades || product.nutriscore_grade || '').trim().toUpperCase();
  const nutriScore = /^[A-E]$/.test(rawNutriScore) ? rawNutriScore : null;
  const ingredientsAvailable = Boolean(ingredients.text);
  const nutritionAvailable = Object.keys(NUTRIENT_FIELDS).some((key) => nutrition[key].value !== null);
  if (!ingredientsAvailable && !nutritionAvailable && !nutriScore && !additives.length
    && !allergensTags.length && !tracesTags.length && !imageNutritionUrl) {
    return noData(barcode, undefined, 'fields_missing', metadata);
  }

  const missingData = [];
  if (!ingredientsAvailable) missingData.push('ingredients');
  if (sugar === null) missingData.push('sugar per 100g');
  if (sodium === null) missingData.push('sodium per 100g');
  if (!nutriScore) missingData.push('Nutri-Score');
  const tags = concernTags(additives, sugar, sodium, nutriScore);
  const base = {
    barcode, dataAvailable: true, ingredientsAvailable, ingredientsText: ingredients.text,
    ingredientsSourceField: ingredients.field, nutritionAvailable, nutritionPer100g: nutrition,
    allergensTags, tracesTags, imageNutritionUrl,
    concerns: tags, knownConcerns: tags, tags, additives, nutriscore: nutriScore, nutriScore,
    explanations: ruleExplanations(additives, sugar, sodium, nutriScore), missingData,
    missingNutrients: Object.keys(NUTRIENT_FIELDS).filter((key) => nutrition[key].value === null),
    ...sourceMetadata(barcode, missingData.length ? 'fields_missing' : 'available', metadata),
    sourceModifiedAt: Number.isFinite(product.last_modified_t) && Number.isFinite(new Date(product.last_modified_t * 1000).getTime())
      ? new Date(product.last_modified_t * 1000).toISOString() : null,
    disclaimer: missingData.length ? `${DISCLAIMER} Source data is partial; unavailable fields were not assumed safe.` : DISCLAIMER,
    scoreMethod: SCORE_METHOD,
  };
  if (missingData.length) {
    return {
      ...base, scoreAvailable: false, cleanScore: null, score: null, grade: null, gradeColor: null,
      dataCompleteness: 'partial',
      message: `Clean Score is unavailable because ${missingData.join(', ')} data is missing. Available fields are shown separately.`,
    };
  }

  // Preserve the original checklist arithmetic EXACTLY, including distinct E-numbers.
  let score = 10;
  score -= Math.min(additives.length, 4);
  if (additives.some((additive) => ARTIFICIAL_COLORS.has(additive))) score -= 1;
  if (additives.some((additive) => ARTIFICIAL_PRESERVATIVES.has(additive))) score -= 1;
  if (sugar > 20) score -= 1;
  if (sodium > 1) score -= 1;
  if (nutriScore === 'D' || nutriScore === 'E') score -= 1;
  score = Math.max(1, score);
  const classification = gradeForScore(score);
  return {
    ...base, scoreAvailable: true, cleanScore: score, score, grade: classification.grade,
    gradeColor: classification.color, dataCompleteness: 'complete',
  };
}

function cacheEntry(cache, barcode, data, now, ttl) {
  cache.delete(barcode);
  cache.set(barcode, { data, storedAt: now, expiresAt: now + ttl });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

async function getProductHealth(barcode, {
  fetchImpl = global.fetch, timeoutMs = HEALTH_TIMEOUT_MS, force = false,
  cache = healthCache, now = Date.now,
} = {}) {
  const currentTime = now();
  const checkedAt = new Date(currentTime).toISOString();
  const saved = cache.get(barcode);
  if (!force && saved && saved.expiresAt > currentTime) {
    return { ...saved.data, cacheStatus: 'cached', cachedAt: new Date(saved.storedAt).toISOString() };
  }
  let data;
  if (typeof fetchImpl !== 'function') {
    data = noData(barcode, 'Open Food Facts is temporarily unavailable. Try the health lookup again later.', 'temporarily_unavailable', { checkedAt });
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Fetch the full OFF record, including allergens_tags, traces_tags and
      // image_nutrition_url; do not restrict translated ingredient fields.
      const response = await fetchImpl(`${OPEN_FOOD_FACTS_URL}/${encodeURIComponent(barcode)}.json`, {
        headers: { Accept: 'application/json', 'User-Agent': 'TrolleyWise/1.0 (+https://github.com/drguzovich/pricecheck-backend)' },
        signal: controller.signal, cache: force ? 'no-store' : 'default',
      });
      if (response?.status === 404) {
        data = noData(barcode, 'This barcode was not found in Open Food Facts. Check the physical label or add your own label notes.', 'not_found', { checkedAt });
      } else if (!response?.ok) {
        data = noData(barcode, 'Open Food Facts is temporarily unavailable. Price comparison is separate.', 'temporarily_unavailable', { checkedAt });
      } else {
        const payload = await response.json();
        if (payload?.status === 0) {
          data = noData(barcode, 'This barcode was not found in Open Food Facts. Check the physical label or add your own label notes.', 'not_found', { checkedAt });
        } else if (payload?.status !== 1 || !payload.product || typeof payload.product !== 'object' || Array.isArray(payload.product)) {
          data = noData(barcode, 'Open Food Facts returned an unreadable response. Try the health lookup again.', 'temporarily_unavailable', { checkedAt });
        } else {
          data = scoreProductHealth(barcode, payload.product, { checkedAt });
        }
      }
    } catch (error) {
      data = noData(barcode, error?.name === 'AbortError'
        ? 'Open Food Facts lookup timed out. Try the health lookup again.'
        : 'Open Food Facts is temporarily unavailable. Try the health lookup again.', 'temporarily_unavailable', { checkedAt });
    } finally {
      clearTimeout(timer);
    }
  }
  // Keep useful previous source facts, but never pretend an outage was a fresh check.
  if (data.sourceStatus === 'temporarily_unavailable' && saved?.data.dataAvailable) {
    const staleData = {
      ...saved.data, sourceStatus: 'temporarily_unavailable', sourceReason: 'temporarily_unavailable',
      cacheStatus: 'cached', stale: true, cachedAt: new Date(saved.storedAt).toISOString(),
      latestAttemptAt: checkedAt, message: 'Open Food Facts could not be reached. Showing previously checked source information, which may be outdated.',
    };
    // A following normal request must not hide the failed refresh operation.
    cache.set(barcode, { data: staleData, storedAt: saved.storedAt, expiresAt: currentTime + FAILURE_CACHE_MS });
    return staleData;
  }
  const ttl = data.sourceStatus === 'temporarily_unavailable' ? FAILURE_CACHE_MS
    : data.sourceStatus === 'not_found' || !data.dataAvailable ? MISS_CACHE_MS : SOURCE_CACHE_MS;
  cacheEntry(cache, barcode, data, currentTime, ttl);
  return data;
}

module.exports = {
  ARTIFICIAL_COLORS, ARTIFICIAL_PRESERVATIVES, DISCLAIMER, SCORE_METHOD,
  NUTRIENT_FIELDS, extractENumbers, getProductHealth, noData, nutritionPer100g, scoreProductHealth,
};
