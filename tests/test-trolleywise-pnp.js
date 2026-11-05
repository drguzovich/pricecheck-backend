'use strict';

// SYNTHETIC TEST FIXTURES ONLY. Prices below are parser test values, not retailer
// observations. The --live mode makes one real read-only lookup and prints it.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const pnp = require('../src/scrapers/pnp');
const EAN = '6001069206154';
const OTHER = '6001069600822';
const ARTICLE = '000000000000544830_EA';
const fixture = (overrides = {}) => ({
  ean: EAN, code: '000000000000111111_EA', name: 'SYNTHETIC fixture rusks 500g',
  price: { value: 12.34, currencyIso: 'ZAR' }, available: true,
  url: '/synthetic-fixture/p/000000000000111111_EA', ...overrides,
});
const jsonResponse = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const configurationKeys = ['PNP_PRODUCT_LOOKUP_URL', 'PARSE_API_KEY'];

async function isolated(callback) {
  const originalFetch = global.fetch;
  const originalLaunch = chromium.launch;
  const env = Object.fromEntries(configurationKeys.map((key) => [key, process.env[key]]));
  for (const key of configurationKeys) delete process.env[key];
  try { await callback(); }
  finally {
    global.fetch = originalFetch;
    chromium.launch = originalLaunch;
    for (const key of configurationKeys) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  }
}

function testIdentityAndMoney() {
  assert.equal(pnp.gtinChecksumValid(EAN), true, 'benchmark checksum is valid, no code correction');
  assert.equal(pnp.gtinChecksumValid('6001069206155'), false);
  assert.equal(pnp.findVerifiedCandidate({ products: [fixture()] }, EAN).ean, EAN);
  assert.equal(pnp.findVerifiedCandidate({ products: [fixture({ ean: OTHER })] }, EAN), null);
  assert.equal(pnp.hasExactBarcode(fixture({ ean: `prefix${EAN}` }), EAN), false);
  assert.equal(pnp.hasExactBarcode({ code: EAN, id: EAN, name: 'SYNTHETIC fixture' }, EAN), false);
  assert.equal(pnp.hasExactBarcode({ images: [{ url: `https://example.test/${EAN}.jpg` }] }, EAN), false);
  assert.deepEqual(pnp.candidateIdentifiers({ classifications: {} }), []);
  assert.deepEqual(pnp.candidateIdentifiers({ classifications: [{ features: {} }] }), []);
  assert.equal(pnp.hasExactNameAndPack({ name: 'SYNTHETIC fixture rusks 500g', price: 12.34 }, { barcode: EAN, name: 'SYNTHETIC fixture rusks 500g', pack_size: '500g' }), false);
  const inherited = fixture({ ean: OTHER, baseProduct: { ean: EAN } });
  assert.equal(pnp.hasExactBarcode(inherited, EAN), false, 'variant cannot inherit another product EAN');
  assert.equal(pnp.resultFromCandidate(EAN, inherited, 'https://example.test/public'), null);
  const labelled = fixture({ ean: undefined, classifications: [{ features: [{ name: 'unit_barcode', featureValues: [{ value: EAN }] }] }] });
  assert.equal(pnp.hasExactBarcode(labelled, EAN), true, 'own labelled OCC unit EAN for EA article');
  assert.equal(pnp.hasExactBarcode({ ...labelled, code: '000000000000111111_CS' }, EAN), false, 'unit EAN cannot identify case price');
  assert.equal(pnp.findVerifiedCandidate({ potentialPromotions: [fixture()] }, EAN), null, 'promotion object is not product identity');
  assert.equal(pnp.resultFromCandidate(EAN, fixture({ price: { value: 12.34, currencyIso: 'USD' } }), null), null);
  for (const raw of [null, false, '', 'R 12.34 each or 2 for R 20', -1, 0, Infinity]) assert.equal(pnp.extractPrice({ price: raw }), null);
  assert.equal(pnp.extractPrice({ price: 'R 12,34' }), 12.34);
  assert.equal(pnp.resultFromCandidate(EAN, fixture({ available: false }), null), null);
  assert.equal(pnp.resultFromCandidate(EAN, fixture({ stock: { stockLevelStatus: 'outOfStock' } }), null), null);
  assert.equal(pnp.resultFromCandidate(EAN, fixture({ code: '000000000000111111_KGM' }), null), null);
  const result = pnp.resultFromCandidate(EAN, fixture({ potentialPromotions: [{ valid: false }] }), 'https://www.pnp.co.za/source', pnp.STORE_CODE);
  assert.equal(result.price, 12.34);
  assert.equal(result.store_name, 'Pick n Pay Constantia');
  assert.equal(result.promo_flag, false, 'ineligible loyalty promotion is not a selling-price promotion');
  assert.equal(result.url, 'https://www.pnp.co.za/synthetic-fixture/p/000000000000111111_EA');
  assert.equal(pnp.resultFromCandidate(EAN, fixture({ storeCode: 'HC06' }), null, pnp.STORE_CODE), null);
  const redacted = pnp.resultFromCandidate(EAN, fixture({ url: undefined }), 'https://example.test/source?token=SYNTHETIC_SECRET');
  assert.equal(JSON.stringify(redacted).includes('SYNTHETIC_SECRET'), false);
  assert.equal(redacted.source_url, null);
  assert.equal(redacted.store_code, null, 'provider without store evidence is not labelled Constantia');
}

