'use strict';

/**
 * Public PnP OCC v2 search is a read-only POST, not GET. The current anonymous
 * storefront uses WC21 Constantia and X-Pnp-Cache-Key: anonymous. Article codes,
 * image filenames, similar names and unit EANs on case packs are not substitutes
 * for the requested product's exact EAN. No proxy is used by this adapter.
 */
const { chromium } = require('playwright');
const { performance } = require('node:perf_hooks');

const RETAILER = 'pick_n_pay';
const BASE_URL = 'https://www.pnp.co.za';
const PRODUCT_API_BASE = `${BASE_URL}/pnphybris/v2/pnp-spa/products`;
const STORE_CODE = 'WC21';
const STORE_NAME = 'Pick n Pay Constantia';
const PARSE_SEARCH_URL = 'https://api.parse.bot/scraper/b87810bc-903f-41b8-b38d-c5c911cab324/search_products';
const BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-extensions'];
const PUBLIC_HEADERS = { Accept: 'application/json', 'X-Pnp-Cache-Key': 'anonymous', 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' };

function unavailable(barcode, error, diagnostics = []) {
  return {
    barcode, name: null, brand: null, pack_size: null, image_url: null,
    price: null, price_str: null, url: null, promo_flag: false,
    scraped_at: new Date().toISOString(), retailer: RETAILER, available: false,
    store_code: STORE_CODE, store_name: STORE_NAME, error, diagnostics,
  };
}

function barcodeValue(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return null;
  const text = String(value).trim();
  return /^\d{8,14}$/.test(text) ? text : null;
}

function gtinChecksumValid(value) {
  const text = String(value);
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text)) return false;
  let sum = 0;
  for (let i = text.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(text[i]) * weight;
  return (10 - sum % 10) % 10 === Number(text[text.length - 1]);
}

function candidateIdentifiers(candidate) {
  if (!candidate || typeof candidate !== 'object') return [];
  const direct = [candidate.barcode, candidate.ean, candidate.eanCode, candidate.gtin, candidate.upc,
    ...(Array.isArray(candidate.barcodes) ? candidate.barcodes : [])];
  // A product detail's own labelled classification is identity evidence. Do not
  // borrow a parent/master/other variant's EAN or infer one from image URLs.
  for (const classification of Array.isArray(candidate.classifications) ? candidate.classifications : []) {
    for (const feature of Array.isArray(classification?.features) ? classification.features : []) {
      const label = String(feature?.name || '').toLowerCase().replace(/[ -]/g, '_');
      const casePack = /_CS$/i.test(candidate.code || '');
      if (!['barcode', 'ean', 'ean_code', 'gtin', ...(casePack ? ['case_barcode'] : ['unit_barcode'])].includes(label)) continue;
      direct.push(...(Array.isArray(feature.featureValues) ? feature.featureValues : []).map((item) => item?.value));
    }
  }
  return [...new Set(direct.map(barcodeValue).filter(Boolean))];
}

function hasExactBarcode(candidate, barcode) {
  return candidateIdentifiers(candidate).includes(String(barcode));
}

function candidateName(candidate) {
  const name = candidate?.name ?? candidate?.displayName ?? candidate?.productName ?? null;
  return typeof name === 'string' ? name.trim() : null;
}

function candidatePack(candidate) {
  const raw = candidate?.packSize ?? candidate?.size ?? candidate?.quantity ?? null;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return candidateName(candidate)?.match(/(\d+(?:\.\d+)?\s*(?:g|kg|ml|l))\b/i)?.[1] ?? null;
}

