'use strict';

// All products, barcodes, timestamps and transport responses below are explicit
// SYNTHETIC fixtures. Passing these tests is not real product-source verification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  ARTIFICIAL_COLORS, ARTIFICIAL_PRESERVATIVES, NUTRIENT_FIELDS,
  getProductHealth, noData, nutritionPer100g, scoreProductHealth,
} = require('../src/productHealth');
const BARCODE = '0000000000000';
const complete = (overrides = {}) => ({
  ingredients_text: 'Synthetic fixture: water, sugar',
  nutriments: { sugars_100g: 0, sodium_100g: 0 },
  nutrition_grades: 'a', ...overrides,
});
const score = (product) => scoreProductHealth(BARCODE, product);
const tests = [];
function test(name, run) { tests.push({ name, run }); }
function fakeResponse(product, status = 1) { return { ok: true, status: 200, json: async () => ({ status, product }) }; }

const frontendRoot = path.resolve(__dirname, '../../pricecheck');
const HEALTH_URL = `https://synthetic.invalid/api/backend/product/${BARCODE}/health`;
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Synthetic-Test': 'only' } });
}
function workerFixture() {
  const handlers = {};
  const stores = new Map();
  const keyFor = (request) => typeof request === 'string' ? new URL(request, HEALTH_URL).href : request.url;
  let fetchImpl = async () => { throw new Error('Synthetic offline'); };
  const cacheStorage = {
    async open(name) {
      if (!stores.has(name)) {
        const entries = new Map();
        stores.set(name, {
          puts: 0,
          async match(request) { return entries.get(keyFor(request))?.clone(); },
          async put(request, response) { this.puts++; entries.set(keyFor(request), response.clone()); },
          async keys() { return [...entries.keys()].map((url) => new Request(url)); },
        });
      }
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const cache of stores.values()) { const response = await cache.match(request); if (response) return response; }
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(frontendRoot, 'public/sw.js'), 'utf8'), {
    self: { location: { origin: 'https://synthetic.invalid' }, addEventListener: (name, handler) => { handlers[name] = handler; }, clients: { claim: async () => {} } },
    caches: cacheStorage, URL, Headers, Response, Request, fetch: (...args) => fetchImpl(...args),
  }, { filename: 'actual-trolleywise-sw.js' });
  return {
    caches: cacheStorage,
    network(implementation) { fetchImpl = implementation; },
    async request(url = HEALTH_URL) {
      let response;
      handlers.fetch({ request: new Request(url), respondWith: (pending) => { response = pending; } });
      return response ? await response : null;
    },
    async activate() { let pending; handlers.activate({ waitUntil: (work) => { pending = work; } }); await pending; },
  };
}

