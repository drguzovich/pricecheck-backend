'use strict';

/**
 * Price service — coordinates scraping and DB persistence.
 * Implements a cache-first strategy: serve the last scraped price
 * and refresh in the background (or on-demand via the refresh endpoint).
 *
 * All DB calls are async (postgres.js tagged-template queries).
 */

const { sql } = require('./db');
const { scrapeByBarcode, RETAILER } = require('./scrapers/woolworths');

// Maximum age of a cached price before it is considered stale (6 hours)
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// ── DB helpers ────────────────────────────────────────────────────────────────

async function upsertProduct(data) {
  await sql`
    INSERT INTO products (barcode, name, brand, pack_size, image_url, updated_at)
    VALUES (
      ${data.barcode},
      ${data.name},
      ${data.brand   ?? null},
      ${data.pack_size ?? null},
      ${data.image_url ?? null},
      NOW()
    )
    ON CONFLICT (barcode) DO UPDATE SET
      name       = EXCLUDED.name,
      brand      = EXCLUDED.brand,
      pack_size  = EXCLUDED.pack_size,
      image_url  = EXCLUDED.image_url,
      updated_at = NOW()
  `;
}

async function insertPrice(data) {
  await sql`
    INSERT INTO retailer_prices
      (retailer, product_id, price, price_str, scraped_at, url, promo_flag)
    VALUES (
      ${data.retailer},
      ${data.product_id},
      ${data.price},
      ${data.price_str   ?? null},
      ${data.scraped_at},
      ${data.url         ?? null},
      ${data.promo_flag  ?? false}
    )
  `;
}

async function getLatestPrice(barcode, retailer) {
  const rows = await sql`
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
    WHERE rp.product_id = ${barcode}
      AND rp.retailer   = ${retailer}
    ORDER BY rp.scraped_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Persist a successful scrape result to the DB.
 */
async function persistScrapeResult(result) {
  if (!result.price) return; // don't persist failed scrapes

  await upsertProduct({
    barcode:   result.barcode,
    name:      result.name || result.barcode,
    brand:     result.brand     || null,
    pack_size: result.pack_size || null,
    image_url: result.image_url || null,
  });

  await insertPrice({
    retailer:   result.retailer,
    product_id: result.barcode,
    price:      result.price,
    price_str:  result.price_str,
    scraped_at: result.scraped_at,
    url:        result.url,
    promo_flag: result.promo_flag ? true : false,
  });
}

/**
 * Scrape and persist; return the result.
 */
async function scrapeAndPersist(barcode) {
  console.log(`[priceService] Scraping ${RETAILER} for barcode ${barcode}...`);
  const result = await scrapeByBarcode(barcode);
  if (result.price) {
    await persistScrapeResult(result);
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
  const cached = await getLatestPrice(barcode, RETAILER);

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
    barcode:    result.barcode,
    name:       result.name,
    brand:      result.brand,
    pack_size:  result.pack_size,
    image_url:  result.image_url,
    retailer:   result.retailer,
    price:      result.price,
    price_str:  result.price_str,
    scraped_at: result.scraped_at,
    url:        result.url,
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
async function getAllTrackedBarcodes() {
  const rows = await sql`
    SELECT DISTINCT product_id
    FROM retailer_prices
    WHERE retailer = ${RETAILER}
  `;
  return rows.map((r) => r.product_id);
}

module.exports = { getPrice, forceRefresh, getAllTrackedBarcodes };
