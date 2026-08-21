'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const { createRateLimiter } = require('./rateLimit');

const { initSchema, recordProductRequest } = require('./db');
const {
  getComparison,
  forceRefreshComparison,
  searchProducts,
  getAllTrackedBarcodes,
} = require('./priceService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());

const rateLimitWindowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitMaxRequests = Number(process.env.API_RATE_LIMIT_MAX_REQUESTS || 30);
const priceRequestLimiter = createRateLimiter({
  windowMs: rateLimitWindowMs,
  maxRequests: rateLimitMaxRequests,
});
app.use((req, res, next) => (req.path === '/health' ? next() : priceRequestLimiter(req, res, next)));

function validBarcode(barcode) {
  return /^\d{8,14}$/.test(barcode);
}

function comparisonResponse(comparison, legacy) {
  return {
    ...comparison,
    // Legacy fields keep the existing Expo client functional while the PWA
    // reads the canonical `results` array.
    retailer: legacy?.retailer ?? null,
    price: legacy?.price ?? null,
    price_str: legacy?.price_str ?? null,
    scraped_at: legacy?.scraped_at ?? null,
    url: legacy?.url ?? null,
    promo_flag: legacy?.promo_flag ?? false,
    from_cache: legacy?.from_cache ?? false,
    stale: legacy?.stale ?? false,
  };
}

function woolworthsLegacy(comparison) {
  const result = comparison.results.find((item) => item.retailer === 'woolworths');
  if (!result?.available) return null;
  return {
    retailer: result.retailer,
    price: result.price,
    price_str: result.price_str,
    scraped_at: result.updated_at,
    url: result.url,
    promo_flag: result.promo_flag,
    from_cache: result.from_cache,
    stale: result.stale,
  };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/price/:barcode', async (req, res) => {
  const { barcode } = req.params;
  if (!validBarcode(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }

  try {
    const comparison = await getComparison(barcode);
    const legacy = woolworthsLegacy(comparison);
    const hasAvailableResult = comparison.results.some((result) => result.available);
    if (!hasAvailableResult) {
      return res.status(404).json({
        error: 'not_found',
        message: `No retailer listing found for barcode ${barcode}`,
        ...comparisonResponse(comparison, legacy),
      });
    }
    return res.json(comparisonResponse(comparison, legacy));
  } catch (error) {
    console.error(`[server] Comparison error for ${barcode}:`, error);
    return res.status(503).json({ error: 'comparison_unavailable', message: 'Price comparison is temporarily unavailable' });
  }
});

app.post('/price/:barcode/refresh', async (req, res) => {
  const { barcode } = req.params;
  if (!validBarcode(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }

  try {
    const comparison = await forceRefreshComparison(barcode);
    const legacy = woolworthsLegacy(comparison);
    const hasAvailableResult = comparison.results.some((result) => result.available);
    if (!hasAvailableResult) {
      return res.status(404).json({ error: 'not_found', message: `No fresh retailer listing found for barcode ${barcode}`, ...comparisonResponse(comparison, legacy) });
    }
    return res.json(comparisonResponse(comparison, legacy));
  } catch (error) {
    console.error(`[server] Refresh error for ${barcode}:`, error);
    return res.status(503).json({ error: 'comparison_unavailable', message: 'Unable to refresh prices right now' });
  }
});

app.get('/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.status(400).json({ error: 'invalid_query', message: 'Search query must contain at least 2 characters' });
  try {
    return res.json({ query, results: await searchProducts(query) });
  } catch (error) {
    console.error('[server] Search error:', error);
    return res.status(503).json({ error: 'search_unavailable', message: 'Search is temporarily unavailable' });
  }
});

app.post('/product-requests', async (req, res) => {
  const barcode = String(req.body?.barcode || '').replace(/\D/g, '');
  const productHint = typeof req.body?.product_hint === 'string' ? req.body.product_hint.trim() : '';
  if (!validBarcode(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }
  if (productHint.length > 140) {
    return res.status(400).json({ error: 'invalid_product_hint', message: 'Product hint must be 140 characters or fewer' });
  }

  try {
    const request = await recordProductRequest(barcode, productHint);
    return res.status(201).json({
      message: 'Product request saved for coverage review',
      request,
    });
  } catch (error) {
    console.error(`[server] Unable to save product request for ${barcode}:`, error);
    return res.status(503).json({ error: 'request_unavailable', message: 'Unable to save the product request right now' });
  }
});

app.post('/admin/refresh-all', async (_req, res) => {
  const requiredToken = process.env.ADMIN_REFRESH_TOKEN;
  const providedToken = _req.get('x-admin-refresh-token');
  if (!requiredToken || providedToken !== requiredToken) {
    return res.status(404).json({ error: 'not_found' });
  }
  const barcodes = await getAllTrackedBarcodes();
  (async () => {
    for (const barcode of barcodes) {
      try { await forceRefreshComparison(barcode); }
      catch (error) { console.error(`[admin] Refresh failed for ${barcode}: ${error.message}`); }
    }
  })();
  return res.status(202).json({ message: `Refresh triggered for ${barcodes.length} barcode(s)`, barcodes });
});

cron.schedule('0 */6 * * *', async () => {
  const barcodes = await getAllTrackedBarcodes();
  for (const barcode of barcodes) {
    try { await forceRefreshComparison(barcode); }
    catch (error) { console.error(`[cron] Refresh failed for ${barcode}: ${error.message}`); }
  }
});

(async () => {
  try {
    await initSchema();
    app.listen(PORT, () => console.log(`[server] PriceCheck backend listening on ${PORT}`));
  } catch (error) {
    console.error('[server] Failed to initialise database schema:', error);
    process.exit(1);
  }
})();

module.exports = app;
