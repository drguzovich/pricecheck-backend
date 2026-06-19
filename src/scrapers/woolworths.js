'use strict';

/**
 * Woolworths scraper
 * Scrapes product name and price from woolworths.co.za product pages.
 * The site is JS-rendered so we use Playwright (headless Chromium).
 *
 * URL pattern: https://www.woolworths.co.za/prod/_/A-{barcode}
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
 * Scrape a single product from Woolworths by barcode.
 *
 * @param {string} barcode - EAN-13 barcode
 * @returns {Promise<{
 *   barcode: string,
 *   name: string|null,
 *   brand: string|null,
 *   pack_size: string|null,
 *   image_url: string|null,
 *   price: number|null,
 *   price_str: string|null,
 *   url: string,
 *   promo_flag: boolean,
 *   scraped_at: string,
 *   retailer: string,
 *   error: string|null
 * }>}
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

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    if (!response || response.status() === 404) {
      return {
        barcode,
        name: null,
        brand: null,
        pack_size: null,
        image_url: null,
        price: null,
        price_str: null,
        url,
        promo_flag: false,
        scraped_at,
        retailer: RETAILER,
        error: `HTTP ${response ? response.status() : 'no response'} — product not found`,
      };
    }

    // Wait for price element
    await page.waitForSelector('span.price, .product-price, [class*="Price"]', {
      timeout: 15000,
    });

    // ── 1. Try JSON-LD structured data first (most reliable) ──────────────────
    let name = null;
    let brand = null;
    let price = null;
    let price_str = null;
    let image_url = null;
    let promo_flag = false;

    const jsonLdScripts = await page.$$('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const text = await script.innerText();
        const data = JSON.parse(text);
        if (data['@type'] === 'Product') {
          name = data.name || null;
          brand = data.brand?.name || null;
          image_url = Array.isArray(data.image) ? data.image[0] : data.image || null;

          const offers = Array.isArray(data.offers) ? data.offers[0] : data.offers;
          if (offers && offers.price) {
            price = parseFloat(offers.price);
            price_str = `R ${offers.price}`;
          }
          break;
        }
      } catch (_) {
        // ignore parse errors
      }
    }

    // ── 2. Fall back to DOM selectors ─────────────────────────────────────────
    if (!price) {
      const priceSelectors = [
        'span.price',
        '.product-price',
        '[class*="Price"]',
        '[class*="price"]',
        'strong.price',
      ];
      for (const sel of priceSelectors) {
        try {
          const els = await page.$$(sel);
          for (const el of els) {
            const text = (await el.innerText()).trim();
            if (text && /R\s*\d/.test(text)) {
              price_str = text;
              price = parsePrice(text);
              break;
            }
          }
          if (price) break;
        } catch (_) {
          // ignore
        }
      }
    }

    if (!name) {
      try {
        const h1 = await page.$('h1');
        if (h1) name = (await h1.innerText()).trim() || null;
      } catch (_) {
        // ignore
      }
    }

    // ── 3. Detect promo / special price ──────────────────────────────────────
    try {
      const promoEl = await page.$('[class*="promo"], [class*="special"], [class*="sale"]');
      if (promoEl) promo_flag = true;
    } catch (_) {
      // ignore
    }

    // ── 4. Extract pack_size from name if present ─────────────────────────────
    let pack_size = null;
    if (name) {
      const match = name.match(/(\d+\s*(?:g|kg|ml|l|L))\b/i);
      if (match) pack_size = match[1];
    }

    return {
      barcode,
      name,
      brand,
      pack_size,
      image_url,
      price,
      price_str: price_str || (price ? `R ${price.toFixed(2)}` : null),
      url,
      promo_flag,
      scraped_at,
      retailer: RETAILER,
      error: price ? null : 'Price not found on page',
    };
  } catch (err) {
    return {
      barcode,
      name: null,
      brand: null,
      pack_size: null,
      image_url: null,
      price: null,
      price_str: null,
      url,
      promo_flag: false,
      scraped_at,
      retailer: RETAILER,
      error: err.message,
    };
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeByBarcode, RETAILER };
