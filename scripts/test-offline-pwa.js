'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const frontendDir = process.env.PWA_TEST_PROJECT || path.resolve(__dirname, '../../pricecheck');
const barcode = '6001069206154';
const origin = 'http://127.0.0.1:3100';
const comparison = { barcode, product: { barcode, name: 'Offline test fixture', brand: 'Test fixture', pack_size: '500g', image_url: null }, results: [
  { retailer: 'woolworths', available: true, price: 20, price_str: 'R20.00', updated_at: new Date().toISOString(), stale: false, error: null },
  { retailer: 'pick_n_pay', available: false, price: null, updated_at: null, error: 'No exact match' },
  { retailer: 'checkers', available: false, price: null, updated_at: null, error: 'Set SCRAPER_API_KEY' },
  { retailer: 'spar', available: false, price: null, updated_at: null, error: 'Store prices vary' }
] };
const mock = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url.startsWith('/price/')) return response.end(JSON.stringify(comparison));
  if (request.url.includes('/health')) return response.end(JSON.stringify({ barcode, dataAvailable: false, cleanScore: null }));
  if (request.url === '/coverage') return response.end(JSON.stringify({ products: 1, retailer_sources: 1 }));
  response.end('{}');
});
async function main() {
  await new Promise((resolve) => mock.listen(3101, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(frontendDir, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '3100'], {
    cwd: frontendDir, env: { ...process.env, PRICECHECK_BACKEND_URL: 'http://127.0.0.1:3101', PORT: '3100' }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let browser;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { const response = await fetch(`${origin}/api/health`); if (response.ok) break; } catch { /* wait for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });
    await page.goto(`${origin}/result?barcode=${barcode}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Offline test fixture', exact: true }).waitFor();
    await page.getByText('No ingredient data available for this product', { exact: true }).waitFor();
    await page.goto(origin, { waitUntil: 'networkidle' });
    const cachesBefore = await page.evaluate(async () => {
      const all = await caches.keys();
      const runtime = await caches.open(all.find((name) => name.includes('runtime')));
      return (await runtime.keys()).map((entry) => entry.url);
    });
    assert(cachesBefore.some((url) => url.includes(`/api/backend/price/${barcode}`)), 'Public price response cached');
    assert(cachesBefore.some((url) => url.includes(`/result?barcode=${barcode}`)), 'Barcode result navigation cached');
    assert(!cachesBefore.some((url) => /api\/(auth|account-token|backend\/users)/.test(url)), 'Private API responses never cached');
    await context.setOffline(true);
    await page.goto(`${origin}/result?barcode=${barcode}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Offline test fixture', exact: true }).waitFor();
    await page.getByText('You’re offline — showing cached prices', { exact: true }).waitFor();
    const cachedApi = await page.evaluate(async (code) => { const response = await fetch(`/api/backend/price/${code}`); return { status: response.status, stale: response.headers.get('X-PriceCheck-Cache') }; }, barcode);
    assert.deepEqual(cachedApi, { status: 200, stale: 'stale' });
    console.log('Offline PWA regression passed: real worker/proxy caching, cached barcode navigation, stale header, offline banner, no-data health and private-cache exclusion. All retailer values in this test are explicitly synthetic fixtures.');
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => mock.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
