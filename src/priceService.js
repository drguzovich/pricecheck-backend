'use strict';

/**
 * Price service: bounded, cache-aware retailer comparison.
 * All monetary values use decimal rands on the backend. Client applications
 * convert to cents before their local ranking and display logic.
 */

const { sql, isDatabaseConfigured, getProductRequest, recordProductRequestOutcome,
  recordComparisonCheck, withDatabaseLock } = require('./db');
const woolworths = require('./scrapers/woolworths');
const pickNPay = require('./scrapers/pnp');
const checkers = require('./scrapers/checkers');
const spar = require('./scrapers/spar');
const { getProductMetadata } = require('./productMetadata');

const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
// Managed retailer providers can take longer than direct product documents on
// a cold request. Keep a finite service-wide budget while allowing those
// providers enough time to return a verified exact match.
const configuredTimeout = Number(process.env.RETAILER_TIMEOUT_MS || 15000);
const RETAILER_TIMEOUT_MS = Number.isFinite(configuredTimeout) ? Math.min(45000, Math.max(1000, configuredTimeout)) : 15000;
const RETAILERS = [woolworths, pickNPay, checkers, spar];

const refreshes = new Map();

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

async function getCachedComparisonRows(barcode) {
  return sql`
    SELECT requested.barcode, p.name, p.brand, p.pack_size, p.image_url,
           rp.retailer, rp.price, rp.price_str, rp.scraped_at, rp.url, rp.promo_flag,
           wc.last_checked_at, wc.availability AS last_check_availability, wc.results AS last_check_results
    FROM (SELECT ${barcode}::TEXT AS barcode) requested
    LEFT JOIN products p ON p.barcode = requested.barcode
    LEFT JOIN (
      SELECT DISTINCT ON (retailer)
             retailer, product_id, price, price_str, scraped_at, url, promo_flag
      FROM retailer_prices
      WHERE product_id = ${barcode}
      ORDER BY retailer, scraped_at DESC, id DESC
    ) rp ON rp.product_id = requested.barcode
    LEFT JOIN watchlist_checks wc ON wc.barcode = requested.barcode
  `;
}

function cachedRetailerObservation(retailer, priceRow, latestCheck) {
  const observation = Array.isArray(latestCheck?.last_check_results)
    ? latestCheck.last_check_results.find((result) => result.retailer === retailer)
    : null;
  const failed = latestCheck?.last_check_availability === 'failed';
  if (failed || observation?.available === false) {
    // A cached negative carried through a mixed comparison is not a new check
    // of this retailer. Preserve its original check time, just like price ages.
    const checkedAt = !failed && observation.from_cache && observation.updated_at
      ? observation.updated_at : latestCheck.last_checked_at;
    const checkedMs = new Date(checkedAt).getTime();
    const priceMs = priceRow ? new Date(priceRow.scraped_at).getTime() : NaN;
    if (Number.isFinite(checkedMs) && checkedAt && (!Number.isFinite(priceMs) || checkedMs >= priceMs)) {
      // History remains in retailer_prices, but is never returned as a current
      // available offer after a newer unavailable/failed check.
      return { available: false, updated_at: checkedAt,
        error: failed ? 'Latest price check failed' : 'No price found in latest check' };
    }
  }
  return priceRow ?? null;
}

function unavailable(retailer, barcode, error, extra = {}) {
  const updatedAt = extra.updated_at ?? null;
  return {
    retailer,
    barcode,
    available: false,
    price: null,
    price_str: null,
    currency: 'ZAR',
    updated_at: updatedAt,
    updatedAt,
    url: extra.url ?? null,
    promo_flag: false,
    from_cache: Boolean(extra.from_cache),
    stale: Boolean(extra.stale),
    error,
  };
}

function available(data, extra = {}) {
  const updatedAt = data.scraped_at ?? data.updated_at;
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
    currency: 'ZAR',
    updated_at: updatedAt,
    updatedAt,
    url: data.url ?? null,
    promo_flag: Boolean(data.promo_flag),
    from_cache: Boolean(extra.from_cache),
    stale: Boolean(extra.stale),
    error: extra.error ?? null,
  };
}

