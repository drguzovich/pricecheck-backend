'use strict';

/**
 * Product Health is a transparent, non-medical heuristic based only on public
 * Open Food Facts product fields. It is deliberately conservative: a missing
 * product never receives a score, and incomplete source fields are disclosed.
 */
const OPEN_FOOD_FACTS_URL = 'https://world.openfoodfacts.org/api/v2/product';
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 5000);
const DISCLAIMER = 'This non-medical ingredient-data heuristic is not medical or allergy advice.';

const ARTIFICIAL_COLORS = new Set([
  'e102', 'e104', 'e110', 'e122', 'e123', 'e124', 'e127', 'e129', 'e131', 'e132', 'e133', 'e142', 'e151', 'e155', 'e180',
]);
const ARTIFICIAL_PRESERVATIVES = new Set([
  'e200', 'e202', 'e210', 'e211', 'e212', 'e213', 'e214', 'e215', 'e216', 'e217', 'e218', 'e219', 'e220', 'e221', 'e222', 'e223',
  'e224', 'e226', 'e227', 'e228', 'e230', 'e231', 'e232', 'e233', 'e234', 'e235', 'e239', 'e242', 'e249', 'e250', 'e251', 'e252',
]);

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseENumber(value) {
  const match = String(value || '').toLowerCase().match(/\be\s*[-–]?\s*(\d{3,4}[a-z]?)\b/i);
  return match ? `e${match[1].toLowerCase()}` : null;
}

function ingredientSourceText(product) {
  const texts = [product?.ingredients_text, product?.ingredients_text_en];
  if (Array.isArray(product?.ingredients)) {
    texts.push(...product.ingredients.map((ingredient) => ingredient?.text || ingredient?.id || ''));
  }
  return texts.filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function extractENumbers(product) {
  const found = new Set();
  const sources = [ingredientSourceText(product), ...(Array.isArray(product?.additives_tags) ? product.additives_tags : [])];
  for (const source of sources) {
    const matches = String(source || '').matchAll(/\be\s*[-–]?\s*(\d{3,4}[a-z]?)\b/gi);
    for (const match of matches) found.add(`e${match[1].toLowerCase()}`);
  }
  return [...found].sort();
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

function noData(barcode, reason = 'No Open Food Facts ingredient or nutrition data is available for this product.') {
  return {
    barcode,
    dataAvailable: false,
    scoreAvailable: false,
    cleanScore: null,
    concerns: [],
    knownConcerns: [],
    nutriscore: null,
    ingredientsText: null,
    score: null,
    grade: null,
    gradeColor: null,
    tags: [],
    nutriScore: null,
    dataCompleteness: 'none',
    missingData: ['ingredients', 'nutrition'],
    source: 'Open Food Facts',
    disclaimer: DISCLAIMER,
    message: reason,
  };
}

/**
 * Score a raw Open Food Facts product object. A source product can be partial;
 * callers receive a partial-data disclosure rather than an implied clean bill
 * of health. No diagnosis or allergy suitability is inferred.
 */
function scoreProductHealth(barcode, product) {
  if (!product || typeof product !== 'object') return noData(barcode);

  const ingredientText = ingredientSourceText(product);
  const additives = extractENumbers(product);
  const nutriments = product.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {};
  const sugar = toFiniteNumber(nutriments.sugars_100g);
  const sodium = toFiniteNumber(nutriments.sodium_100g);
  const nutriScore = String(product.nutrition_grades || product.nutriscore_grade || '').trim().toUpperCase();
  const validNutriScore = /^[A-E]$/.test(nutriScore) ? nutriScore : null;
  const hasIngredients = Boolean(ingredientText);
  const hasNutrition = sugar !== null || sodium !== null || validNutriScore !== null;

  // Products such as OFF status=1 records containing only a name/image should
  // not be represented as scored health data.
  if (!hasIngredients && !hasNutrition) return noData(barcode);

  const missingData = [];
  if (!hasIngredients) missingData.push('ingredients');
  if (sugar === null) missingData.push('sugar per 100g');
  if (sodium === null) missingData.push('sodium per 100g');
  if (!validNutriScore) missingData.push('Nutri-Score');
  const tags = concernTags(additives, sugar, sodium, validNutriScore);
  const ingredientsText = typeof product.ingredients_text === 'string' ? product.ingredients_text : ingredientText || null;

  // A score is meaningful only when every field used by the scoring rules is
  // present. Expose source data and known concerns without treating omitted
  // ingredients, sugar, sodium, or Nutri-Score as safe.
  if (missingData.length) {
    return {
      barcode,
      dataAvailable: true,
      scoreAvailable: false,
      cleanScore: null,
      concerns: tags,
      knownConcerns: tags,
      nutriscore: validNutriScore,
      ingredientsText,
      score: null,
      grade: null,
      gradeColor: null,
      tags,
      nutriScore: validNutriScore,
      additives,
      dataCompleteness: 'partial',
      missingData,
      source: 'Open Food Facts',
      disclaimer: `${DISCLAIMER} Source data is partial; unavailable fields were not assumed safe.`,
      message: `Health score is unavailable because ${missingData.join(', ')} data is missing. Available source data is shown without assuming missing fields are safe.`,
    };
  }

  let score = 10;
  const additivePenalty = Math.min(additives.length, 4);
  if (additivePenalty) {
    score -= additivePenalty;
  }
  if (additives.some((additive) => ARTIFICIAL_COLORS.has(additive))) score -= 1;
  if (additives.some((additive) => ARTIFICIAL_PRESERVATIVES.has(additive))) score -= 1;
  if (sugar !== null && sugar > 20) score -= 1;
  if (sodium !== null && sodium > 1) score -= 1;
  if (validNutriScore === 'D' || validNutriScore === 'E') score -= 1;
  score = Math.max(1, score);

  const classification = gradeForScore(score);

  return {
    barcode,
    dataAvailable: true,
    scoreAvailable: true,
    cleanScore: score,
    concerns: tags,
    knownConcerns: tags,
    nutriscore: validNutriScore,
    ingredientsText,
    score,
    grade: classification.grade,
    gradeColor: classification.color,
    tags,
    nutriScore: validNutriScore,
    additives,
    dataCompleteness: missingData.length ? 'partial' : 'complete',
    missingData,
    source: 'Open Food Facts',
    disclaimer: missingData.length
      ? `${DISCLAIMER} Source data is partial; unavailable fields were not assumed safe.`
      : DISCLAIMER,
  };
}

async function getProductHealth(barcode, { fetchImpl = global.fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return noData(barcode, 'Open Food Facts lookup is unavailable.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${OPEN_FOOD_FACTS_URL}/${encodeURIComponent(barcode)}.json`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PriceCheck/1.0 (+https://github.com/drguzovich/pricecheck-backend)',
      },
      signal: controller.signal,
    });
    if (!response?.ok) return noData(barcode);
    const payload = await response.json();
    if (payload?.status !== 1 || !payload?.product) return noData(barcode);
    return scoreProductHealth(barcode, payload.product);
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? 'Open Food Facts lookup timed out; no health score is available.'
      : 'Open Food Facts lookup failed; no health score is available.';
    return noData(barcode, reason);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ARTIFICIAL_COLORS,
  ARTIFICIAL_PRESERVATIVES,
  DISCLAIMER,
  extractENumbers,
  getProductHealth,
  noData,
  scoreProductHealth,
};