function normalisePack(value) {
  const match = String(value || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return `${amount * (['kg', 'l'].includes(match[2]) ? 1000 : 1)}${['kg', 'g'].includes(match[2]) ? 'g' : 'ml'}`;
}

function normaliseProductName(value) {
  return String(value || '').toLowerCase().replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function hasExactNameAndPack(candidate, product) {
  const requestedPack = normalisePack(product?.pack_size) || normalisePack(product?.name);
  return Boolean(product?.name && product?.barcode && hasExactBarcode(candidate, product.barcode) && requestedPack &&
    requestedPack === normalisePack(candidatePack(candidate)) &&
    normaliseProductName(product.name) === normaliseProductName(candidateName(candidate)));
}

function productCandidates(payload, found = [], seen = new Set(), depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 10 || seen.has(payload)) return found;
  seen.add(payload);
  if (Array.isArray(payload)) {
    for (const value of payload) productCandidates(value, found, seen, depth + 1);
  } else {
    if (candidateName(payload) || candidateIdentifiers(payload).length) found.push(payload);
    for (const key of ['products', 'product', 'data', 'results', 'items', 'baseProduct', 'variants', 'variantOptions']) {
      productCandidates(payload[key], found, seen, depth + 1);
    }
  }
  return found;
}

function extractPrice(candidate) {
  const currency = candidate?.price?.currencyIso ?? candidate?.price?.currency ?? candidate?.currency;
  if (currency && currency !== 'ZAR') return null;
  const raw = candidate?.price?.value ?? candidate?.price?.amount ?? candidate?.sellingPrice ?? candidate?.salePrice ?? candidate?.price;
  // Do not coerce null, booleans, empty text or arbitrary formatted text to money.
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const text = typeof raw === 'string' ? raw.trim().replace(/^R\s*/, '') : raw;
  if (typeof text === 'string' && !/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
  const price = Number(typeof text === 'string' ? text.replace(',', '.') : text);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function findVerifiedCandidate(payload, barcode) {
  const candidates = productCandidates(payload).filter((item) => hasExactBarcode(item, barcode));
  return candidates.find((item) => extractPrice(item) !== null) || candidates[0] || null;
}

function productUrl(code) {
  const url = new URL(`${PRODUCT_API_BASE}/${encodeURIComponent(code)}`);
  url.search = new URLSearchParams({ storeCode: STORE_CODE, lang: 'en', curr: 'ZAR', fields: 'FULL' });
  return url.toString();
}

function searchUrl(query) {
  const url = new URL(`${PRODUCT_API_BASE}/search`);
  url.search = new URLSearchParams({ query, pageSize: '20', currentPage: '0', storeCode: STORE_CODE, lang: 'en', curr: 'ZAR', fields: 'FULL' });
  return url.toString();
}

function resultFromCandidate(barcode, candidate, sourceUrl, storeCode = null) {
  if (!hasExactBarcode(candidate, barcode)) return null;
  const price = extractPrice(candidate);
  if (!price || candidate.available === false || candidate.purchasable === false ||
    candidate.stock?.stockLevelStatus === 'outOfStock' || /_KGM$/i.test(candidate.code || '') ||
    /^(?:WEIGHED|WEIGHTED|WEIGHT)$/i.test(candidate.quantityType || '')) return null;
  const image = candidate?.image ?? candidate?.imageUrl ?? candidate?.images?.find((item) => item?.format === 'product')?.url ?? candidate?.images?.[0]?.url ?? null;
  const declaredStore = candidate.store_code ?? candidate.storeCode ?? candidate.store?.code ?? null;
  if (storeCode && declaredStore && storeCode !== declaredStore) return null;
  const sourceStore = storeCode || declaredStore;
  const brand = candidate.brand?.name ?? candidate.brand ?? null;
  const promotion = (Array.isArray(candidate.potentialPromotions) ? candidate.potentialPromotions : []).some((item) => item?.valid === true) ||
    candidate.promo === true || candidate.onPromotion === true || candidate.special === true;
  // Configured endpoint templates may carry credentials in query strings. Only
  // a known public PnP source URL may leave the adapter unchanged.
  let publicSource = null;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.origin === BASE_URL && !parsed.username && !parsed.password &&
      [...parsed.searchParams.keys()].every((key) => ['storeCode', 'lang', 'curr', 'fields', 'query', 'pageSize', 'currentPage', 'sponsoredProductsMode'].includes(key))) publicSource = sourceUrl;
  } catch (_) {}
  let url = null;
  try {
    const raw = candidate.url || candidate.productUrl || publicSource;
    if (raw) {
      const parsed = new URL(raw, BASE_URL);
      if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.toString();
    }
  } catch (_) {}
  return {
    barcode, name: candidateName(candidate), brand: typeof brand === 'string' ? brand : null,
    pack_size: candidatePack(candidate), image_url: typeof image === 'string' ? image : null,
    price, price_str: `R ${price.toFixed(2)}`, url, promo_flag: promotion,
    scraped_at: new Date().toISOString(), retailer: RETAILER,
    store_code: sourceStore, store_name: sourceStore === STORE_CODE ? STORE_NAME : null,
    source_url: publicSource, price_context: sourceStore ? 'store_specific' : 'source_store_unspecified',
    available: true, error: null,
  };
}

function remaining(scope) { return Math.max(0, Math.floor(scope.deadline - performance.now())); }
function record(scope, stage, status, extra = {}) { scope.diagnostics.push({ stage, status, ...extra }); }

async function requestJson(scope, url, stage, { method = 'GET', headers = {}, body, maxMs = 4000, official = false } = {}) {
  if (scope.controller.signal.aborted || remaining(scope) < 1) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  scope.controller.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, Math.min(maxMs, remaining(scope))));
  const source = official ? { source_url: url, store_code: STORE_CODE } : {};
  record(scope, stage, 'request_started', { method, ...source });
  try {
    const response = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body, signal: controller.signal });
    let payload;
    try { payload = await response.json(); } catch (_) {
      record(scope, stage, 'invalid_json', { http_status: response.status, ...source }); return null;
    }
    if (!response.ok) {
      record(scope, stage, 'http_error', { http_status: response.status,
        source_error_type: typeof payload?.errors?.[0]?.type === 'string' ? payload.errors[0].type.slice(0,80) : null, ...source });
      return null;
    }
    record(scope, stage, 'json_received', { http_status: response.status,
      ...(Number.isFinite(payload?.pagination?.totalResults) ? { total_results: payload.pagination.totalResults } : {}), ...source });
    return payload;
  } catch (error) {
    record(scope, stage, controller.signal.aborted ? 'cancelled_or_deadline' : 'network_error', source);
    return null;
  } finally {
    clearTimeout(timer);
    scope.controller.signal.removeEventListener('abort', abort);
  }
}

