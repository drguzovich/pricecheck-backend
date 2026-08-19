'use strict';

/**
 * Pick n Pay adapter.
 *
 * The default path reads the public search results that a normal unauthenticated
 * visitor sees. It does not call private APIs or attempt to defeat access
 * controls. Prices can depend on the shopper's delivery area, so this source is
 * explicitly a non-location-specific catalogue price until a store-selection
 * product requirement is introduced.
 *
 * When PNP_PRODUCT_LOOKUP_URL is set, an operator-approved product provider is
 * preferred. The template must contain `{barcode}`. A Parse provider key can
 * alternatively enable the documented Pick n Pay search endpoint with a known
 * product name as its query.
 */

const RETAILER = 'pick_n_pay';
const BASE_URL = 'https://www.pnp.co.za';
const PARSE_SEARCH_URL = 'https://api.parse.bot/scraper/b87810bc-903f-41b8-b38d-c5c911cab324/search_products';
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

function unavailable(barcode, error) {
  return {
    barcode,
    name: null,
    brand: null,
    pack_size: null,
    image_url: null,
    price: null,
    price_str: null,
    url: null,
    promo_flag: false,
    scraped_at: new Date().toISOString(),
    retailer: RETAILER,
    error,
  };
}

function findCandidate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const collections = [
    payload.results,
    payload.products,
    payload.items,
    payload.data?.results,
    payload.data?.products,
    payload.data?.items,
  ];
  for (const collection of collections) {
    if (Array.isArray(collection) && collection.length > 0) return collection[0];
  }
  return payload.product || payload.data?.product || null;
}

