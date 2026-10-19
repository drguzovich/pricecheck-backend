'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const origin = process.env.PWA_TEST_ORIGIN || 'http://127.0.0.1:3000';
const output = process.env.PWA_TEST_OUTPUT || '/tmp/pricecheck-mobile-checks';

async function main() {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Deterministic UI fixtures only. These are not asserted to be live retailer prices.
  await context.route('**/api/backend/price/*', async (route) => {
    const barcode = new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({ json: { barcode, product: { barcode, name: 'UI test grocery', brand: 'Test fixture', pack_size: '500g', image_url: null }, results: [
      { retailer: 'woolworths', available: true, price: 20, price_str: 'R20.00', updated_at: new Date().toISOString(), stale: false, error: null },
      { retailer: 'pick_n_pay', available: true, price: 21, price_str: 'R21.00', updated_at: new Date().toISOString(), stale: false, error: null },
      { retailer: 'checkers', available: true, price: 22, price_str: 'R22.00', updated_at: new Date().toISOString(), stale: false, error: null },
      { retailer: 'spar', available: false, price: null, updated_at: null, error: 'Store-specific prices unavailable' }
    ] } });
  });
  await context.route('**/api/backend/product/*/health', async (route) => route.fulfill({ json: { barcode: '6001069206154', dataAvailable: true, cleanScore: 6, grade: 'OK', concerns: ['High sugar'], nutriscore: 'D', ingredientsText: 'UI test ingredient fixture', dataCompleteness: 'complete' } }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copiedText = text; } }, configurable: true });
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.bottom-nav a').count(), 4, 'Four bottom navigation destinations');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Home does not overflow phone width');
  await page.screenshot({ path: `${output}/home-390.png`, fullPage: true });
  await page.goto(`${origin}/result?barcode=6001069206154`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'UI test grocery', exact: true }).waitFor();
  assert.equal(await page.locator('.rank-badge').allTextContents().then((texts) => texts.join('|')), 'Best Price|2nd|3rd');
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await page.getByRole('button', { name: 'Remove saved product', exact: true }).waitFor();
  assert.equal(await page.locator('.favourite-button').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  assert.match(await page.evaluate(() => window.__copiedText), /^UI test grocery — best price R20\.00 at Woolworths\. PriceCheck: http/);
  await page.getByRole('button', { name: 'Why prices vary' }).click();
  assert.equal(await page.locator('.spar-info-button').getAttribute('aria-expanded'), 'true');
  await page.getByText('Nutri-Score D', { exact: true }).waitFor();
  await page.getByText('High sugar', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Result does not overflow phone width');
  await page.screenshot({ path: `${output}/result-fixture-390.png`, fullPage: true });
  await page.goto(`${origin}/favourites`, { waitUntil: 'networkidle' });
  await page.getByText('UI test grocery', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Set price alert' }).waitFor();
  await page.goto(`${origin}/history`, { waitUntil: 'networkidle' });
  await page.getByText('Sign in to sync across devices', { exact: true }).waitFor();
  await page.getByText('UI test grocery', { exact: true }).waitFor();
  await page.goto(`${origin}/account`, { waitUntil: 'networkidle' });
  const google = page.getByRole('button', { name: /Google/ });
  await google.waitFor();
  assert.equal(await google.isDisabled(), true, 'Absent Google credentials fail visibly closed');
  await page.screenshot({ path: `${output}/account-390.png`, fullPage: true });
  assert.deepEqual(errors, [], 'No uncaught page errors');
  await browser.close();
  console.log('Mobile UI checks passed: four tabs, responsive layout, guest star/history, share text, SPAR information, health contract, favourite alert link and missing-config account state. Fixture prices were not treated as live evidence.');
}
main().catch((error) => { console.error(error); process.exit(1); });