function frontendHealthFixture(data) {
  const resolveFrontend = (name) => require(require.resolve(name, { paths: [frontendRoot] }));
  const ts = resolveFrontend('typescript');
  const React = resolveFrontend('react');
  const contract = { exports: {} };
  const compile = (file) => ts.transpileModule(fs.readFileSync(path.join(frontendRoot, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(compile('src/lib/product-health.ts'), { exports: contract.exports, URL }, { filename: 'actual-health-contract.js' });
  const component = { exports: {} };
  const fixtureRequire = (name) => {
    if (name === 'react') return { ...React, useEffect: () => {}, useState: (initial) => [initial?.status ? { status: 'ready', data } : initial, () => {}] };
    if (name === '@/lib/product-health') return contract.exports;
    if (name === '@/components/skeleton') return { HealthSkeleton: () => null };
    if (name === '@/components/label-data-input') return { LabelDataInput: () => null };
    if (name.endsWith('.css')) return {};
    return resolveFrontend(name);
  };
  vm.runInNewContext(compile('src/components/product-health.tsx'), { exports: component.exports, require: fixtureRequire }, { filename: 'actual-health-component.js' });
  const { renderToStaticMarkup } = resolveFrontend('react-dom/server');
  return { ...contract.exports, render: () => renderToStaticMarkup(React.createElement(component.exports.ProductHealth, { barcode: BARCODE })) };
}

test('original arithmetic, additive cap, extra color/preservative deductions and floor', () => {
  const result = score(complete({ ingredients_text: 'Synthetic: E102, E211, E330', nutriments: { sugars_100g: 25, sodium_100g: 1.2 }, nutrition_grades: 'e' }));
  assert.equal(result.cleanScore, 2);
  assert.equal(result.score, 2);
  assert.equal(result.grade, 'Concerning');
  assert.deepEqual(result.tags, ['3 additives', 'Artificial colors', 'Artificial preservatives', 'High sugar', 'High sodium', 'Nutri-Score E']);
  const floored = score(complete({ ingredients_text: 'Synthetic: E102, E110, E211, E220, E330, E500, E621', nutriments: { sugars_100g: 25, sodium_100g: 2 }, nutrition_grades: 'd' }));
  assert.equal(floored.cleanScore, 1);
  const capped = score(complete({ ingredients_text: 'Synthetic: E300 E301 E302 E303 E304 E306 E307' }));
  assert.equal(capped.cleanScore, 6);
  const twoColors = score(complete({ ingredients_text: 'Synthetic: E102 E110' }));
  assert.equal(twoColors.cleanScore, 7); // 10 - 2 additive - 1 color
  const twoPreservatives = score(complete({ ingredients_text: 'Synthetic: E211 E220' }));
  assert.equal(twoPreservatives.cleanScore, 7);
});

test('strict sugar/sodium thresholds and exact Clean/OK/Concerning bands', () => {
  assert.equal(score(complete({ nutriments: { sugars_100g: 20, sodium_100g: 1 } })).cleanScore, 10);
  const highFlagsClean = score(complete({ nutriments: { sugars_100g: 20.01, sodium_100g: 1.001 } }));
  assert.equal(highFlagsClean.cleanScore, 8);
  assert.equal(highFlagsClean.grade, 'Clean');
  assert.deepEqual(highFlagsClean.tags, ['High sugar', 'High sodium']);
  assert.match(highFlagsClean.disclaimer, /non-validated/);
  assert.match(highFlagsClean.disclaimer, /not a nutrition or medical endorsement/);
  assert.match(highFlagsClean.disclaimer, /physical label/);
  assert.equal(score(complete({ ingredients_text: 'Synthetic: E300 E301 E302' })).grade, 'OK'); // 7
  assert.equal(score(complete({ ingredients_text: 'Synthetic: E300 E301 E302 E303', nutrition_grades: 'd' })).grade, 'OK'); // 5
  assert.equal(score(complete({ ingredients_text: 'Synthetic: E300 E301 E302 E303', nutrition_grades: 'e', nutriments: { sugars_100g: 21, sodium_100g: 0 } })).grade, 'Concerning'); // 4
  assert.equal(score(complete({ nutrition_grades: 'b' })).cleanScore, 10);
  assert.equal(score(complete({ nutrition_grades: 'c' })).cleanScore, 10);
});

test('distinct E-number extraction and full original selected code sets', () => {
  const result = score(complete({ ingredients_text: 'Synthetic: E 102, E-102, E211, E330', ingredients_text_en: 'Synthetic translation: E102, E211, E330', additives_tags: ['en:e102', 'en:e330'] }));
  assert.deepEqual(result.additives, ['e102', 'e211', 'e330']);
  assert.equal(result.cleanScore, 5);
  for (const code of ARTIFICIAL_COLORS) assert.equal(score(complete({ ingredients_text: `Synthetic: ${code}` })).cleanScore, 8, code);
  for (const code of ARTIFICIAL_PRESERVATIVES) assert.equal(score(complete({ ingredients_text: `Synthetic: ${code}` })).cleanScore, 8, code);
});

test('empty default ingredients fall back to English without duplicate translations', () => {
  const english = score(complete({ ingredients_text: '  ', ingredients_text_en: 'Synthetic English: water, E330' }));
  assert.equal(english.ingredientsText, 'Synthetic English: water, E330');
  assert.equal(english.ingredientsSourceField, 'ingredients_text_en');
  const defaultText = score(complete({ ingredients_text: 'Synthetic default: water', ingredients_text_en: 'Synthetic English: water' }));
  assert.equal(defaultText.ingredientsText, 'Synthetic default: water');
  const language = score(complete({ ingredients_text: '', lang: 'fr', ingredients_text_fr: 'Synthetic French: eau' }));
  assert.equal(language.ingredientsText, 'Synthetic French: eau');
  const structured = score(complete({ ingredients_text: '', ingredients: [{ text: 'Synthetic water' }, { text: 'Synthetic water' }, { text: 'Synthetic sugar' }] }));
  assert.equal(structured.ingredientsText, 'Synthetic water, Synthetic sugar');
});

test('all requested nutrient amounts use normalized per100g units and real zero', () => {
  const nutrition = nutritionPer100g({ nutriments: {
    'energy-kj_100g': 1200, 'energy-kcal_100g': 287,
    fat_100g: 5, 'saturated-fat_100g': 1.5, carbohydrates_100g: 40,
    sugars_100g: '12,5', proteins_100g: 8, fiber_100g: 2,
    salt_100g: 0.5, sodium_100g: 0.2, sodium_unit: 'mg',
  } });
  assert.equal(nutrition.basis, 'per100g');
  for (const [key, [, unit]] of Object.entries(NUTRIENT_FIELDS)) {
    assert.equal(nutrition[key].unit, unit);
    assert.equal(nutrition[key].calculated, false);
    assert.notEqual(nutrition[key].value, null);
  }
  assert.equal(nutrition.sugar.value, 12.5);
  assert.equal(nutrition.sodium.value, 0.2); // not rescaled by input sodium_unit
  assert.equal(score(complete()).nutritionPer100g.sugar.value, 0);
  assert.equal(score(complete()).nutritionPer100g.protein.value, null);
  assert.equal(nutritionPer100g({ nutriments: { energy_100g: 400 } }).energyKJ.sourceField, 'energy_100g');
  assert.equal(nutritionPer100g({ nutriments: { energy_100g: 400 } }).energyKcal.value, null);
});

test('unknown, whitespace, boolean, negative, nonnumeric and serving-only values are not zero', () => {
  for (const value of [null, undefined, '', ' ', 'unknown', false, true, {}, [], NaN, Infinity, -1]) {
    const result = score(complete({ nutriments: { sugars_100g: value, sodium_100g: 0 } }));
    assert.equal(result.nutritionPer100g.sugar.value, null, String(value));
    assert.equal(result.cleanScore, null);
  }
  const serving = score({ nutriments: { fat_serving: 3, sugars_value: 2, sodium: 0.2 } });
  assert.equal(serving.dataAvailable, false);
  assert.equal(serving.nutritionPer100g.fat.value, null);
});

test('sodium-to-salt conversion is explicit, does not replace supplied salt or reverse-convert sodium', () => {
  const calculated = score(complete({ nutriments: { sugars_100g: 0, sodium_100g: 0.2 } }));
  assert.equal(calculated.nutritionPer100g.salt.value, 0.5);
  assert.equal(calculated.nutritionPer100g.salt.calculated, true);
  assert.match(calculated.nutritionPer100g.salt.calculation, /Calculated from sodium/);
  const supplied = score(complete({ nutriments: { sugars_100g: 0, sodium_100g: 0.2, salt_100g: 0.7 } }));
  assert.equal(supplied.nutritionPer100g.salt.value, 0.7);
  assert.equal(supplied.nutritionPer100g.salt.calculated, false);
  const saltOnly = score(complete({ nutriments: { sugars_100g: 0, salt_100g: 2.5 } }));
  assert.equal(saltOnly.nutritionPer100g.sodium.value, null);
  assert.equal(saltOnly.cleanScore, null);
});

test('partial nutrition, ingredients, Nutri-Score and additive tags are independent of scoring', () => {
  const fatOnly = score({ nutriments: { fat_100g: 7 } });
  assert.equal(fatOnly.dataAvailable, true);
  assert.equal(fatOnly.nutritionAvailable, true);
  assert.equal(fatOnly.ingredientsAvailable, false);
  assert.equal(fatOnly.nutritionPer100g.fat.value, 7);
  assert.equal(fatOnly.cleanScore, null);
  assert.equal(fatOnly.sourceStatus, 'fields_missing');
  const ingredientsOnly = score({ ingredients_text: 'Synthetic: water, E211' });
  assert.equal(ingredientsOnly.ingredientsAvailable, true);
  assert.equal(ingredientsOnly.nutritionAvailable, false);
  assert.deepEqual(ingredientsOnly.missingData, ['sugar per 100g', 'sodium per 100g', 'Nutri-Score']);
  assert.deepEqual(ingredientsOnly.tags, ['1 additive', 'Artificial preservatives']);
  const tagsOnly = score({ additives_tags: ['en:e102'] });
  assert.equal(tagsOnly.dataAvailable, true);
  assert.equal(tagsOnly.cleanScore, null);
  assert.deepEqual(tagsOnly.tags, ['1 additive', 'Artificial colors']);
  const nutriOnly = score({ nutrition_grades: 'e' });
  assert.equal(nutriOnly.dataAvailable, true);
  assert.equal(nutriOnly.nutritionAvailable, false);
  assert.equal(nutriOnly.nutriscore, 'E');
  assert.equal(nutriOnly.cleanScore, null);
  assert.equal(score({ product_name: 'Synthetic name-only record' }).dataAvailable, false);
});

test('allergen and trace tags preserve only actual strings and never infer absence or change score', () => {
  const result = score(complete({
    allergens_tags: [' en:milk ', 'en:milk', 'en:eggs', '', ' ', null, 0, true, { id: 'en:peanuts' }, ['en:soybeans']],
    traces_tags: ['en:peanuts', ' en:sesame-seeds ', 'en:peanuts', false],
    image_nutrition_url: ' https://images.synthetic.invalid/nutrition.jpg ',
  }));
  assert.deepEqual(result.allergensTags, ['en:milk', 'en:eggs']);
  assert.deepEqual(result.tracesTags, ['en:peanuts', 'en:sesame-seeds']);
  assert.equal(result.imageNutritionUrl, 'https://images.synthetic.invalid/nutrition.jpg');
  assert.equal(result.cleanScore, score(complete()).cleanScore);
  assert.deepEqual(result.concerns, []); // no allergy-safety score/endorsement
  assert.match(result.disclaimer, /not medical or allergy advice/);
  const absent = score(complete({ ingredients_text: 'Synthetic: milk, peanuts', allergens_tags: [], traces_tags: [] }));
  assert.deepEqual(absent.allergensTags, []); // not inferred from ingredient words
  assert.deepEqual(absent.tracesTags, []);
  assert.equal(absent.imageNutritionUrl, null);
  for (const value of ['en:milk', false, 0, {}, null]) {
    const invalid = score({ allergens_tags: value, traces_tags: value, image_nutrition_url: value });
    assert.deepEqual(invalid.allergensTags, []);
    assert.deepEqual(invalid.tracesTags, []);
    assert.equal(invalid.imageNutritionUrl, null);
    assert.equal(invalid.dataAvailable, false);
  }
  for (const image of ['javascript:alert(1)', 'data:image/png,test', '/relative.jpg', 'not a URL']) {
    assert.equal(score({ image_nutrition_url: image }).imageNutritionUrl, null);
  }
});

test('allergen/trace/image-only source facts remain partial, with missing nutrition null, not zero', () => {
  for (const fields of [{ allergens_tags: ['en:milk'] }, { traces_tags: ['en:peanuts'] }, { image_nutrition_url: 'https://images.synthetic.invalid/label.jpg' }]) {
    const result = score(fields);
    assert.equal(result.dataAvailable, true);
    assert.equal(result.ingredientsAvailable, false);
    assert.equal(result.nutritionAvailable, false);
    assert.equal(result.sourceStatus, 'fields_missing');
    assert.equal(result.dataCompleteness, 'partial');
    assert.equal(result.scoreAvailable, false);
    assert.equal(result.cleanScore, null);
    assert.deepEqual(result.missingData, ['ingredients', 'sugar per 100g', 'sodium per 100g', 'Nutri-Score']);
    for (const key of Object.keys(NUTRIENT_FIELDS)) assert.equal(result.nutritionPer100g[key].value, null);
  }
  const empty = noData(BARCODE);
  assert.deepEqual(empty.allergensTags, []);
  assert.deepEqual(empty.tracesTags, []);
  assert.equal(empty.imageNutritionUrl, null);
});

test('actual lookup projects supplied OFF allergen, trace and nutrition-image fields with source times', async () => {
  const result = await getProductHealth(BARCODE, {
    cache: new Map(), force: true, now: () => Date.parse('2026-01-01T00:00:00Z'),
    fetchImpl: async (url, options) => {
      assert.equal(url, `https://world.openfoodfacts.org/api/v2/product/${BARCODE}.json`);
      assert.equal(options.cache, 'no-store');
      return fakeResponse({ allergens_tags: ['en:milk'], traces_tags: ['en:eggs'], image_nutrition_url: 'https://images.synthetic.invalid/nutrition.jpg', last_modified_t: 0 });
    },
  });
  assert.deepEqual(result.allergensTags, ['en:milk']);
  assert.deepEqual(result.tracesTags, ['en:eggs']);
  assert.equal(result.imageNutritionUrl, 'https://images.synthetic.invalid/nutrition.jpg');
  assert.equal(result.source, 'Open Food Facts');
  assert.equal(result.checkedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(result.sourceModifiedAt, '1970-01-01T00:00:00.000Z');
});

test('actual frontend validator and UI show attributed source tags without an allergen-free claim', () => {
  const data = scoreProductHealth(BARCODE, { allergens_tags: ['en:milk'], traces_tags: ['en:peanuts'], image_nutrition_url: 'https://images.synthetic.invalid/nutrition.jpg' }, { checkedAt: '2026-01-01T00:00:00.000Z' });
  const frontend = frontendHealthFixture(data);
  assert.equal(frontend.isHealthData(data), true);
  const html = frontend.render();
  assert.match(html, /Allergens reported by Open Food Facts: en:milk/);
  assert.match(html, /Trace caution reported by Open Food Facts: en:peanuts/);
  assert.match(html, /not verified allergy-safety advice/);
  assert.match(html, /Source data may be incomplete or outdated/);
  assert.match(html, /Check the physical label/);
  assert.match(html, /https:\/\/images\.synthetic\.invalid\/nutrition\.jpg/);
  assert.match(html, /Source checked/);
  assert.match(html, /2026-01-01T00:00:00\.000Z/);
  assert.match(html, /Clean Score unavailable/);
  assert.match(html, /Missing values are not zero/);
  assert.match(html, /Not reported/);
  const absentHtml = frontendHealthFixture(noData(BARCODE)).render();
  assert.match(absentHtml, /This does not mean there are no allergens/);
  assert.match(absentHtml, /Absence of a tag does not rule out traces or cross-contact/);
  assert.doesNotMatch(absentHtml, /Allergens reported by Open Food Facts:/);
  assert.doesNotMatch(absentHtml, /allergen-free|No allergens reported|No traces reported/i);
  for (const field of ['allergensTags', 'tracesTags']) {
    for (const value of ['en:milk', [false], [null], [{}], [1]]) assert.equal(frontend.isHealthData({ ...data, [field]: value }), false);
  }
  assert.equal(frontend.isHealthData({ ...data, imageNutritionUrl: 'javascript:alert(1)' }), false);
  assert.equal(frontend.isHealthData({ barcode: BARCODE, dataAvailable: false }), true); // compatible older cache
});

test('pure scorer does not invent a source-check timestamp', () => {
  assert.equal(score(complete()).checkedAt, null);
  const missing = noData(BARCODE);
  assert.equal(missing.checkedAt, null);
  assert.equal(missing.score, null);
  assert.equal(missing.sourceStatus, 'fields_missing');
});

test('lookup differentiates product not found, missing fields and temporary source failures', async () => {
  const cache = new Map();
  const lookup = (fetchImpl) => getProductHealth(BARCODE, { fetchImpl, cache, force: true });
  assert.equal((await lookup(async () => fakeResponse(null, 0))).sourceStatus, 'not_found');
  assert.equal((await lookup(async () => ({ ok: false, status: 404 }))).sourceStatus, 'not_found');
  assert.equal((await lookup(async () => fakeResponse({ product_name: 'Synthetic incomplete record' }))).sourceStatus, 'fields_missing');
  for (const fetchImpl of [
    async () => ({ ok: false, status: 429 }), async () => ({ ok: false, status: 503 }),
    async () => { throw new Error('Synthetic network failure'); },
    async () => ({ ok: true, json: async () => { throw new Error('Synthetic invalid JSON'); } }),
    async () => ({ ok: true, json: async () => ({ status: 7 }) }),
  ]) {
    const result = await lookup(fetchImpl);
    assert.equal(result.sourceStatus, 'temporarily_unavailable');
    assert.equal(result.dataAvailable, false);
    assert.equal(result.cleanScore, null);
  }
  const noFetch = await getProductHealth(BARCODE, { fetchImpl: null, cache: new Map() });
  assert.equal(noFetch.sourceStatus, 'temporarily_unavailable');
});

test('timeout abort is contained and marked temporarily unavailable', async () => {
  const result = await getProductHealth(BARCODE, {
    cache: new Map(), timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Synthetic timeout'), { name: 'AbortError' })), { once: true });
    }),
  });
  assert.equal(result.sourceStatus, 'temporarily_unavailable');
  assert.match(result.message, /timed out/);
});

test('cache preserves checked time, distinguishes cached misses and force bypasses cache', async () => {
  const cache = new Map();
  let calls = 0;
  let clock = Date.parse('2026-01-01T00:00:00Z'); // synthetic clock, not live evidence
  const fetchImpl = async (_url, options) => { calls++; assert.match(options.headers['User-Agent'], /^TrolleyWise/); return fakeResponse(null, 0); };
  const first = await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl });
  assert.equal(first.cacheStatus, 'live');
  assert.equal(first.checkedAt, '2026-01-01T00:00:00.000Z');
  clock += 1000;
  const second = await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl });
  assert.equal(second.cacheStatus, 'cached');
  assert.equal(second.sourceStatus, 'not_found');
  assert.equal(second.checkedAt, first.checkedAt);
  assert.equal(second.cachedAt, first.checkedAt);
  assert.equal(calls, 1);
  const third = await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl, force: true });
  assert.equal(third.cacheStatus, 'live');
  assert.notEqual(third.checkedAt, first.checkedAt);
  assert.equal(calls, 2);
});

