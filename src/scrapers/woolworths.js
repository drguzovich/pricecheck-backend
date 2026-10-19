'use strict';

/**
 * Woolworths product pages expose product state publicly. Every extraction path
 * below is tied to the requested product identifier; no broad page-price scan
 * is used because recommendation cards can otherwise leak a different price.
 */
const { chromium } = require('playwright');

const RETAILER = 'woolworths';
const BASE_URL = 'https://www.woolworths.co.za';
const BROWSER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--no-first-run', '--no-zygote', '--single-process', '--disable-extensions',
];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^\d.,]/g, '').replace(',', '.');
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function identifierEquals(value, barcode) {
  return String(value ?? '').replace(/\D/g, '') === String(barcode);
}

function productIdMatches(candidate, barcode) {
  if (!candidate || typeof candidate !== 'object') return false;
  const identifiers = [
    candidate.productId, candidate.product_id, candidate.productID, candidate.sku,
    candidate.productCode, candidate.product_code, candidate.ean, candidate.gtin,
    candidate.gtin13, candidate.barcode, candidate.code,
  ];
  return identifiers.some((value) => identifierEquals(value, barcode));
}

function readStatePrice(candidate) {
  const priceFields = [
    candidate.SalePrice, candidate.salePrice, candidate.currentPrice, candidate.price,
    candidate.Price, candidate.prices?.SalePrice, candidate.prices?.salePrice,
    candidate.prices?.currentPrice, candidate.priceInfo?.salePrice,
  ];
  for (const raw of priceFields) {
    const price = parsePrice(raw?.value ?? raw?.amount ?? raw);
    if (price !== null) return price;
  }
  return null;
}

function readImage(candidate) {
  const image = candidate.imageUrl ?? candidate.image_url ?? candidate.image ?? candidate.images?.[0]?.url ?? candidate.images?.[0];
  return typeof image === 'string' ? image : null;
}

function stateProduct(candidate, barcode) {
  // Woolworths currently places the identity in pdp.productInfo but can keep
  // SalePrice in its enclosing PDP slice. Treat that enclosing slice as the
  // record only when its nested productInfo has the requested exact identifier.
  const identity = productIdMatches(candidate, barcode)
    ? candidate
    : productIdMatches(candidate?.productInfo, barcode)
      ? candidate.productInfo
      : null;
  if (!identity) return null;
  const price = readStatePrice(candidate) ?? readStatePrice(identity);
  if (price === null) return null;
  const name = identity.productName ?? identity.name ?? identity.title ?? candidate.productName ?? candidate.name ?? candidate.title ?? null;
  return {
    name: typeof name === 'string' ? name.trim() || null : null,
    brand: identity.brand?.name ?? identity.brandName ?? identity.brand ?? candidate.brand?.name ?? candidate.brandName ?? candidate.brand ?? null,
    price,
    price_str: `R ${price.toFixed(2)}`,
    image_url: readImage(identity) || readImage(candidate),
    product_url: identity.url ?? candidate.url ?? null,
    provenance: 'initial_state',
  };
}

