'use strict';

/**
 * Pick n Pay exposes a public, unauthenticated Hybris product endpoint. Product
 * codes and EANs are not interchangeable, so every candidate is identity
 * checked before a price can leave this adapter.
 */
const { chromium } = require('playwright');

const RETAILER = 'pick_n_pay';
const BASE_URL = 'https://www.pnp.co.za';
const PRODUCT_API_BASE = `${BASE_URL}/pnphybris/v2/pnp-spa/products`;
const STORE_CODE = 'WC21'; // Constantia; returned price context is explicit.
const PARSE_SEARCH_URL = 'https://api.parse.bot/scraper/b87810bc-903f-41b8-b38d-c5c911cab324/search_products';
const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process', '--disable-extensions',
];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function unavailable(barcode, error) {
  return {
    barcode, name: null, brand: null, pack_size: null, image_url: null,
    price: null, price_str: null, url: null, promo_flag: false,
    scraped_at: new Date().toISOString(), retailer: RETAILER, available: false, error,
  };
}

function extractPrice(candidate) {
  const raw = candidate?.price?.value ?? candidate?.price?.amount ?? candidate?.sellingPrice ?? candidate?.salePrice ?? candidate?.price;
  const numeric = typeof raw === 'string' ? Number(raw.replace(/[^\d.,]/g, '').replace(',', '.')) : Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function candidateIdentifiers(candidate) {
  if (!candidate || typeof candidate !== 'object') return [];
  const nested = [candidate.baseProduct, candidate.product, candidate.masterProduct].filter((item) => item && typeof item === 'object');
  const direct = [
    candidate.barcode, candidate.ean, candidate.eanCode, candidate.gtin, candidate.upc,
    ...(Array.isArray(candidate.barcodes) ? candidate.barcodes : []),
  ];
  for (const item of nested) direct.push(...candidateIdentifiers(item));
  return direct.map((value) => String(value ?? '').replace(/\D/g, '')).filter(Boolean);
}

function hasExactBarcode(candidate, barcode) {
  return candidateIdentifiers(candidate).includes(String(barcode));
}

function candidateName(candidate) {
  const name = candidate?.name ?? candidate?.displayName ?? candidate?.productName ?? candidate?.baseProduct?.name ?? candidate?.baseProduct?.productName ?? null;
  return typeof name === 'string' ? name.trim() : null;
}

function candidatePack(candidate) {
  const raw = candidate?.packSize ?? candidate?.size ?? candidate?.quantity ?? candidate?.baseProduct?.packSize ?? candidate?.baseProduct?.size ?? null;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return candidateName(candidate)?.match(/(\d+(?:\.\d+)?\s*(?:g|kg|ml|l))\b/i)?.[1] ?? null;
}

function normalisePack(value) {
  const match = String(value || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (match[2] === 'kg') return `${amount * 1000}g`;
  if (match[2] === 'l') return `${amount * 1000}ml`;
  return `${amount}${match[2]}`;
}

function normaliseProductName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Name and pack are search hints only. A candidate must still declare the
 * requested EAN/GTIN before its price can be associated with that barcode.
 */
function hasExactNameAndPack(candidate, product) {
  if (!product?.name || !product?.barcode || !hasExactBarcode(candidate, product.barcode)) return false;
  const requestedPack = normalisePack(product.pack_size) || normalisePack(product.name);
  const foundPack = normalisePack(candidatePack(candidate));
  return Boolean(
    requestedPack && foundPack && requestedPack === foundPack &&
    normaliseProductName(product.name) === normaliseProductName(candidateName(candidate))
  );
}

function productCandidates(payload, found = [], seen = new Set(), depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 10 || seen.has(payload)) return found;
  seen.add(payload);
  if (!Array.isArray(payload) && (candidateName(payload) || candidateIdentifiers(payload).length)) found.push(payload);
  for (const value of Array.isArray(payload) ? payload : Object.values(payload)) productCandidates(value, found, seen, depth + 1);
  return found;
}

function findVerifiedCandidate(payload, barcode, product = null) {
  const candidates = productCandidates(payload);
  // Product wording and pack size guide name-based search only; neither can
  // prove that a returned retailer listing belongs to the requested barcode.
  return candidates.find((candidate) => hasExactBarcode(candidate, barcode)) || null;
}

function productUrl(code) {
  const url = new URL(`${PRODUCT_API_BASE}/${encodeURIComponent(code)}`);
  url.searchParams.set('storeCode', STORE_CODE);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('curr', 'ZAR');
  url.searchParams.set('fields', 'FULL');
  return url.toString();
}

function resultFromCandidate(barcode, candidate, sourceUrl) {
  // Defend every available result at the final conversion boundary too. This
  // prevents a future caller from assigning an unlabelled result to the EAN.
  if (!hasExactBarcode(candidate, barcode)) return null;
  const price = extractPrice(candidate);
  if (!price) return null;
  const name = candidateName(candidate);
  const image = candidate?.image ?? candidate?.imageUrl ?? candidate?.images?.[0]?.url ?? candidate?.images?.[0] ?? null;
  return {
    barcode,
    name,
    brand: candidate?.brand?.name ?? candidate?.brand ?? candidate?.baseProduct?.brand ?? null,
    pack_size: candidatePack(candidate),
    image_url: typeof image === 'string' ? image : null,
    price,
    price_str: candidate?.price?.formattedValue ?? `R ${price.toFixed(2)}`,
    url: candidate?.url ?? candidate?.productUrl ?? sourceUrl,
    promo_flag: Boolean(candidate?.potentialPromotions?.length || candidate?.promo || candidate?.onPromotion || candidate?.special),
    scraped_at: new Date().toISOString(),
    retailer: RETAILER,
    store_code: STORE_CODE,
    available: true,
    error: null,
  };
}

async function fetchPublicProduct(code, barcode, product, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = productUrl(code);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const candidate = findVerifiedCandidate(payload, barcode, product);
    return candidate ? resultFromCandidate(barcode, candidate, url) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupApprovedEndpoint(barcode, template, product, timeoutMs) {
  const url = template.replace('{barcode}', encodeURIComponent(barcode));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return unavailable(barcode, `Pick n Pay configured source returned HTTP ${response.status}`);
    const candidate = findVerifiedCandidate(await response.json(), barcode, product);
    const result = candidate && resultFromCandidate(barcode, candidate, url);
    return result || unavailable(barcode, 'Pick n Pay configured source did not return a verified exact product');
  } catch (error) {
    return unavailable(barcode, error.name === 'AbortError' ? 'Pick n Pay request timed out' : `Pick n Pay request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupParseProvider(barcode, product, timeoutMs) {
  const apiKey = process.env.PARSE_API_KEY;
  if (!apiKey) return null;
  const query = product?.name || barcode;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(PARSE_SEARCH_URL);
    url.search = new URLSearchParams({ page: '0', query, page_size: '20' });
    const response = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return unavailable(barcode, `Pick n Pay provider returned HTTP ${response.status}`);
    const candidate = findVerifiedCandidate(await response.json(), barcode, product);
    const result = candidate && resultFromCandidate(barcode, candidate, url.toString());
    return result || unavailable(barcode, 'Pick n Pay provider did not return a verified exact product');
  } catch (error) {
    return unavailable(barcode, error.name === 'AbortError' ? 'Pick n Pay provider request timed out' : `Pick n Pay provider request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function interceptSearch(query, barcode, product, timeoutMs) {
  let browser;
  const payloads = [];
  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 }, locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' });
    const page = await context.newPage();
    page.on('response', async (response) => {
      const request = response.request();
      const resourceType = request.resourceType();
      if (!response.url().includes('/pnphybris/v2/pnp-spa/') || !['xhr', 'fetch'].includes(resourceType)) return;
      try { payloads.push(await response.json()); } catch (_) {}
    });
    await page.goto(`${BASE_URL}/search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const input = page.locator('input[name="search"], input[type="search"], input[placeholder*="Search" i]').first();
    if (await input.count()) {
      await input.fill(query);
      await input.press('Enter');
    }
    await page.waitForTimeout(Math.min(1500, Math.max(250, Math.floor(timeoutMs / 5))));
    for (const payload of payloads) {
      const candidate = findVerifiedCandidate(payload, barcode, product);
      const result = candidate && resultFromCandidate(barcode, candidate, null);
      if (result) return result;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

async function lookupPublicCatalogue(barcode, product, timeoutMs) {
  // First, query the documented unauthenticated endpoint by requested EAN.
  const direct = await fetchPublicProduct(barcode, barcode, product, Math.max(1000, Math.floor(timeoutMs / 3)));
  if (direct) return direct;

  // The PnP SPA makes v2 XHR/fetch calls. Search the exact EAN first, then only
  // exact name + pack metadata; intercepted JSON is identity-checked above.
  const eanSearch = await interceptSearch(barcode, barcode, product, Math.max(1000, Math.floor(timeoutMs / 3)));
  if (eanSearch) return eanSearch;
  if (product?.name && (normalisePack(product.pack_size) || normalisePack(product.name))) {
    const nameSearch = await interceptSearch(product.name, barcode, product, Math.max(1000, Math.floor(timeoutMs / 3)));
    if (nameSearch) return nameSearch;
  }
  return unavailable(barcode, `No verified Pick n Pay match for EAN ${barcode} at ${STORE_CODE}; nearby variants are not substituted`);
}

async function scrapeByBarcode(barcode, { timeoutMs = 15000, productName = null, product = null } = {}) {
  const hint = product || (productName ? { barcode, name: productName, pack_size: null } : null);
  const template = process.env.PNP_PRODUCT_LOOKUP_URL;
  if (template) return lookupApprovedEndpoint(barcode, template, hint, timeoutMs);
  const publicResult = await lookupPublicCatalogue(barcode, hint, timeoutMs);
  if (publicResult.available) return publicResult;
  // Preserve the approved internal provider as an optional, still-strict
  // fallback. It cannot turn a similarly named product into an EAN match.
  const providerResult = await lookupParseProvider(barcode, hint, Math.max(1000, Math.floor(timeoutMs / 3)));
  return providerResult || publicResult;
}

module.exports = {
  RETAILER,
  STORE_CODE,
  candidateIdentifiers,
  findVerifiedCandidate,
  hasExactBarcode,
  hasExactNameAndPack,
  normalisePack,
  scrapeByBarcode,
};