test('failed refresh keeps previous factual nutrition but marks stale and attempted time separately', async () => {
  const cache = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const first = await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl: async () => fakeResponse(complete({ nutriments: { sugars_100g: 3, sodium_100g: 0.1, proteins_100g: 5 } })) });
  clock += 2000;
  const failed = await getProductHealth(BARCODE, { cache, now: () => clock, force: true, fetchImpl: async () => { throw new Error('Synthetic outage'); } });
  assert.equal(failed.dataAvailable, true);
  assert.equal(failed.nutritionPer100g.protein.value, 5);
  assert.equal(failed.sourceStatus, 'temporarily_unavailable');
  assert.equal(failed.stale, true);
  assert.equal(failed.checkedAt, first.checkedAt);
  assert.equal(failed.latestAttemptAt, '2026-01-01T00:00:02.000Z');
  assert.equal(failed.cacheStatus, 'cached');
  clock += 1000;
  const stillStale = await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl: async () => { throw new Error('Must use short-lived cache'); } });
  assert.equal(stillStale.sourceStatus, 'temporarily_unavailable');
  assert.equal(stillStale.checkedAt, first.checkedAt);
  assert.equal(stillStale.latestAttemptAt, failed.latestAttemptAt);
  assert.equal(stillStale.stale, true);
});

