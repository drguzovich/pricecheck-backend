'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const base = process.env.TROLLEYWISE_TEST_URL || 'http://127.0.0.1:3000';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/demo`);
  await page.evaluate(() => {
    localStorage.setItem('pricecheck-guest-favourites', JSON.stringify([{ id: 'isolated-original', barcode: '6001069206154', productName: 'Synthetic legacy storage fixture', addedAt: '2026-01-01T00:00:00Z' }]));
  });
  const demoCalls = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/')) demoCalls.push(request.url()); });
  await page.reload();
  await page.getByRole('button', { name: /^Save .* in demo$/ }).first().click();
  await page.getByRole('button', { name: 'Explore fixture' }).first().click();
  await page.getByRole('button', { name: 'Reset demo fixtures' }).click();
  assert.equal(demoCalls.length, 0, 'demo must never request account, session or product APIs');
  assert.match(await page.evaluate(() => localStorage.getItem('pricecheck-guest-favourites')), /isolated-original/);
  await page.goto(`${base}/favourites`);
  await page.getByText('Synthetic legacy storage fixture').waitFor({ timeout: 35000 });
  assert.match(await page.evaluate(() => localStorage.getItem('trolleywise-guest-favourites')), /isolated-original/);
  await page.goto(`${base}/scan`);
  await page.getByRole('button', { name: 'Continuous queue' }).waitFor();
  await page.locator('#barcode').fill('6001069206154');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await page.locator('#barcode').fill('6001069206154');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await page.getByText(/already in your queue/).waitFor();
  const queue = await page.evaluate(() => JSON.parse(localStorage.getItem('trolleywise-scan-queue:v1')).items);
  assert.equal(queue.length, 1, 'repeated camera/manual code must not duplicate products');
  assert.equal(queue[0].barcode, '6001069206154');
  for (const path of ['/', '/about', '/privacy', '/terms', '/account']) {
    await page.goto(`${base}${path}`);
    await page.getByRole('heading').first().waitFor();
    assert.match(await page.title(), /TrolleyWise/);
    assert(!(await page.locator('body').innerText()).includes('PriceCheck'), `old visible brand on ${path}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow on ${path}`);
  }
  assert.deepEqual(errors, [], 'unexpected browser exceptions');
  const result = { observedAt: new Date().toISOString(), base, passed: true, checks: ['demo has zero account/product API calls', 'demo leaves old real-guest storage unchanged', 'legacy favourites survive canonical-key migration', 'manual continuous queue deduplicates barcode', 'all primary pages use TrolleyWise and fit390px', 'no browser exceptions'], caveat: 'Isolated context and synthetic storage fixture only. Real cloud login, camera hardware, nutrition source coverage, scheduler and email are separate gates.' };
  await fs.writeFile('/home/ubuntu/trolleywise-mobile-checks.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  await browser.close();
})().catch((error) => { console.error(error.stack); process.exit(1); });