function extractPrice(candidate) {
  const raw = candidate?.price?.value ?? candidate?.sellingPrice ?? candidate?.price;
  const numeric = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function hasExactBarcode(candidate, barcode) {
  const directIdentifiers = [candidate?.barcode, candidate?.ean, candidate?.gtin, candidate?.upc];
  if (directIdentifiers.some((identifier) => String(identifier || '') === barcode)) return true;
  const imageUrls = (candidate?.images || []).map((image) => image?.url || image).filter(Boolean);
  return imageUrls.some((url) => String(url).includes(barcode));
}

function parsePrice(raw) {
  if (!raw) return null;
  const match = raw.match(/R\s*([\d\s,.]+)/i);
  if (!match) return null;
  const numeric = Number(match[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

async function lookupApprovedEndpoint(barcode, template, timeoutMs) {
  const url = template.replace('{barcode}', encodeURIComponent(barcode));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) return unavailable(barcode, 'Product not found at Pick n Pay');
    if (!response.ok) return unavailable(barcode, `Pick n Pay source returned HTTP ${response.status}`);

    const candidate = findCandidate(await response.json());
    const price = extractPrice(candidate);
    if (!candidate || !price) return unavailable(barcode, 'Pick n Pay product did not contain a usable price');

    const name = candidate.name ?? candidate.displayName ?? candidate.productName ?? null;
    return {
      barcode,
      name,
      brand: candidate.brand?.name ?? candidate.brand ?? null,
      pack_size: candidate.packSize ?? candidate.size ?? null,
      image_url: candidate.image ?? candidate.imageUrl ?? candidate.images?.[0]?.url ?? null,
      price,
      price_str: `R ${price.toFixed(2)}`,
      url: candidate.url ?? candidate.productUrl ?? null,
      promo_flag: Boolean(candidate.promo ?? candidate.onPromotion ?? candidate.special),
      scraped_at: new Date().toISOString(),
      retailer: RETAILER,
      error: null,
    };
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Pick n Pay request timed out' : `Pick n Pay request failed: ${error.message}`;
    return unavailable(barcode, message);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupParseProvider(barcode, productName, timeoutMs) {
  const apiKey = process.env.PARSE_API_KEY;
  if (!apiKey) return unavailable(barcode, 'Pick n Pay provider key is not configured');

  const query = productName || barcode;
  const url = new URL(PARSE_SEARCH_URL);
  url.searchParams.set('page', '0');
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('query', query);
  url.searchParams.set('page_size', '8');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
      signal: controller.signal,
    });
    if (response.status === 404) return unavailable(barcode, 'Product not found at Pick n Pay');
    if (!response.ok) return unavailable(barcode, `Pick n Pay provider returned HTTP ${response.status}`);

    const payload = await response.json();
    const candidates = payload?.data?.products ?? payload?.products ?? [];
    const normalizedQuery = query.toLowerCase();
    const specificTerms = normalizedQuery
      .replace(/\b\d+\s*(?:g|kg|ml|l)\b/g, ' ')
      .split(/[^a-z]+/)
      .filter((term) => term.length >= 3 && !['rusk', 'rusks', 'buttermilk'].includes(term));
    const candidate = candidates.find((item) => {
      const name = item?.name?.toLowerCase() || '';
      const productNameMatches = name.includes(normalizedQuery) || (specificTerms.length > 0 && specificTerms.every((term) => name.includes(term)));
      return productNameMatches && hasExactBarcode(item, barcode);
    }) ?? null;
    const price = extractPrice(candidate);
    if (!candidate || !price) return unavailable(barcode, 'Pick n Pay provider did not return an exact barcode match with a usable price');

    const name = candidate.name ?? null;
    return {
      barcode,
      name,
      brand: candidate.brand?.name ?? candidate.brand ?? null,
      pack_size: candidate.packSize ?? candidate.size ?? name?.match(/(\d+\s*(?:g|kg|ml|l|L))\b/i)?.[1] ?? null,
      image_url: candidate.images?.[0]?.url ?? candidate.image ?? candidate.imageUrl ?? null,
      price,
      price_str: candidate.price?.formattedValue ?? `R ${price.toFixed(2)}`,
      url: candidate.url ?? candidate.productUrl ?? null,
      promo_flag: Boolean(candidate.potentialPromotions?.length || candidate.promo || candidate.onPromotion || candidate.special),
      scraped_at: new Date().toISOString(),
      retailer: RETAILER,
      error: null,
    };
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Pick n Pay provider request timed out' : `Pick n Pay provider request failed: ${error.message}`;
    return unavailable(barcode, message);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupPublicCatalogue(barcode, timeoutMs) {
  const url = BASE_URL;
  const scraped_at = new Date().toISOString();
  let browser;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-ZA',
      timezoneId: 'Africa/Johannesburg',
    });
    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,ico}', (route) => route.abort());
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response || response.status() >= 400) {
      return unavailable(barcode, `Pick n Pay catalogue returned HTTP ${response?.status() ?? 'no response'}`);
    }

    const searchInput = page.locator('input[name="search"]');
    await searchInput.waitFor({ state: 'visible', timeout: Math.max(1500, Math.floor(timeoutMs / 2)) });
    await searchInput.fill(barcode);
    await searchInput.press('Enter');
    await page.waitForTimeout(1200);
    await page.waitForSelector('a[href*="/p/"]', { timeout: Math.max(1500, Math.floor(timeoutMs / 2)) }).catch(() => null);
    const candidate = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      for (const anchor of anchors) {
        const name = (anchor.textContent || '').trim();
        if (!name) continue;
        let card = anchor.parentElement;
        for (let depth = 0; depth < 5 && card; depth += 1, card = card.parentElement) {
          const text = card.innerText || '';
          if (/R\s*[\d]/.test(text) && text.length < 2500) {
            const image = card.querySelector('img');
            return {
              name,
              text,
              href: anchor.href,
              image_url: image?.currentSrc || image?.src || null,
            };
          }
        }
      }
      return null;
    });

    const price = parsePrice(candidate?.text || '');
    if (!candidate || !price) return unavailable(barcode, 'No priced Pick n Pay product was found for this barcode');
    const packSize = candidate.name.match(/(\d+\s*(?:g|kg|ml|l|L))\b/i)?.[1] ?? null;
    return {
      barcode,
      name: candidate.name,
      brand: null,
      pack_size: packSize,
      image_url: candidate.image_url,
      price,
      price_str: `R ${price.toFixed(2)}`,
      url: candidate.href,
      promo_flag: /\b(save|smart shopper|special|combo)\b/i.test(candidate.text),
      scraped_at,
      retailer: RETAILER,
      error: null,
    };
  } catch (error) {
    return unavailable(barcode, `Pick n Pay public catalogue request failed: ${error.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

async function scrapeByBarcode(barcode, { timeoutMs = 12000, productName = null } = {}) {
  const template = process.env.PNP_PRODUCT_LOOKUP_URL;
  if (template) return lookupApprovedEndpoint(barcode, template, timeoutMs);
  if (process.env.PARSE_API_KEY) return lookupParseProvider(barcode, productName, timeoutMs);
  if (process.env.PNP_PUBLIC_CATALOGUE_ENABLED === 'true') {
    return lookupPublicCatalogue(barcode, timeoutMs);
  }
  return unavailable(barcode, 'Pick n Pay data source is awaiting approved configuration');
}

module.exports = { scrapeByBarcode, RETAILER };
