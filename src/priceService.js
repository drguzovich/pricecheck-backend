'use strict';

/**
 * Price service: bounded, cache-aware retailer comparison.
 * All monetary values use decimal rands on the backend. Client applications
 * convert to cents before their local ranking and display logic.
 */

const { sql } = require('./db');
const woolworths = require('./scrapers/woolworths');
const pickNPay = require('./scrapers/pnp');
const checkers = require('./scrapers/checkers');

const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const RETAILER_TIMEOUT_MS = Number(process.env.RETAILER_TIMEOUT_MS || 12000);
const RETAILERS = [woolworths, pickNPay, checkers];

async function upsertProduct(data) {
  await sql`
    INSERT INTO products (barcode, name, brand, pack_size, image_url, updated_at)
    VALUES (${data.barcode}, ${data.name}, ${data.brand ?? null}, ${data.pack_size ?? null}, ${data.image_url ?? null}, NOW())
    ON CONFLICT (barcode) DO UPDATE SET
      name = EXCLUDED.name,
      brand = EXCLUDED.brand,
      pack_size = EXCLUDED.pack_size,
      image_url = EXCLUDED.image_url,
      updated_at = NOW()
  `;
}

async function insertPrice(data) {
  await sql`
    INSERT INTO retailer_prices (retailer, product_id, price, price_str, scraped_at, url, promo_flag)
    VALUES (${data.retailer}, ${data.barcode}, ${data.price}, ${data.price_str ?? null}, ${data.scraped_at}, ${data.url ?? null}, ${Boolean(data.promo_flag)})
  `;
}

