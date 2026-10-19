'use strict';

const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const { getProductHealth, scoreProductHealth } = require('../src/productHealth');
const { scrapeByBarcode: scrapeCheckers } = require('../src/scrapers/checkers');
const { alertDeliveryReadiness } = require('../src/alerts');
const { requireUser } = require('../src/userAuth');
const { getComparison } = require('../src/priceService');
const { parseInitialStateProduct } = require('../src/scrapers/woolworths');
const { findVerifiedCandidate, hasExactNameAndPack } = require('../src/scrapers/pnp');

function withEnv(names, callback) {
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  return Promise.resolve(callback()).finally(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

async function testHealthRules() {
  const result = scoreProductHealth('6000000000001', {
    ingredients_text: 'flour, E102, E211, E330',
    nutriments: { sugars_100g: 25, sodium_100g: 1.2 },
    nutrition_grades: 'e',
  });
  assert.equal(result.dataAvailable, true);
  assert.equal(result.score, 2); // start 10, 3 additives, color, preservative, sugar, sodium, Nutri E
  assert.equal(result.grade, 'Concerning');
  assert.deepEqual(result.tags, ['3 additives', 'Artificial colors', 'Artificial preservatives', 'High sugar', 'High sodium', 'Nutri-Score E']);
  assert.match(result.disclaimer, /non-medical/i);
  assert.match(result.disclaimer, /allergy/i);

  const partial = scoreProductHealth('6000000000001', { ingredients_text: 'water' });
  assert.equal(partial.dataAvailable, true);
  assert.equal(partial.scoreAvailable, false);
  assert.equal(partial.cleanScore, null);
  assert.equal(partial.score, null);
  assert.equal(partial.grade, null);
  assert.equal(partial.dataCompleteness, 'partial');
  assert.deepEqual(partial.missingData, ['sugar per 100g', 'sodium per 100g', 'Nutri-Score']);
  assert.match(partial.disclaimer, /partial/i);

  const nutritionOnly = scoreProductHealth('6000000000001', {
    nutriments: { sugars_100g: 0, sodium_100g: 0 },
    nutrition_grades: 'a',
  });
  assert.equal(nutritionOnly.dataAvailable, true);
  assert.equal(nutritionOnly.scoreAvailable, false);
  assert.equal(nutritionOnly.cleanScore, null);
  assert.deepEqual(nutritionOnly.missingData, ['ingredients']);

  const sugarUnknown = scoreProductHealth('6000000000001', {
    ingredients_text: 'water', nutriments: { sugars_100g: null, sodium_100g: 0 }, nutrition_grades: 'a',
  });
  assert.equal(sugarUnknown.dataAvailable, true);
  assert.equal(sugarUnknown.scoreAvailable, false);
  assert.deepEqual(sugarUnknown.missingData, ['sugar per 100g']);

  const empty = scoreProductHealth('6000000000001', {});
  assert.equal(empty.dataAvailable, false);
  assert.equal(empty.scoreAvailable, false);
  assert.equal(empty.cleanScore, null);

  const missing = await getProductHealth('6001069206154', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 0, product: null }) }),
  });
  assert.equal(missing.dataAvailable, false);
  assert.equal(missing.score, null);
}

async function testMissingCheckersSetup() {
  await withEnv(['SCRAPER_API_KEY', 'CHECKERS_PARSE_API_KEY', 'PARSE_API_KEY', 'CHECKERS_PROVIDER'], async () => {
    delete process.env.SCRAPER_API_KEY;
    delete process.env.CHECKERS_PROVIDER;
    process.env.CHECKERS_PARSE_API_KEY = 'legacy-key-must-not-bypass-scraperapi';
    process.env.PARSE_API_KEY = 'legacy-key-must-not-bypass-scraperapi';
    const result = await scrapeCheckers('6001069206154');
    assert.equal(result.available, false);
    assert.match(result.error, /SCRAPER_API_KEY/);
    assert.match(result.message, /set SCRAPER_API_KEY/i);
  });
}

async function testAlertDeliveryReadiness() {
  await withEnv(['RESEND_API_KEY', 'ALERT_FROM_EMAIL', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'], () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_FROM_EMAIL;
    delete process.env.EMAIL_FROM;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const readiness = alertDeliveryReadiness();
    assert.equal(readiness.deliveryEnabled, false);
    assert.match(readiness.deliveryMessage, /saved/i);
    assert.match(readiness.deliveryMessage, /not configured/i);
  });
}