async function testPostAndEmpty() {
  await isolated(async () => {
    let calls = 0;
    chromium.launch = async () => { throw new Error('Empty accepted search must not start a browser'); };
    global.fetch = async (url, options) => {
      calls++;
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/pnphybris/v2/pnp-spa/products/search');
      assert.equal(parsed.searchParams.get('query'), EAN);
      assert.equal(parsed.searchParams.get('storeCode'), pnp.STORE_CODE);
      assert.equal(parsed.searchParams.get('curr'), 'ZAR');
      assert.equal(options.method, 'POST');
      assert.equal(options.body, '{}');
      assert.equal(options.headers['X-Pnp-Cache-Key'], 'anonymous');
      assert.equal(options.signal.aborted, false);
      return jsonResponse({ products: [], pagination: { totalResults: 0 } });
    };
    const result = await pnp.scrapeByBarcode(EAN);
    assert.equal(calls, 1);
    assert.equal(result.available, false);
    assert.equal(result.price, null);
    assert.match(result.error, /zero products/);
    assert.equal(result.diagnostics.find((x) => x.stage === 'ean_search' && x.status === 'json_received').http_status, 200);
  });
}

async function testArticleDetailAndMismatch() {
  for (const expectedMatch of [false, true]) await isolated(async () => {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (options.method === 'POST') return jsonResponse({ products: [fixture({ code: ARTICLE, ean: undefined })] });
      return jsonResponse(fixture({ code: ARTICLE, ean: undefined, classifications: [{ features: [{ name: 'unit_barcode', featureValues: [{ value: expectedMatch ? EAN : OTHER }] }] }] }));
    };
    const result = await pnp.scrapeByBarcode(EAN);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, 'GET');
    assert.match(calls[1].url, new RegExp(ARTICLE));
    assert.equal(result.available, expectedMatch);
    assert.equal(result.price, expectedMatch ? 12.34 : null);
  });
}

async function testNameHintsAndProvider() {
  await isolated(async () => {
    global.fetch = async (url) => {
      const query = new URL(url).searchParams.get('query');
      return jsonResponse(query === EAN ? { products: [], pagination: { totalResults: 0 } } : { products: [fixture({ ean: OTHER, name: 'Ouma Chunky Buttermilk Rusks 500g' })] });
    };
    const result = await pnp.scrapeByBarcode(EAN, { productName: 'Ouma Buttermilk Rusks 500g' });
    assert.equal(result.available, false);
    assert.equal(result.price, null);
  });
  await isolated(async () => {
    process.env.PARSE_API_KEY = 'SYNTHETIC_TEST_KEY_NOT_A_CREDENTIAL';
    global.fetch = async (url) => jsonResponse(String(url).startsWith('https://api.parse.bot/') ? { products: [fixture({ ean: OTHER })] } : { products: [], pagination: { totalResults: 0 } });
    const result = await pnp.scrapeByBarcode(EAN);
    assert.equal(result.available, false, 'approved provider must still declare the exact EAN');
    assert.equal(JSON.stringify(result).includes(process.env.PARSE_API_KEY), false);
  });
}

