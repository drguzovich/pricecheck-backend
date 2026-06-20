'use strict';

/**
 * Woolworths scraper
 * Scrapes product name and price from woolworths.co.za product pages.
 * The site is JS-rendered so we use Playwright (headless Chromium).
 *
 * URL pattern: https://www.woolworths.co.za/prod/_/A-{barcode}
 *
 * Strategy (in order of preference):
 *   1. JSON-LD structured data embedded in initial HTML — fastest, no JS wait needed
 *   2. Wait for DOM price selectors — fallback if JSON-LD is absent
 *   3. Evaluate page JS to extract from Angular/React component state
 */

const { chromium } = require('playwright');

const RETAILER = 'woolworths';
const BASE_URL = 'https://www.woolworths.co.za';

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-extensions',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Parse a price string like "R 24.95" or "R24.95" into a float.
 * Returns null if parsing fails.
 */
function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Try to extract product data from JSON-LD scripts already present in the page HTML.
 * Returns { name, brand, price, price_str, image_url } or null if not found.
 */
async function extractFromJsonLd(page) {
  try {
    const scripts = await page.$$eval(
      'script[type="application/ld+json"]',
      (els) => els.map((el) => el.textContent)
    );
    for (const text of scripts) {
      try {
        const data = JSON.parse(text);
        if (data['@type'] === 'Product') {
          const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
          const price = offers?.price ? parseFloat(offers.price) : null;
          if (price) {
            return {
              name: data.name || null,
              brand: data.brand?.name || null,
              price,
              price_str: `R ${price.toFixed(2)}`,
              image_url: Array.isArray(data.image) ? data.image[0] : data.image || null,
            };
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

/**
 * Try to extract price from DOM selectors after waiting for JS to render.
 */
async function extractFromDom(page, timeoutMs = 30000) {
  const selectors = [
    'span.price',
    '.product-price',
    '[class*="Price"]',
    '[class*="price"]',
    'strong.price',
    '[data-testid*="price"]',
    '[data-testid*="Price"]',
  ];

  // Wait for any one of the selectors to appear
  try {
    await page.waitForSelector(selectors.join(', '), { timeout: timeoutMs });
  } catch (_) {
    // Timed out — try anyway in case something partial loaded
  }

  for (const sel of selectors) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        const text = (await el.innerText()).trim();
        if (text && /R\s*\d/.test(text)) {
          return { price: parsePrice(text), price_str: text };
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Try to extract price from the page's JS bundle / window state.
 * Woolworths Angular app sometimes stores product data in window.__INITIAL_STATE__
 * or similar globals.
 */
async function extractFromPageState(page) {
  try {
    const result = await page.evaluate(() => {
      // Try common SPA state containers
      const candidates = [
        window.__INITIAL_STATE__,
        window.__PRELOADED_STATE__,
        window.__APP_STATE__,
        window.productData,
      ];
      for (const c of candidates) {
        if (!c) continue;
        const str = typeof c === 'string' ? c : JSON.stringify(c);
        const m = str.match(/"price"\s*:\s*([\d.]+)/);
        if (m) return parseFloat(m[1]);
      }
      return null;
    });
    if (result) return { price: result, price_str: `R ${result.toFixed(2)}` };
  } catch (_) {}
  return null;
}

/**
 * Scrape a single product from Woolworths by barcode.
 */
async function scrapeByBarcode(barcode) {
  const url = `${BASE_URL}/prod/_/A-${barcode}`;
  const scraped_at = new Date().toISOString();

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });

    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-ZA',
      timezoneId: 'Africa/Johannesburg',
    });

    const page = await context.newPage();

    // Block heavy resources to speed things up
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,ico}', (route) =>
      route.abort()
    );

    // Navigate — wait for domcontentloaded which is enough for JSON-LD
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    if (!response || response.status() === 404) {
      return {
        barcode, name: null, brand: null, pack_size: null, image_url: null,
        price: null, price_str: null, url, promo_flag: false, scraped_at,
        retailer: RETAILER,
        error: `HTTP ${response ? response.status() : 'no response'} — product not found`,
      };
    }

    // ── Strategy 1: JSON-LD (fastest — available right after domcontentloaded) ──
    let extracted = await extractFromJsonLd(page);

    // ── Strategy 2: Wait for DOM price selectors ──────────────────────────────
    if (!extracted || !extracted.price) {
      console.log(`[scraper] JSON-LD miss for ${barcode}, waiting for DOM selectors…`);
      const domResult = await extractFromDom(page, 30000);
      if (domResult?.price) {
        extracted = { ...extracted, ...domResult };
      }
    }

    // ── Strategy 3: Page JS state ─────────────────────────────────────────────
    if (!extracted || !extracted.price) {
      console.log(`[scraper] DOM miss for ${barcode}, trying page state…`);
      const stateResult = await extractFromPageState(page);
      if (stateResult?.price) {
        extracted = { ...extracted, ...stateResult };
      }
    }

    // ── Extract name from H1 if still missing ─────────────────────────────────
    let name = extracted?.name || null;
    if (!name) {
      try {
        const h1 = await page.$('h1');
        if (h1) name = (await h1.innerText()).trim() || null;
      } catch (_) {}
    }

    // ── Detect promo ──────────────────────────────────────────────────────────
    let promo_flag = false;
    try {
      const promoEl = await page.$('[class*="promo"], [class*="special"], [class*="sale"]');
      if (promoEl) promo_flag = true;
    } catch (_) {}

    // ── Extract pack_size from name ───────────────────────────────────────────
    let pack_size = null;
    if (name) {
      const match = name.match(/(\d+\s*(?:g|kg|ml|l|L))\b/i);
      if (match) pack_size = match[1];
    }

    const price = extracted?.price || null;
    const price_str = extracted?.price_str || (price ? `R ${price.toFixed(2)}` : null);

    return {
      barcode,
      name,
      brand: extracted?.brand || null,
      pack_size,
      image_url: extracted?.image_url || null,
      price,
      price_str,
      url,
      promo_flag,
      scraped_at,
      retailer: RETAILER,
      error: price ? null : 'Price not found on page',
    };
  } catch (err) {
    return {
      barcode, name: null, brand: null, pack_size: null, image_url: null,
      price: null, price_str: null, url, promo_flag: false, scraped_at,
      retailer: RETAILER,
      error: err.message,
    };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeByBarcode, RETAILER };
