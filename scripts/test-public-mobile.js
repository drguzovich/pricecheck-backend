'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const origin = process.env.PRICECHECK_PUBLIC_URL || 'https://pricecheck-7dykljea.manus.space';
const output = process.env.PUBLIC_CHECK_OUTPUT || '/tmp/pricecheck-public-mobile.json';

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.__copiedText = text; } }, configurable: true });
  });
  const record = { origin, observedAt: new Date().toISOString(), errors, pages: {} };
  for (const path of ['/', '/history', '/favourites', '/account', '/privacy', '/terms', '/about', '/scan', '/search']) {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 65000 });
    assert.equal(response.status(), 200);
    assert.equal(await page.locator('.bottom-nav a').count(), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const body = await page.locator('body').innerText();
    if (path === '/history') assert.match(body, /You haven.t scanned anything yet/);
    if (path === '/favourites') assert.match(body, /No favourites yet/);
    if (path === '/account') assert.match(body, /Google/);
    record.pages[path] = { status: response.status(), title: await page.title(), navItems: 4 };
  }
  await page.goto(`${origin}/result?barcode=6001069206154`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByRole('heading', { name: 'Rusks: Ouma Buttermilk, 500g', exact: true }).waitFor({ timeout: 60000 });
  await page.getByText('No ingredient data available for this product', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Save product', exact: true }).click();
  await page.getByRole('button', { name: 'Remove saved product', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  record.shareText = await page.evaluate(() => window.__copiedText);
  assert.match(record.shareText, /best price R24\.95 at Woolworths/);
  record.benchmarkBody = await page.locator('.result-page').innerText();
  assert.match(record.benchmarkBody, /Store prices vary/);
  assert.match(record.benchmarkBody, /Best Price/);
  assert.match(record.benchmarkBody, /Not available/);
  await page.goto(`${origin}/favourites`, { waitUntil: 'networkidle' });
  await page.getByText('Rusks: Ouma Buttermilk, 500g', { exact: true }).waitFor();
  await page.goto(`${origin}/history`, { waitUntil: 'networkidle' });
  await page.getByText('Rusks: Ouma Buttermilk, 500g', { exact: true }).waitFor();
  // A separate real product validates non-empty health UI. It does not replace
  // the user's exact-barcode Clean Score acceptance requirement.
  await page.goto(`${origin}/result?barcode=5449000009067`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByLabel('Clean Score 7 out of 10, OK').waitFor({ timeout: 45000 });
  await page.getByText('2 additives', { exact: true }).waitFor();
  record.realHealthProduct = { barcode: '5449000009067', cleanScore: 7, grade: 'OK', source: 'Live Open Food Facts through deployed backend' };
  assert.deepEqual(errors, []);
  await fs.writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  await browser.close();
  console.log('Public mobile checks passed against actual deployed data. Benchmark Woolworths R24.95, honest no-data health, guest save/history/share, legal pages and navigation verified; separate Coca-Cola2L health7/10 OK verified.');
}
main().catch((error) => { console.error(error); process.exit(1); });
