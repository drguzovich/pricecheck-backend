'use strict';

/**
 * Price service — coordinates scraping and DB persistence.
 * Implements a cache-first strategy: serve the last scraped price
 * and refresh in the background (or on-demand via the refresh endpoint).
 */

const db = require('./db');
const { scrapeByBarcode, RETAILER } = require('./scrapers/woolworths');

// Maximum age of a cached price before it is considered stale (6 hours)
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// ── DB helpers ────────────────────────────────────────────────────────────────

function upsertProduct(data) {
  db.prepare(`
    INSERT INTO products (barcode, name, brand, pack_size, image_url, updated_at)
    VALUES (@barcode, @name, @brand, @pack_size, @image_url, datetime('now'))
    ON CONFLICT(barcode) DO UPDATE SET
      name      = excluded.name,
      brand     = excluded.brand,
      pack_size = excluded.pack_size,
      image_url = excluded.image_url,
      updated_at = datetime('now')
  `).run(data);
}

function insertPrice(data) {
  db.prepare(`
    INSERT INTO retailer_prices (retailer, product_id, price, price_str, scraped_at, url, promo_flag)
    VALUES (@retailer, @product_id, @price, @price_str, @scraped_at, @url, @promo_flag)
  `).run(data);
}

function getLatestPrice(barcode, retailer) {
  return db.prepare(`
    SELECT
      p.barcode,
      p.name,
      p.brand,
      p.pack_size,
      p.image_url,
      rp.retailer,
      rp.price,
      rp.price_str,
      rp.scraped_at,
      rp.url,
      rp.promo_flag
    FROM retailer_prices rp
    JOIN products p ON p.barcode = rp.product_id
    WHERE rp.product_id = ? AND rp.retailer = ?
    ORDER BY rp.scraped_at DESC
    LIMIT 1
  `).get(barcode, retailer);
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Persist a successful scrape result to the DB.
 */
function persistScrapeResult(result) {
  if (!result.price) return; // don't persist failed scrapes

  upsertProduct({
    barcode: result.barcode,
    name: result.name || result.barcode,
    brand: result.brand || null,
    pack_size: result.pack_size || null,
    image_url: result.image_url || null,
  });

  insertPrice({
    retailer: result.retailer,
    product_id: result.barcode,
    price: result.price,
    price_str: result.price_str,
    scraped_at: result.scraped_at,
    url: result.url,
    promo_flag: result.promo_flag ? 1 : 0,
  });
}

/**
 * Scrape and persist; return the result.
 */
async function scrapeAndPersist(barcode) {
  console.log(`[priceService] Scraping ${RETAILER} for barcode ${barcode}...`);
  const result = await scrapeByBarcode(barcode);
  if (result.price) {
    persistScrapeResult(result);
    console.log(`[priceService] Persisted price R ${result.price} for ${barcode}`);
  } else {
    console.warn(`[priceService] Scrape failed for ${barcode}: ${result.error}`);
  }
  return result;
}

/**
 * Get the price for a barcode from Woolworths.
 * Strategy:
 *   1. Check DB for a cached price.
 *   2. If fresh (< CACHE_MAX_AGE_MS), return it immediately.
 *   3. If stale or missing, scrape live and persist.
 */
async function getPrice(barcode) {
  const cached = getLatestPrice(barcode, RETAILER);

  if (cached) {
    const ageMs = Date.now() - new Date(cached.scraped_at).getTime();
    if (ageMs < CACHE_MAX_AGE_MS) {
      console.log(`[priceService] Cache hit for ${barcode} (age ${Math.round(ageMs / 60000)}m)`);
      return { ...cached, from_cache: true };
    }
    // Stale — trigger background refresh but return stale data immediately
    console.log(`[priceService] Cache stale for ${barcode}, refreshing in background`);
    scrapeAndPersist(barcode).catch((e) =>
      console.error(`[priceService] Background refresh failed: ${e.message}`)
    );
    return { ...cached, from_cache: true, stale: true };
  }

  // No cache — must scrape synchronously
  const result = await scrapeAndPersist(barcode);
  if (!result.price) {
    return null; // product not found / scrape failed
  }

  return {
    barcode: result.barcode,
    name: result.name,
    brand: result.brand,
    pack_size: result.pack_size,
    image_url: result.image_url,
    retailer: result.retailer,
    price: result.price,
    price_str: result.price_str,
    scraped_at: result.scraped_at,
    url: result.url,
    promo_flag: result.promo_flag,
    from_cache: false,
  };
}

/**
 * Force a fresh scrape regardless of cache age.
 */
async function forceRefresh(barcode) {
  const result = await scrapeAndPersist(barcode);
  return result;
}

/**
 * Get all barcodes that have been scraped at least once (for scheduled jobs).
 */
function getAllTrackedBarcodes() {
  return db
    .prepare(`SELECT DISTINCT product_id FROM retailer_prices WHERE retailer = ?`)
    .all(RETAILER)
    .map((r) => r.product_id);
}

module.exports = { getPrice, forceRefresh, getAllTrackedBarcodes };