test('outage cache is short-lived and bounded', async () => {
  const cache = new Map();
  let calls = 0;
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const fetchImpl = async () => { calls++; return { ok: false, status: 503 }; };
  await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl });
  clock += 1000;
  assert.equal((await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl })).cacheStatus, 'cached');
  assert.equal(calls, 1);
  clock += 60_000;
  await getProductHealth(BARCODE, { cache, now: () => clock, fetchImpl });
  assert.equal(calls, 2);
  for (let item = 0; item < 305; item++) await getProductHealth(`synthetic-${item}`, { cache, now: () => clock, fetchImpl });
  assert.equal(cache.size, 300);
});

test('actual SW retains prior facts on HTTP 200 typed outage and returns the real outage; offline facts are explicitly stale', async () => {
  const worker = workerFixture();
  const cache = await worker.caches.open('trolleywise-runtime-v6');
  const facts = scoreProductHealth(BARCODE, complete({ nutriments: { proteins_100g: 5, sugars_100g: 0, sodium_100g: 0 } }), { checkedAt: '2026-01-01T00:00:00.000Z' });
  await cache.put(HEALTH_URL, jsonResponse(facts));
  const writes = cache.puts;
  const outage = noData(BARCODE, 'Synthetic outage', 'temporarily_unavailable', { checkedAt: '2026-01-01T00:00:02.000Z' });
  worker.network(async () => jsonResponse(outage));
  const current = await worker.request();
  assert.equal(current.status, 200);
  assert.equal(current.headers.get('X-Synthetic-Test'), 'only');
  assert.equal(current.headers.get('X-TrolleyWise-Cache'), null);
  assert.deepEqual(await current.json(), outage); // never a fake factual success
  assert.equal(cache.puts, writes);
  assert.deepEqual(await (await cache.match(HEALTH_URL)).json(), facts);
  worker.network(async () => { throw new Error('Synthetic offline'); });
  const offline = await worker.request();
  assert.equal(offline.headers.get('X-TrolleyWise-Cache'), 'stale');
  assert.equal(offline.headers.get('X-PriceCheck-Cache'), 'stale');
  const saved = await offline.json();
  assert.equal(saved.nutritionPer100g.protein.value, 5);
  assert.equal(saved.nutritionPer100g.sugar.value, 0);
  assert.equal(saved.checkedAt, facts.checkedAt);
  assert.deepEqual(saved, facts);
  assert.equal((await cache.match(HEALTH_URL)).headers.get('X-TrolleyWise-Cache'), null);
});

