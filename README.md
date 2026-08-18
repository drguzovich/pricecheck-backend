# PriceCheck Backend

PriceCheck Backend is an Express service that returns a single, typed grocery-price comparison for a barcode. It uses Neon Postgres for product and price history, keeps retailer cache freshness explicit, and bounds individual retailer lookups so an unavailable source cannot indefinitely block the client.

## API

| Route | Purpose |
|---|---|
| `GET /health` | Returns basic service health and a timestamp. |
| `GET /price/:barcode` | Returns one product and a `results` array covering every configured retailer. The legacy top-level Woolworths fields are retained for the Expo Phase 1 client. |
| `POST /price/:barcode/refresh` | Requests fresh retailer data while preserving the same response shape. |
| `GET /search?q=<text>` | Searches products previously captured by the service. |
| `POST /admin/refresh-all` | Schedules a refresh for the tracked barcode set and returns `202`. Protect this endpoint before a public production launch. |

Barcodes must contain 8 to 14 digits. A `404` is returned when no retailer has an available result. A temporary service failure returns `503` rather than pretending that a product is unavailable.

```json
{
  "barcode": "6001069206154",
  "product": {
    "barcode": "6001069206154",
    "name": "Rusks: Ouma Buttermilk, 500g",
    "brand": null,
    "pack_size": "500g",
    "image_url": null
  },
  "results": [
    {
      "retailer": "woolworths",
      "available": true,
      "price": 24.95,
      "price_str": "R 24.95",
      "updated_at": "2026-08-18T12:00:00.000Z",
      "from_cache": false,
      "stale": false,
      "error": null
    },
    {
      "retailer": "pick_n_pay",
      "available": false,
      "price": null,
      "updated_at": null,
      "error": "Pick n Pay data source is awaiting approved configuration"
    }
  ]
}
```

## Retailer sources and freshness

The service uses a four-hour freshness window and stores price values as Postgres `NUMERIC` values. Each result explicitly identifies `available`, `from_cache`, `stale`, `updated_at`, and any retrieval error. The default per-retailer timeout is 12 seconds and can be set through `RETAILER_TIMEOUT_MS`.

| Retailer | Current connection | Operational note |
|---|---|---|
| Woolworths | Public product-page lookup through Playwright. | A returned stale cache remains visible and identifies that status to the client. |
| Pick n Pay | Adapter is implemented. An approved provider can be configured with `PNP_PRODUCT_LOOKUP_URL`. | The public-catalogue fallback is disabled by default because barcode validation needs to be proven for the relevant deployment/store context. Enable only with `PNP_PUBLIC_CATALOGUE_ENABLED=true` after validation. |
| Checkers | Explicit unavailable adapter. | Do not enable an integration until an approved product-data source and terms review are in place. |

Retailer grocery pricing and availability can vary by delivery area or store. The current API does not accept a store or location parameter, so its catalogue results are not location-specific.

## Data model

```sql
products (barcode PK, name, brand, pack_size, image_url, created_at, updated_at)
retailer_prices (id, retailer, product_id FK, price, price_str, scraped_at, url, promo_flag)
```

## Environment

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | Neon Postgres connection string. |
| `RETAILER_TIMEOUT_MS` | No | Bounded timeout per retailer lookup; defaults to `12000`. |
| `PNP_PRODUCT_LOOKUP_URL` | No | Approved Pick n Pay product data URL containing `{barcode}`. |
| `PNP_PUBLIC_CATALOGUE_ENABLED` | No | Enables the experimental public-page lookup only after product/barcode validation. |
| `PLAYWRIGHT_BROWSERS_PATH` | Render configuration | Path used by the Render build cache for Chromium. |

## Local development

```bash
npm ci
npx playwright install chromium
npm run dev
```

The service will not start without `DATABASE_URL`. Use a non-production Neon database for local development.

## Render deployment

The repository includes `render.yaml`. It installs Chromium into the configured cache path and expects `DATABASE_URL` to be provided through Render’s secret environment settings. The cron-based refresh loop is best-effort on a free or autoscaling service; it should not be the only freshness mechanism for a production promise.
