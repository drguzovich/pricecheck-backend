'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');

const { getPrice, forceRefresh, getAllTrackedBarcodes } = require('./priceService');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── GET /price/:barcode ───────────────────────────────────────────────────────
/**
 * Returns the latest Woolworths price for a given EAN-13 barcode.
 *
 * Success response:
 * {
 *   product: { barcode, name, brand, pack_size, image_url },
 *   retailer: "woolworths",
 *   price: 24.95,
 *   price_str: "R 24.95",
 *   scraped_at: "2024-01-01T12:00:00.000Z",
 *   url: "https://www.woolworths.co.za/prod/...",
 *   promo_flag: false,
 *   from_cache: true
 * }
 *
 * Not found response (404):
 * { error: "not_found", message: "..." }
 */
app.get('/price/:barcode', async (req, res) => {
  const { barcode } = req.params;

  // Basic EAN-13 validation (13 digits)
  if (!/^\d{8,14}$/.test(barcode)) {
    return res.status(400).json({
      error: 'invalid_barcode',
      message: 'Barcode must be 8–14 digits',
    });
  }

  try {
    const data = await getPrice(barcode);

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        message: `No Woolworths listing found for barcode ${barcode}`,
      });
    }

    return res.json({
      product: {
        barcode: data.barcode,
        name: data.name,
        brand: data.brand,
        pack_size: data.pack_size,
        image_url: data.image_url,
      },
      retailer: data.retailer,
      price: data.price,
      price_str: data.price_str,
      scraped_at: data.scraped_at,
      url: data.url,
      promo_flag: Boolean(data.promo_flag),
      from_cache: data.from_cache,
      stale: data.stale || false,
    });
  } catch (err) {
    console.error(`[server] Error fetching price for ${barcode}:`, err);
    return res.status(500).json({
      error: 'scrape_error',
      message: err.message,
    });
  }
});

// ── POST /price/:barcode/refresh ──────────────────────────────────────────────
/**
 * Force a fresh scrape for a barcode, bypassing cache.
 * Useful for manual refresh or testing.
 */
app.post('/price/:barcode/refresh', async (req, res) => {
  const { barcode } = req.params;

  if (!/^\d{8,14}$/.test(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }

  try {
    const result = await forceRefresh(barcode);

    if (!result.price) {
      return res.status(404).json({
        error: 'not_found',
        message: result.error || `Product not found for barcode ${barcode}`,
      });
    }

    return res.json({
      product: {
        barcode: result.barcode,
        name: result.name,
        brand: result.brand,
        pack_size: result.pack_size,
        image_url: result.image_url,
      },
      retailer: result.retailer,
      price: result.price,
      price_str: result.price_str,
      scraped_at: result.scraped_at,
      url: result.url,
      promo_flag: Boolean(result.promo_flag),
      from_cache: false,
    });
  } catch (err) {
    console.error(`[server] Refresh error for ${barcode}:`, err);
    return res.status(500).json({ error: 'scrape_error', message: err.message });
  }
});

// ── POST /admin/refresh-all ───────────────────────────────────────────────────
/**
 * Manually trigger a refresh of all tracked barcodes.
 * Responds immediately with 202 Accepted; runs in background.
 */
app.post('/admin/refresh-all', (req, res) => {
  const barcodes = getAllTrackedBarcodes();
  console.log(`[admin] refresh-all triggered for ${barcodes.length} barcodes`);

  // Fire and forget
  (async () => {
    for (const barcode of barcodes) {
      try {
        await forceRefresh(barcode);
        console.log(`[admin] Refreshed ${barcode}`);
      } catch (e) {
        console.error(`[admin] Failed to refresh ${barcode}: ${e.message}`);
      }
    }
    console.log('[admin] refresh-all complete');
  })();

  return res.status(202).json({
    message: `Refresh triggered for ${barcodes.length} barcode(s)`,
    barcodes,
  });
});

// ── Scheduled job: refresh all tracked prices every 6 hours ──────────────────
cron.schedule('0 */6 * * *', async () => {
  const barcodes = getAllTrackedBarcodes();
  console.log(`[cron] Scheduled refresh for ${barcodes.length} barcodes`);
  for (const barcode of barcodes) {
    try {
      await forceRefresh(barcode);
    } catch (e) {
      console.error(`[cron] Failed to refresh ${barcode}: ${e.message}`);
    }
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] PriceCheck backend running on port ${PORT}`);
  console.log(`[server] Health: http://localhost:${PORT}/health`);
  console.log(`[server] Price:  http://localhost:${PORT}/price/:barcode`);
});

module.exports = app;