async function testCallerDeadlineAndCancellation() {
  await isolated(async () => {
    process.env.PNP_PRODUCT_LOOKUP_URL = 'https://example.test/public/{barcode}';
    let active = 0;
    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      active++;
      options.signal.addEventListener('abort', () => { active--; reject(Object.assign(new Error('fixture cancellation'), { name: 'AbortError' })); }, { once: true });
    });
    const start = performance.now();
    const result = await pnp.scrapeByBarcode(EAN, { timeoutMs: 120 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(performance.now() - start < 220, 'one caller deadline, not stage-added deadlines');
    assert.equal(active, 0, 'pending HTTP request actually aborted');
    assert.equal(result.available, false);
    const controller = new AbortController();
    const pending = pnp.scrapeByBarcode(EAN, { timeoutMs: 15000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const cancelled = await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(active, 0);
    assert.match(cancelled.error, /cancelled by caller/);
    controller.abort();
    const alreadyCancelled = await pnp.scrapeByBarcode(EAN, { signal: controller.signal });
    assert.equal(alreadyCancelled.available, false);
    assert.equal(active, 0);
  });
}

async function testBrowserInterceptionAndClose() {
  await isolated(async () => {
    let closed = 0;
    let handler;
    const url = pnp.searchUrl(EAN);
    const page = {
      route: async () => {}, on: (name, callback) => { if (name === 'response') handler = callback; },
      goto: async () => {
        handler({ url: () => url, ok: () => true, status: () => 200,
          request: () => ({ resourceType: () => 'fetch' }), json: async () => ({ products: [fixture()] }) });
        return { status: () => 200 };
      },
      waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
    chromium.launch = async (options) => {
      assert.equal(options.proxy, undefined, 'PnP has no proxy');
      return { newContext: async () => ({ newPage: async () => page }), close: async () => { closed++; } };
    };
    global.fetch = async () => jsonResponse({ errors: [{ type: 'UnknownIdentifierError' }] }, 400);
    const result = await pnp.scrapeByBarcode(EAN, { timeoutMs: 2000 });
    assert.equal(result.available, true);
    assert.ok(closed >= 1, 'isolated fallback browser closed');
  });
  await isolated(async () => {
    let closed = 0;
    chromium.launch = async () => ({
      newContext: async () => ({ newPage: async () => ({ route: async () => {}, on: () => {}, goto: () => new Promise(() => {}) }) }),
      close: async () => { closed++; },
    });
    global.fetch = async () => jsonResponse({ errors: [{ type: 'UnknownIdentifierError' }] }, 400);
    const result = await pnp.scrapeByBarcode(EAN, { timeoutMs: 2000 });
    assert.equal(result.available, false);
    assert.ok(closed >= 1, 'deadline closes active browser, not only the caller Promise');
    assert.match(result.error, /ean_search: http_error HTTP 400 UnknownIdentifierError/);
  });
}

(async () => {
  if (process.argv.includes('--live')) {
    const saved = Object.fromEntries(configurationKeys.map((key) => [key, process.env[key]]));
    for (const key of configurationKeys) delete process.env[key];
    try {
      const started = performance.now();
      const result = await pnp.scrapeByBarcode(EAN, { timeoutMs: 15000 });
      const elapsedMs = Math.round(performance.now() - started);
      assert.ok(elapsedMs < 15000, 'real scrape stays inside 15s caller bound');
      assert.equal(result.barcode, EAN);
      if (!result.available) assert.equal(result.price, null);
      console.log(JSON.stringify({ mode: 'real_read_only_source', elapsedMs, result }, null, 2));
    } finally {
      for (const key of configurationKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    }
    return;
  }
  testIdentityAndMoney();
  await testPostAndEmpty();
  await testArticleDetailAndMismatch();
  await testNameHintsAndProvider();
  await testCallerDeadlineAndCancellation();
  await testBrowserInterceptionAndClose();
  console.log('TrolleyWise PnP: labelled synthetic parser/identity fixtures, OCC POST context, detail resolution, strict provider fallback, deadline, caller cancellation, and isolated browser close passed. No fixture prices are live evidence.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
