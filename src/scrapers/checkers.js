'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const RETAILER = 'checkers';
const PROVIDER_URL = 'https://api.parse.bot/scraper/39122869-152e-40fc-908a-8756aa0ff69b/search_products';
const CHECKERS_SEARCH_URL = 'https://www.checkers.co.za/search?q=';
const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process', '--disable-extensions',
];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MISSING_SCRAPER_API_KEY_MESSAGE = 'Checkers unavailable: set SCRAPER_API_KEY to enable ScraperAPI proxy access';

// playwright-extra keeps plugins on the browser type. Register once per process.
chromium.use(StealthPlugin());

function unavailable(barcode, error) {
  return {
    barcode, name: null, brand: null, pack_size: null, image_url: null,
    price: null, price_str: null, url: null, promo_flag: false,
    scraped_at: new Date().toISOString(), retailer: RETAILER, available: false, error, message: error,
  };
}

function exactBarcodeMatch(candidate, barcode) {
  const values = [candidate?.barcode, candidate?.ean, candidate?.gtin, candidate?.sku, ...(candidate?.barcodes || [])];
  return values.map((value) => String(value || '').replace(/\D/g, '')).includes(String(barcode));
}

function extractPrice(candidate) {
  const raw = candidate?.price ?? candidate?.sellingPrice ?? (Number.isFinite(candidate?.priceWithoutDecimal) ? candidate.priceWithoutDecimal / 100 : null);
  const price = typeof raw === 'string' ? Number(raw.replace(/[^\d.,]/g, '').replace(',', '.')) : Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function productCandidates(payload, found = [], seen = new Set(), depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 10 || seen.has(payload)) return found;
  seen.add(payload);
  if (!Array.isArray(payload) && (candidate => candidate?.name || candidate?.displayName || candidate?.barcode || candidate?.ean)(payload)) found.push(payload);
  for (const value of Array.isArray(payload) ? payload : Object.values(payload)) productCandidates(value, found, seen, depth + 1);
  return found;
}

function resultFromCandidate(barcode, candidate, url = null) {
  const price = extractPrice(candidate);
  if (!price) return null;
  return {
    barcode,
    name: candidate.name ?? candidate.displayName ?? null,
    brand: candidate.brand?.name ?? candidate.brand ?? null,
    pack_size: candidate.pack_size ?? candidate.packSize ?? candidate.size ?? null,
    image_url: candidate.imageURL ?? candidate.image_url ?? candidate.image ?? candidate.images?.[0]?.url ?? candidate.images?.[0] ?? null,
    price,
    price_str: candidate.price?.formattedValue ?? `R${price.toFixed(2)}`,
    url: candidate.url ?? (candidate.slug ? `https://www.checkers.co.za/product/${candidate.slug}` : url),
    promo_flag: Boolean(candidate.isOnPromotion ?? candidate.promo ?? candidate.special),
    scraped_at: new Date().toISOString(), retailer: RETAILER, available: true, error: null,
  };
}

async function lookupParseProvider(barcode, product, timeoutMs) {
  const apiKey = process.env.CHECKERS_PARSE_API_KEY || process.env.PARSE_API_KEY;
  if (!apiKey) return null;
  const query = product?.name || barcode;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(PROVIDER_URL);
    url.search = new URLSearchParams({ page: '0', query, page_size: '20' });
    const response = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return unavailable(barcode, `Checkers provider returned HTTP ${response.status}`);
    const candidate = productCandidates(await response.json()).find((item) => exactBarcodeMatch(item, barcode));
    return (candidate && resultFromCandidate(barcode, candidate))
      || unavailable(barcode, 'Checkers provider did not return an exact barcode match with a usable price');
  } catch (error) {
    return unavailable(barcode, error.name === 'AbortError' ? 'Checkers provider request timed out' : `Checkers provider request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupScraperApi(barcode, timeoutMs) {
  const apiKey = process.env.SCRAPER_API_KEY;
  let browser;
  const intercepted = [];
  try {
    browser = await chromium.launch({
      headless: true,
      args: BROWSER_ARGS,
      proxy: {
        server: process.env.SCRAPER_API_PROXY_URL || 'http://proxy-server.scraperapi.com:8001',
        username: 'scraperapi',
        password: apiKey,
      },
    });
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 }, locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' });
    const page = await context.newPage();
    page.on('response', async (response) => {
      if (!['xhr', 'fetch'].includes(response.request().resourceType())) return;
      const type = response.headers()['content-type'] || '';
      if (!type.includes('json')) return;
      try { intercepted.push(await response.json()); } catch (_) {}
    });
    await page.goto(`${CHECKERS_SEARCH_URL}${encodeURIComponent(barcode)}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(Math.min(1250, Math.max(250, Math.floor(timeoutMs / 5))));
    for (const payload of intercepted) {
      const candidate = productCandidates(payload).find((item) => exactBarcodeMatch(item, barcode));
      const result = candidate && resultFromCandidate(barcode, candidate);
      if (result) return result;
    }

    // A DOM value is eligible only inside a product card that itself contains
    // the requested barcode. This deliberately declines unscoped search prices.
    const exactCard = await page.evaluate((requestedBarcode) => {
      const cards = [...document.querySelectorAll('[data-testid*="product" i], [class*="product" i]')];
      for (const card of cards) {
        const text = card.innerText || '';
        if (!text.replace(/\D/g, '').includes(requestedBarcode)) continue;
        const priceMatch = text.match(/R\s*([\d\s,.]+)/i);
        if (!priceMatch) continue;
        const link = card.querySelector('a[href]');
        const image = card.querySelector('img');
        return { name: card.querySelector('h1,h2,h3,h4,a')?.textContent?.trim() || null, price: priceMatch[1], url: link?.href || null, image_url: image?.currentSrc || image?.src || null };
      }
      return null;
    }, barcode);
    if (exactCard) {
      const price = extractPrice(exactCard);
      if (price) return resultFromCandidate(barcode, { ...exactCard, barcode, price }, exactCard.url);
    }
    return unavailable(barcode, 'Checkers returned no exact barcode match with a usable price');
  } catch (error) {
    return unavailable(barcode, error.name === 'TimeoutError' ? 'Checkers request timed out' : `Checkers request failed: ${error.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeByBarcode(barcode, { timeoutMs = 15000, product = null } = {}) {
  if (process.env.SCRAPER_API_KEY) return lookupScraperApi(barcode, timeoutMs);
  // ScraperAPI is the default integration. Legacy Parse credentials never
  // silently bypass its required key; that provider is explicit opt-in only.
  if (String(process.env.CHECKERS_PROVIDER || '').toLowerCase() === 'parse') {
    const providerResult = await lookupParseProvider(barcode, product, timeoutMs);
    if (providerResult) return providerResult;
  }
  return unavailable(barcode, MISSING_SCRAPER_API_KEY_MESSAGE);
}

module.exports = { RETAILER, exactBarcodeMatch, scrapeByBarcode, unavailable };