async function testAccountIdJwt() {
  await withEnv(['USER_SYNC_JWT_SECRET', 'NEXTAUTH_SECRET'], () => {
    process.env.USER_SYNC_JWT_SECRET = 'unit-test-user-sync-secret';
    process.env.NEXTAUTH_SECRET = 'different-nextauth-secret';
    const token = jwt.sign({ account_id: 'google-account-123', email: 'Person@Example.com', display_name: ' Person ' }, process.env.USER_SYNC_JWT_SECRET, { algorithm: 'HS256' });
    const req = { get: (header) => (header === 'authorization' ? `Bearer ${token}` : '') };
    let statusCode = null;
    let response = null;
    let continued = false;
    const res = { status(code) { statusCode = code; return this; }, json(body) { response = body; return this; } };
    requireUser(req, res, () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(statusCode, null);
    assert.equal(response, null);
    assert.equal(req.user.accountId, 'google-account-123');
    assert.equal(req.user.googleId, 'google-account-123');
    assert.equal(req.user.email, 'person@example.com');
  });
}

async function testFailureIsolation() {
  const goodAdapter = {
    RETAILER: 'healthy_retailer',
    scrapeByBarcode: async (barcode) => ({
      retailer: 'healthy_retailer', barcode, name: 'Verified test item', brand: null, pack_size: '500g', image_url: null,
      price: 19.95, price_str: 'R 19.95', url: 'https://example.test/product', promo_flag: false, scraped_at: new Date().toISOString(), error: null,
    }),
  };
  const failedAdapter = { RETAILER: 'failed_retailer', scrapeByBarcode: async () => { throw new Error('controlled adapter failure'); } };
  const comparison = await getComparison('6001069206154', { adapters: [failedAdapter, goodAdapter], productMetadata: null });
  assert.equal(comparison.results.length, 2);
  assert.equal(comparison.results[0].available, false);
  assert.match(comparison.results[0].error, /controlled adapter failure/);
  assert.equal(comparison.results[1].available, true);
  assert.equal(comparison.results[1].price, 19.95);
}

function testParserProvenanceAndVariantGuard() {
  const barcode = '6001069206154';
  const matchingHtml = `<script type="application/json">${JSON.stringify({ pdp: { productInfo: { productId: barcode, productName: 'Rusks: Ouma Buttermilk, 500g', SalePrice: 24.95, imageUrl: 'https://example.test/ouma.jpg' } } })}</script>`;
  const parsed = parseInitialStateProduct(matchingHtml, barcode);
  assert.equal(parsed.price, 24.95);
  assert.equal(parsed.provenance, 'initial_state');

  const mismatchHtml = `<script type="application/json">${JSON.stringify({ pdp: { productInfo: { productId: '6001069600822', productName: 'Ouma Chunky Buttermilk Rusks 500g', SalePrice: 62.99 } } })}</script>`;
  assert.equal(parseInitialStateProduct(mismatchHtml, barcode), null);

  const variant = { ean: '6001069600822', name: 'Ouma Chunky Buttermilk Rusks 500g', packSize: '500g', price: 62.99 };
  assert.equal(findVerifiedCandidate({ products: [variant] }, barcode, { barcode, name: 'Ouma Buttermilk Rusks 500g', pack_size: '500g' }), null);

  const unlabelledCandidate = { name: 'Ouma Buttermilk Rusks 500g', packSize: '500g', price: 24.95 };
  const requestedProduct = { barcode, name: 'Ouma Buttermilk Rusks 500g', pack_size: '500g' };
  assert.equal(hasExactNameAndPack(unlabelledCandidate, requestedProduct), false);
  assert.equal(findVerifiedCandidate({ products: [unlabelledCandidate] }, barcode, requestedProduct), null);

  const internalCodeOnly = { id: barcode, name: 'Ouma Buttermilk Rusks 500g', packSize: '500g', price: 24.95 };
  assert.equal(findVerifiedCandidate({ products: [internalCodeOnly] }, barcode, requestedProduct), null);
}

(async () => {
  await testHealthRules();
  await testMissingCheckersSetup();
  await testAlertDeliveryReadiness();
  await testAccountIdJwt();
  await testFailureIsolation();
  testParserProvenanceAndVariantGuard();
  console.log('backend gaps: health rules, delivery readiness, missing-key setup, JWT compatibility, failure isolation, and parser provenance passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