async function inspectPayload(scope, payload, barcode, product, sourceUrl, official) {
  const exact = findVerifiedCandidate(payload, barcode);
  const result = exact && resultFromCandidate(barcode, exact, sourceUrl, official ? STORE_CODE : null);
  if (result) return result;
  if (!official) {
    record(scope, 'identity', exact ? 'exact_product_without_usable_price' : 'no_exact_ean'); return null;
  }
  const candidates = productCandidates(payload);
  // Search responses often omit EAN. Resolve a bounded set of returned article
  // codes to FULL product details; details still need their own exact identity.
  const pack = normalisePack(product?.pack_size) || normalisePack(product?.name);
  const articles = candidates.filter((item) => /^\d{18}_EA$/.test(item.code || '') &&
    (!product?.name || (normaliseProductName(candidateName(item)) === normaliseProductName(product.name) &&
      (!pack || normalisePack(candidatePack(item)) === pack))));
  for (const code of [...new Set(articles.map((item) => item.code))].slice(0, 4)) {
    if (remaining(scope) < 250 || scope.controller.signal.aborted) break;
    const url = productUrl(code);
    const detail = await requestJson(scope, url, 'article_detail', { headers: PUBLIC_HEADERS, official: true, maxMs: 1500 });
    const match = findVerifiedCandidate(detail, barcode);
    const verified = match && resultFromCandidate(barcode, match, url, STORE_CODE);
    if (verified) return verified;
    record(scope, 'article_identity', match ? 'exact_product_without_usable_price' : 'no_exact_ean', { article_code: code });
  }
  record(scope, 'identity', exact ? 'exact_product_without_usable_price' : 'no_exact_ean');
  return null;
}