test('actual SW preserves nutrition/ingredient/allergen partial facts against no-facts temporary outages', async () => {
  const partials = [
    score({ ingredients_text: 'Synthetic water' }), score({ nutriments: { fat_100g: 0 } }),
    score({ allergens_tags: ['en:milk'] }), score({ traces_tags: ['en:eggs'] }),
    score({ image_nutrition_url: 'https://images.synthetic.invalid/label.jpg' }),
    { barcode: BARCODE, dataAvailable: false, nutritionPer100g: { fat: { value: 0, unit: 'g' } } },
  ];
  for (const facts of partials) {
    const worker = workerFixture();
    const cache = await worker.caches.open('trolleywise-runtime-v6');
    await cache.put(HEALTH_URL, jsonResponse(facts));
    worker.network(async () => jsonResponse(noData(BARCODE, 'Synthetic outage', 'temporarily_unavailable')));
    await worker.request();
    assert.deepEqual(await (await cache.match(HEALTH_URL)).json(), facts);
  }
});

test('actual SW caches new partial source facts and genuine not_found/fields_missing states, including typed 404', async () => {
  const worker = workerFixture();
  const cache = await worker.caches.open('trolleywise-runtime-v6');
  await cache.put(HEALTH_URL, jsonResponse(score(complete())));
  const newPartial = { ...score({ nutriments: { fat_100g: 2 }, allergens_tags: ['en:milk'] }), sourceStatus: 'temporarily_unavailable', stale: true };
  worker.network(async () => jsonResponse(newPartial));
  assert.deepEqual(await (await worker.request()).json(), newPartial);
  assert.deepEqual(await (await cache.match(HEALTH_URL)).json(), newPartial);
  for (const [sourceStatus, status] of [['not_found', 200], ['fields_missing', 200], ['not_found', 404]]) {
    const miss = noData(BARCODE, 'Synthetic genuine miss', sourceStatus);
    worker.network(async () => jsonResponse(miss, status));
    assert.equal((await worker.request()).status, status);
    assert.deepEqual(await (await cache.match(HEALTH_URL)).json(), miss);
  }
  const outage = noData(BARCODE, 'Synthetic outage', 'temporarily_unavailable');
  worker.network(async () => jsonResponse(outage));
  await worker.request(); // no facts to protect after a genuine miss
  assert.deepEqual(await (await cache.match(HEALTH_URL)).json(), outage);
});