function findStateProduct(value, barcode, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 14 || seen.has(value)) return null;
  seen.add(value);
  const direct = stateProduct(value, barcode);
  if (direct) return direct;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values) {
    const found = findStateProduct(child, barcode, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

function scriptBodies(html) {
  return [...String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1].trim()).filter(Boolean);
}

function balancedJsonObject(source, start) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

/** Parse JSON script payloads and public window initial-state assignments. */
function parseInitialStateProduct(html, barcode) {
  for (const body of scriptBodies(html)) {
    try {
      const parsed = JSON.parse(body);
      const found = findStateProduct(parsed, barcode);
      if (found) return found;
    } catch (_) {
      // A script can contain JS plus state. Try the explicitly public state key.
    }
    const marker = body.search(/(?:window\.)?(?:__INITIAL_STATE__|__PRELOADED_STATE__|__APP_STATE__)\s*=\s*\{/);
    if (marker >= 0) {
      const objectStart = body.indexOf('{', marker);
      const objectText = balancedJsonObject(body, objectStart);
      if (objectText) {
        try {
          const found = findStateProduct(JSON.parse(objectText), barcode);
          if (found) return found;
        } catch (_) {
          // Non-JSON JavaScript state is intentionally ignored rather than guessed.
        }
      }
    }
  }
  return null;
}

function getJsonLdProduct(data, barcode) {
  const candidates = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
  for (const candidate of candidates) {
    const types = Array.isArray(candidate?.['@type']) ? candidate['@type'] : [candidate?.['@type']];
    if (!types.includes('Product') || !productIdMatches(candidate, barcode)) continue;
    const offer = Array.isArray(candidate.offers) ? candidate.offers[0] : candidate.offers;
    const price = parsePrice(offer?.price);
    if (price === null) continue;
    return {
      name: candidate.name || null,
      brand: candidate.brand?.name || null,
      price,
      price_str: `R ${price.toFixed(2)}`,
      image_url: Array.isArray(candidate.image) ? candidate.image[0] : candidate.image || null,
      product_url: offer?.url || candidate.url || candidate['@id'] || null,
      provenance: 'json_ld',
    };
  }
  return null;
}

async function fetchDocumentProduct(url, barcode, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-ZA,en;q=0.9' },
      signal: controller.signal,
    });
    if (response.status === 404) return { notFound: true, product: null };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const stateProductResult = parseInitialStateProduct(html, barcode);
    if (stateProductResult) return { notFound: false, product: stateProductResult };
    const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const script of scripts) {
      try {
        const product = getJsonLdProduct(JSON.parse(script[1]), barcode);
        if (product) return { notFound: false, product };
      } catch (_) {}
    }
    return { notFound: false, product: null };
  } finally {
    clearTimeout(timer);
  }
}

async function extractFromPageState(page, barcode) {
  const html = await page.content();
  return parseInitialStateProduct(html, barcode);
}

async function extractFromJsonLd(page, barcode) {
  const scripts = await page.$$eval('script[type="application/ld+json"]', (elements) => elements.map((element) => element.textContent));
  for (const text of scripts) {
    try {
      const product = getJsonLdProduct(JSON.parse(text), barcode);
      if (product) return product;
    } catch (_) {}
  }
  return null;
}

function unavailable(barcode, url, scraped_at, error) {
  return { barcode, name: null, brand: null, pack_size: null, image_url: null, price: null, price_str: null, url, promo_flag: false, scraped_at, retailer: RETAILER, error };
}

function successfulResult(barcode, url, scraped_at, product) {
  const pack_size = product.name?.match(/(\d+(?:\.\d+)?\s*(?:g|kg|ml|l))\b/i)?.[1] || null;
  return {
    barcode,
    name: product.name,
    brand: typeof product.brand === 'string' ? product.brand : product.brand?.name ?? null,
    pack_size,
    image_url: product.image_url,
    price: product.price,
    price_str: product.price_str,
    url: product.product_url || url,
    promo_flag: false,
    scraped_at,
    retailer: RETAILER,
    provenance: product.provenance,
    error: null,
  };
}

async function scrapeByBarcode(barcode, { timeoutMs = 15000 } = {}) {
  const url = `${BASE_URL}/prod/_/A-${barcode}`;
  const scraped_at = new Date().toISOString();
  let browser;
  try {
    const documentResult = await fetchDocumentProduct(url, barcode, Math.max(1000, Math.floor(timeoutMs * 0.45)));
    if (documentResult.notFound) return unavailable(barcode, url, scraped_at, 'HTTP 404 — product not found');
    if (documentResult.product) return successfulResult(barcode, url, scraped_at, documentResult.product);

    // The fallback is deliberately reachable: server-rendered documents may omit
    // state while the browser-populated product state remains public.
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS });
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 800 }, locale: 'en-ZA', timezoneId: 'Africa/Johannesburg' });
    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,ico}', (route) => route.abort());
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, Math.floor(timeoutMs * 0.55)) });
    if (!response || response.status() === 404) return unavailable(barcode, url, scraped_at, `HTTP ${response ? response.status() : 'no response'} — product not found`);

    const product = await extractFromPageState(page, barcode) || await extractFromJsonLd(page, barcode);
    if (!product) return unavailable(barcode, url, scraped_at, 'No matching product-id-scoped Woolworths price was found');
    return successfulResult(barcode, url, scraped_at, product);
  } catch (error) {
    return unavailable(barcode, url, scraped_at, error.message);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { RETAILER, extractFromPageState, getJsonLdProduct, parseInitialStateProduct, scrapeByBarcode };