async function interceptSearch(scope, barcode) {
  if (remaining(scope) < 1200 || scope.controller.signal.aborted) return null;
  let browser;
  const tasks = new Set();
  const close = () => { if (browser) void browser.close().catch(() => {}); };
  scope.controller.signal.addEventListener('abort', close, { once: true });
  try {
    browser = await chromium.launch({ headless: true, args: BROWSER_ARGS, timeout: Math.max(1, Math.min(3000, remaining(scope))) });
    if (scope.controller.signal.aborted) return null;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-ZA', timezoneId: 'Africa/Johannesburg', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const request = route.request();
      const thirdParty = !request.url().startsWith(`${BASE_URL}/`) && !request.url().startsWith('https://js.paymentsos.com/');
      return ['image', 'font', 'media'].includes(request.resourceType()) || thirdParty ? route.abort() : route.continue();
    });
    let found = null;
    let receivedSearch = false;
    page.on('response', (response) => {
      const url = response.url();
      if (!url.startsWith(`${PRODUCT_API_BASE}/`) || !['xhr', 'fetch'].includes(response.request().resourceType())) return;
      const task = (async () => {
        try {
          const parsedUrl = new URL(url);
          const search = parsedUrl.pathname.endsWith('/search') && parsedUrl.searchParams.get('query') === barcode;
          // Ignore suggestions, recommendations, unrelated queries and another
          // store's prices. Capture the actual POST search response, not a sleep.
          if (!search || parsedUrl.searchParams.get('storeCode') !== STORE_CODE) return;
          const payload = await response.json();
          receivedSearch = true;
          record(scope, 'browser_occ_search', response.ok() ? 'json_received' : 'http_error', {
            http_status: response.status(), source_url: url, store_code: STORE_CODE,
            total_results: payload?.pagination?.totalResults ?? null,
          });
          if (response.ok()) found = await inspectPayload(scope, payload, barcode, null, url, true);
        } catch (_) { record(scope, 'browser_occ_search', 'response_unreadable'); }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
    const response = await page.goto(`${BASE_URL}/search/${encodeURIComponent(barcode)}`, {
      waitUntil: 'commit', timeout: Math.max(1, Math.min(4000, remaining(scope))),
    });
    record(scope, 'browser_navigation', 'http_response', { http_status: response?.status() ?? null });
    while (remaining(scope) > 100 && !scope.controller.signal.aborted && !receivedSearch) {
      await page.waitForTimeout(Math.min(100, remaining(scope)));
    }
    if (tasks.size && remaining(scope) > 0) await Promise.allSettled([...tasks]);
    if (!receivedSearch) record(scope, 'browser_occ_search', 'no_search_response_before_deadline');
    return found;
  } catch (_) {
    record(scope, 'browser', scope.controller.signal.aborted ? 'cancelled_or_deadline' : 'navigation_or_launch_failed');
    return null;
  } finally {
    scope.controller.signal.removeEventListener('abort', close);
    if (browser) void browser.close().catch(() => {});
  }
}

async function lookupPublicCatalogue(scope, barcode, product) {
  const url = searchUrl(barcode);
  const payload = await requestJson(scope, url, 'ean_search', {
    method: 'POST', headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json' }, body: '{}', official: true,
  });
  if (payload) {
    const result = await inspectPayload(scope, payload, barcode, null, url, true);
    if (result) return result;
  }
  if (product?.name && remaining(scope) > 300 && !scope.controller.signal.aborted) {
    const nameUrl = searchUrl(product.name);
    const named = await requestJson(scope, nameUrl, 'name_hint_search', {
      method: 'POST', headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json' }, body: '{}', official: true, maxMs: 2500,
    });
    if (named) {
      const result = await inspectPayload(scope, named, barcode, product, nameUrl, true);
      if (result) return result;
    }
  }
  // A successfully parsed empty catalogue response is a source result, not a
  // reason to cold-launch another browser and exhaust the caller's deadline.
  if (!payload) return interceptSearch(scope, barcode);
  return null;
}

async function lookupConfigured(scope, barcode, product, template) {
  let url;
  try {
    url = new URL(template.replace('{barcode}', encodeURIComponent(barcode)));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe source');
  } catch (_) { record(scope, 'configured_source', 'invalid_https_url'); return null; }
  const official = url.origin === BASE_URL && url.searchParams.get('storeCode') === STORE_CODE &&
    [...url.searchParams.keys()].every((key) => ['storeCode', 'lang', 'curr', 'fields', 'query', 'pageSize', 'currentPage', 'sponsoredProductsMode'].includes(key));
  const payload = await requestJson(scope, url.toString(), 'configured_source', { official, maxMs: remaining(scope) });
  return payload && inspectPayload(scope, payload, barcode, product, url.toString(), official);
}

async function lookupParseProvider(scope, barcode, product) {
  if (!process.env.PARSE_API_KEY || remaining(scope) < 250 || scope.controller.signal.aborted) return null;
  const url = new URL(PARSE_SEARCH_URL);
  url.search = new URLSearchParams({ page: '0', query: product?.name || barcode, page_size: '20' });
  const payload = await requestJson(scope, url.toString(), 'approved_provider', {
    headers: { 'X-API-Key': process.env.PARSE_API_KEY }, maxMs: 2500,
  });
  return payload && inspectPayload(scope, payload, barcode, product, url.toString(), false);
}

function failureResult(scope, barcode) {
  const empty = scope.diagnostics.find((item) => item.stage === 'ean_search' && item.status === 'json_received' && item.total_results === 0);
  const detail = scope.diagnostics.map((item) => `${item.stage}: ${item.status}${item.http_status ? ` HTTP ${item.http_status}` : ''}${item.source_error_type ? ` ${item.source_error_type}` : ''}`).join('; ');
  const reason = scope.cancelledByCaller ? 'Lookup cancelled by caller' : empty ?
    `Public OCC search returned zero products for exact EAN ${barcode} at ${STORE_CODE} Constantia` :
    `No verified exact Pick n Pay product with a usable price for EAN ${barcode} at ${STORE_CODE} Constantia`;
  return unavailable(barcode, `${reason}; nearby variants are not substituted${detail ? `. ${detail}` : ''}`, [...scope.diagnostics]);
}

async function scrapeByBarcode(barcode, { timeoutMs = 15000, productName = null, product = null, signal = null } = {}) {
  barcode = String(barcode);
  if (!barcodeValue(barcode)) return unavailable(barcode, 'Pick n Pay lookup requires an exact 8 to 14 digit barcode');
  const budget = Number.isFinite(Number(timeoutMs)) ? Math.min(15000, Math.max(1, Number(timeoutMs))) : 15000;
  // Return ahead of the outer 15s caller race. All stages and optional fallback
  // share this one deadline; no fresh timeout budget is added after public work.
  const scope = { controller: new AbortController(), deadline: performance.now() + Math.max(1, budget - Math.min(100, budget / 10)), diagnostics: [], cancelledByCaller: false };
  const onCallerAbort = () => { scope.cancelledByCaller = true; scope.controller.abort(); };
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => scope.controller.abort(), Math.max(1, remaining(scope)));
  const cancelled = new Promise((resolve) => {
    if (scope.controller.signal.aborted) resolve(null);
    else scope.controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });
  const hint = product || (productName ? { barcode, name: productName, pack_size: null } : null);
  try {
    const work = (async () => {
      if (scope.controller.signal.aborted) return null;
      const template = process.env.PNP_PRODUCT_LOOKUP_URL;
      if (template) return lookupConfigured(scope, barcode, hint, template);
      const publicResult = await lookupPublicCatalogue(scope, barcode, hint);
      return publicResult || lookupParseProvider(scope, barcode, hint);
    })();
    const result = await Promise.race([work, cancelled]);
    return result || failureResult(scope, barcode);
  } catch (_) {
    record(scope, 'lookup', 'unexpected_source_failure');
    return failureResult(scope, barcode);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
    scope.controller.abort();
  }
}

module.exports = {
  RETAILER, STORE_CODE, STORE_NAME, candidateIdentifiers, findVerifiedCandidate,
  hasExactBarcode, hasExactNameAndPack, normalisePack, gtinChecksumValid,
  extractPrice, resultFromCandidate, searchUrl, productUrl, scrapeByBarcode,
};