test('actual SW leaves transport failure responses and force bypass intact; ordinary price 404 remains cacheable', async () => {
  const worker = workerFixture();
  const cache = await worker.caches.open('trolleywise-runtime-v6');
  const facts = score(complete());
  await cache.put(HEALTH_URL, jsonResponse(facts));
  let calls = 0;
  for (const status of [429, 503]) {
    worker.network(async () => { calls++; return jsonResponse({ message: 'Synthetic transport failure' }, status); });
    assert.equal((await worker.request()).status, status);
    assert.deepEqual(await (await cache.match(HEALTH_URL)).json(), facts);
  }
  const beforeForce = cache.puts;
  assert.equal(await worker.request(`${HEALTH_URL}?force=1`), null); // handler defers to browser network
  assert.equal(cache.puts, beforeForce);
  assert.equal(calls, 2);
  assert.equal(await cache.match(`${HEALTH_URL}?force=1`), undefined);
  const priceUrl = `https://synthetic.invalid/api/backend/price/${BARCODE}`;
  worker.network(async () => jsonResponse({ barcode: BARCODE, results: [], message: 'Synthetic missing price' }, 404));
  assert.equal((await worker.request(priceUrl)).status, 404);
  assert.equal((await cache.match(priceUrl)).status, 404);
});