async function getLatestPrice(barcode, retailer) {
  const rows = await sql`
    SELECT p.barcode, p.name, p.brand, p.pack_size, p.image_url,
           rp.retailer, rp.price, rp.price_str, rp.scraped_at, rp.url, rp.promo_flag
    FROM retailer_prices rp
    JOIN products p ON p.barcode = rp.product_id
    WHERE rp.product_id = ${barcode} AND rp.retailer = ${retailer}
    ORDER BY rp.scraped_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function getKnownProduct(barcode) {
  const rows = await sql`
    SELECT barcode, name, brand, pack_size, image_url
    FROM products
    WHERE barcode = ${barcode}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function unavailable(retailer, barcode, error, extra = {}) {
  return {
    retailer,
    barcode,
    available: false,
    price: null,
    price_str: null,
    updated_at: extra.updated_at ?? null,
    url: extra.url ?? null,
    promo_flag: false,
    from_cache: Boolean(extra.from_cache),
    stale: Boolean(extra.stale),
    error,
  };
}

function available(data, extra = {}) {
  return {
    retailer: data.retailer,
    barcode: data.barcode,
    available: true,
    name: data.name ?? null,
    brand: data.brand ?? null,
    pack_size: data.pack_size ?? null,
    image_url: data.image_url ?? null,
    price: Number(data.price),
    price_str: data.price_str ?? `R ${Number(data.price).toFixed(2)}`,
    updated_at: data.scraped_at ?? data.updated_at,
    url: data.url ?? null,
    promo_flag: Boolean(data.promo_flag),
    from_cache: Boolean(extra.from_cache),
    stale: Boolean(extra.stale),
    error: extra.error ?? null,
  };
}

async function persistResult(result) {
  if (!result.price) return;
  await upsertProduct({
    barcode: result.barcode,
    name: result.name || result.barcode,
    brand: result.brand,
    pack_size: result.pack_size,
    image_url: result.image_url,
  });
  await insertPrice(result);
}

async function boundedScrape(adapter, barcode) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(unavailable(adapter.RETAILER, barcode, `${adapter.RETAILER} request timed out`)),
      RETAILER_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([
      adapter.scrapeByBarcode(barcode, { timeoutMs: RETAILER_TIMEOUT_MS }),
      timeout,
    ]);
    if (!result.price) return unavailable(adapter.RETAILER, barcode, result.error || 'No price found');
    await persistResult(result);
    return available(result);
  } catch (error) {
    return unavailable(adapter.RETAILER, barcode, `${adapter.RETAILER} request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getRetailerPrice(adapter, barcode, { forceRefresh = false } = {}) {
  const cached = forceRefresh ? null : await getLatestPrice(barcode, adapter.RETAILER);
  if (cached) {
    const ageMs = Date.now() - new Date(cached.scraped_at).getTime();
    if (ageMs < CACHE_MAX_AGE_MS) return available(cached, { from_cache: true });
  }

  const fresh = await boundedScrape(adapter, barcode);
  if (fresh.available) return fresh;

  if (cached) {
    return available(cached, {
      from_cache: true,
      stale: true,
      error: fresh.error,
    });
  }
  return fresh;
}

async function getComparison(barcode, { forceRefresh = false } = {}) {
  const results = await Promise.all(
    RETAILERS.map((adapter) =>
      getRetailerPrice(adapter, barcode, { forceRefresh }).catch((error) =>
        unavailable(adapter.RETAILER, barcode, `${adapter.RETAILER} lookup failed: ${error.message}`)
      )
    )
  );

  const knownProduct = await getKnownProduct(barcode);
  const liveProduct = results.find((result) => result.available && result.name);
  const product = {
    barcode,
    name: liveProduct?.name ?? knownProduct?.name ?? null,
    brand: liveProduct?.brand ?? knownProduct?.brand ?? null,
    pack_size: liveProduct?.pack_size ?? knownProduct?.pack_size ?? null,
    image_url: liveProduct?.image_url ?? knownProduct?.image_url ?? null,
  };

  return { barcode, product, results };
}

/** Legacy Expo compatibility: return the top-level Woolworths shape when available. */
async function getPrice(barcode) {
  const comparison = await getComparison(barcode);
  const woolworthsResult = comparison.results.find((result) => result.retailer === woolworths.RETAILER);
  if (!woolworthsResult?.available) return null;
  return {
    ...comparison.product,
    retailer: woolworthsResult.retailer,
    price: woolworthsResult.price,
    price_str: woolworthsResult.price_str,
    scraped_at: woolworthsResult.updated_at,
    url: woolworthsResult.url,
    promo_flag: woolworthsResult.promo_flag,
    from_cache: woolworthsResult.from_cache,
    stale: woolworthsResult.stale,
  };
}

async function forceRefresh(barcode) {
  const comparison = await getComparison(barcode, { forceRefresh: true });
  const woolworthsResult = comparison.results.find((result) => result.retailer === woolworths.RETAILER);
  if (!woolworthsResult?.available) return { price: null, error: woolworthsResult?.error || 'Woolworths unavailable' };
  return {
    ...comparison.product,
    retailer: woolworthsResult.retailer,
    price: woolworthsResult.price,
    price_str: woolworthsResult.price_str,
    scraped_at: woolworthsResult.updated_at,
    url: woolworthsResult.url,
    promo_flag: woolworthsResult.promo_flag,
  };
}

async function forceRefreshComparison(barcode) {
  return getComparison(barcode, { forceRefresh: true });
}

async function searchProducts(query) {
  const rows = await sql`
    SELECT barcode, name, brand, pack_size, image_url
    FROM products
    WHERE name ILIKE ${`%${query}%`} OR brand ILIKE ${`%${query}%`} OR barcode = ${query}
    ORDER BY updated_at DESC
    LIMIT 20
  `;
  return rows;
}

async function getAllTrackedBarcodes() {
  const rows = await sql`SELECT DISTINCT product_id FROM retailer_prices`;
  return rows.map((row) => row.product_id);
}

module.exports = {
  getPrice,
  getComparison,
  forceRefresh,
  forceRefreshComparison,
  searchProducts,
  getAllTrackedBarcodes,
};
