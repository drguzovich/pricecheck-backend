# PriceCheck Backend — Phase 1

A lightweight Node.js/Express API that scrapes Woolworths South Africa product prices using Playwright (headless Chromium) and caches results in SQLite.

## API Endpoints

### `GET /health`
Returns server health status.

```json
{ "status": "ok", "timestamp": "2024-01-01T12:00:00.000Z" }
```

### `GET /price/:barcode`
Returns the latest Woolworths price for a given EAN-13 barcode.

**Example:** `GET /price/6001069206154`

```json
{
  "product": {
    "barcode": "6001069206154",
    "name": "Rusks: Ouma Buttermilk, 500g",
    "brand": null,
    "pack_size": "500g",
    "image_url": null
  },
  "retailer": "woolworths",
  "price": 24.95,
  "price_str": "R 24.95",
  "scraped_at": "2024-01-01T12:00:00.000Z",
  "url": "https://www.woolworths.co.za/prod/_/A-6001069206154",
  "promo_flag": false,
  "from_cache": true,
  "stale": false
}
```

**404 response (product not found):**
```json
{ "error": "not_found", "message": "No Woolworths listing found for barcode 1234567890123" }
```

### `POST /price/:barcode/refresh`
Force a fresh scrape for a barcode, bypassing the cache.

### `POST /admin/refresh-all`
Trigger a background refresh of all tracked barcodes. Returns 202 immediately.

## Caching Strategy

- First request for a barcode triggers a live scrape (takes ~5–10s)
- Results are cached in SQLite; subsequent requests return instantly
- Cache is considered fresh for **6 hours**
- Stale cache is served immediately while a background refresh runs
- Scheduled cron job refreshes all tracked barcodes every 6 hours

## Database Schema

```sql
products (barcode PK, name, brand, pack_size, image_url, created_at, updated_at)
retailer_prices (id, retailer, product_id FK, price, price_str, scraped_at, url, promo_flag)
```

## Local Development

```bash
npm install
npx playwright install chromium
npm run dev
```

## Deployment (Render)

1. Push to GitHub
2. Create a new Web Service on Render pointing to this repo
3. Build command: `npm install && npx playwright install chromium --with-deps`
4. Start command: `npm start`
5. Add a persistent disk at `/data` (1 GB, free tier)