test('actual SW migrates only legacy public normal API cache entries and preserves original fact timestamps', async () => {
  const worker = workerFixture();
  const legacy = await worker.caches.open('pricecheck-runtime-synthetic');
  const facts = scoreProductHealth(BARCODE, { nutriments: { fat_100g: 4 } }, { checkedAt: '2026-01-01T00:00:00.000Z' });
  await legacy.put(HEALTH_URL, jsonResponse(facts));
  await legacy.put(`${HEALTH_URL}?force=1`, jsonResponse(noData(BARCODE)));
  await legacy.put('https://synthetic.invalid/api/backend/users/me', jsonResponse({ private: 'synthetic' }));
  await legacy.put('https://synthetic.invalid/result', new Response('Synthetic old HTML'));
  await worker.activate();
  const current = await worker.caches.open('trolleywise-runtime-v6');
  assert.deepEqual(await (await current.match(HEALTH_URL)).json(), facts);
  assert.equal(await current.match(`${HEALTH_URL}?force=1`), undefined);
  assert.equal(await current.match('https://synthetic.invalid/api/backend/users/me'), undefined);
  assert.equal(await current.match('https://synthetic.invalid/result'), undefined);
  assert.equal((await worker.caches.keys()).includes('pricecheck-runtime-synthetic'), false);
  worker.network(async () => jsonResponse(noData(BARCODE, 'Synthetic outage', 'temporarily_unavailable')));
  await worker.request();
  assert.deepEqual(await (await current.match(HEALTH_URL)).json(), facts);
});

(async () => {
  console.log('SYNTHETIC fixtures only: no external calls, production writes or real product verification.');
  for (const { name, run } of tests) { await run(); console.log(`PASS ${name}`); }
  console.log(`All ${tests.length} TrolleyWise health fixture groups passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