async function persistResult(result) {
  if (!isDatabaseConfigured()) return;
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

async function boundedScrape(adapter, barcode, product = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(unavailable(adapter.RETAILER, barcode, `${adapter.RETAILER} request timed out`)),
      RETAILER_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([
      adapter.scrapeByBarcode(barcode, {
        timeoutMs: RETAILER_TIMEOUT_MS,
        productName: product?.name ?? null,
        product,
      }),
      timeout,
    ]);
    if (!Number.isFinite(Number(result.price)) || Number(result.price) <= 0) return unavailable(adapter.RETAILER, barcode, result.error || 'No price found');
    await persistResult(result);
    return available(result);
  } catch (error) {
    return unavailable(adapter.RETAILER, barcode, `${adapter.RETAILER} request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function cacheIsStale(cacheEntry) {
  const updatedAt = cacheEntry.scraped_at ?? cacheEntry.updated_at;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  return !Number.isFinite(ageMs) || ageMs >= CACHE_MAX_AGE_MS;
}

async function getRetailerPrice(adapter, barcode, { forceRefresh = false, cached = null, product = null } = {}) {
  const cacheEntry = forceRefresh ? null : cached;
  if (cacheEntry) {
    const updatedAt = cacheEntry.scraped_at ?? cacheEntry.updated_at;
    const extra = { from_cache: true, stale: cacheIsStale(cacheEntry) };
    if (cacheEntry.available === false) {
      return unavailable(adapter.RETAILER, barcode, cacheEntry.error, { ...extra, updated_at: updatedAt });
    }
    return available(cacheEntry, extra);
  }

  const fresh = await boundedScrape(adapter, barcode, product);
  if (fresh.available) return fresh;
  return fresh;
}

async function getComparison(barcode, { forceRefresh = false, adapters = RETAILERS, productMetadata = undefined, productHint: suppliedHint = null } = {}) {
  const cacheEnabled = isDatabaseConfigured();
  const cachedRows = forceRefresh || !cacheEnabled ? [] : await getCachedComparisonRows(barcode);
  const cachedByRetailer = new Map(
    cachedRows.filter((row) => row.retailer).map((row) => [row.retailer, row])
  );
  const knownProduct = cachedRows.find((row) => row.name) ?? (cacheEnabled ? await getKnownProduct(barcode) : null);
  const namedHint = suppliedHint?.name ? { ...suppliedHint, barcode } : null;
  const metadataProduct = knownProduct || namedHint ? null : productMetadata === undefined
    ? await getProductMetadata(barcode)
    : productMetadata;
  const requestedProduct = cacheEnabled && !knownProduct && !metadataProduct ? await getProductRequest(barcode) : null;
  // A tester can add a label and pack size for a barcode that public metadata
  // does not know. Reuse that hint on the next lookup so retailer providers can
  // search by a meaningful product name while still requiring an exact EAN.
  const requestHintProduct = requestedProduct?.product_hint
    ? { barcode, name: requestedProduct.product_hint, brand: null, pack_size: null, image_url: null }
    : null;
  const productHint = knownProduct ?? metadataProduct ?? namedHint ?? requestHintProduct;
  const cachedObservations = new Map(adapters.map((adapter) => [adapter.RETAILER,
    cachedRetailerObservation(adapter.RETAILER, cachedByRetailer.get(adapter.RETAILER), cachedRows[0])]));
  const hasCacheMiss = adapters.some((adapter) => !cachedObservations.get(adapter.RETAILER));
  const hasStaleCache = [...cachedObservations.values()].some((entry) => entry && cacheIsStale(entry));
  // Cache misses and stale background work share the same barcode coordinator
  // as worker/manual refreshes. The forced inner comparison performs the actual
  // bounded retailer calls; it does not recursively read or refresh this cache.
  let refresh;
  const refreshComparison = () => {
    if (!refresh) refresh = forceRefreshComparison(barcode, {
      adapters, productMetadata: null,
      productHint: productHint ? { barcode, name: productHint.name,
        brand: productHint.brand ?? null, pack_size: productHint.pack_size ?? null,
        image_url: productHint.image_url ?? null } : null,
    });
    return refresh;
  };
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const cached = cachedObservations.get(adapter.RETAILER);
      if (!forceRefresh && hasStaleCache && !cached) {
        // No observation exists for this retailer. Do not invent an offer or
        // hold the stale response while the shared background refresh runs.
        return unavailable(adapter.RETAILER, barcode, 'Price refresh in progress');
      }
      if (!forceRefresh && hasCacheMiss && !hasStaleCache) {
        // A foreground refresh may supersede even a previously fresh cached
        // offer. Return its coherent results, not a pre-refresh cache mixture.
        const freshComparison = await refreshComparison();
        return freshComparison.results.find((result) => result.retailer === adapter.RETAILER)
          ?? unavailable(adapter.RETAILER, barcode, 'Retailer was not included in the active refresh');
      }
      return getRetailerPrice(adapter, barcode, { forceRefresh, cached, product: productHint });
    })
  );
  const results = settled.map((outcome, index) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : unavailable(adapters[index].RETAILER, barcode, `${adapters[index].RETAILER} lookup failed: ${outcome.reason?.message || 'unknown error'}`)
  );

  if (!forceRefresh && results.some((result) => result.from_cache && result.stale)) {
    // Return explicitly stale facts immediately; at most one whole-barcode
    // background refresh may scrape, under the shared advisory lock.
    refreshComparison().catch((error) => {
      if (error.code !== 'REFRESH_IN_PROGRESS') {
        console.error(`[priceService] Background refresh failed for ${barcode}: ${error.message}`);
      }
    });
  }

  const liveProduct = results.find((result) => result.available && result.name);
  const product = {
    barcode,
    name: liveProduct?.name ?? productHint?.name ?? null,
    brand: liveProduct?.brand ?? productHint?.brand ?? null,
    pack_size: liveProduct?.pack_size ?? productHint?.pack_size ?? null,
    image_url: liveProduct?.image_url ?? productHint?.image_url ?? null,
  };

  if (requestedProduct && cacheEnabled && forceRefresh) {
    recordProductRequestOutcome(barcode, results).catch((error) => {
      console.error(`[priceService] Unable to record product-request outcome for ${barcode}: ${error.message}`);
    });
  }

  const comparison = { barcode, product, results };
  // Reading cached prices is not a new provider check. Source timestamps retain
  // their original age; the coordinated forced lookup records its own check.
  if (cacheEnabled && forceRefresh) {
    await recordComparisonCheck(barcode, comparison);
  }
  return comparison;
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
  const comparison = await forceRefreshComparison(barcode);
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

function forceRefreshComparison(barcode, options = {}) {
  if (refreshes.has(barcode)) return refreshes.get(barcode);
  const operation = (async () => {
    if (!isDatabaseConfigured()) return getComparison(barcode, { ...options, forceRefresh: true });
    const locked = await withDatabaseLock(71002, barcode, () => getComparison(barcode, { ...options, forceRefresh: true }));
    if (!locked.acquired) {
      const error = new Error('This product is already being refreshed. Please try again shortly.');
      error.code = 'REFRESH_IN_PROGRESS';
      throw error;
    }
    return locked.result;
  })();
  const promise = operation.finally(() => { refreshes.delete(barcode); });
  refreshes.set(barcode, promise);
  return promise;
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
  const rows = await sql`
    SELECT barcode
    FROM (
      SELECT DISTINCT product_id AS barcode FROM retailer_prices
      UNION
      SELECT barcode FROM product_requests
      UNION
      SELECT barcode FROM favourites
      UNION
      SELECT barcode FROM price_alerts WHERE active = TRUE
      UNION
      SELECT barcode FROM products
    ) AS tracked_barcodes
  `;
  return rows.map((row) => row.barcode);
}

module.exports = {
  getPrice,
  getComparison,
  forceRefresh,
  forceRefreshComparison,
  searchProducts,
  getAllTrackedBarcodes,
};
