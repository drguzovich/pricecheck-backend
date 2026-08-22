# PriceCheck Web

PriceCheck is a mobile-first Next.js progressive web application for comparing South African grocery prices. The approved PWA source now lives in `drguzovich/pricecheck-app`; the earlier Expo implementation is retained on the repository's `native-expo-archive` branch for reference.

## Included flows

The home page directs people to barcode scanning or product search. The scan screen uses `BarcodeDetector` where the browser supports it and falls back to `@zxing/browser`, while always keeping an accessible manual barcode-entry control. The result screen distinguishes loading, unavailable, not-found, cached/stale, and successful retailer comparison states.

The app ships a manifest, service worker, and generated raster icons for installation from compatible mobile browsers. It caches the static shell only. Price responses remain network-backed so that freshness information is never silently replaced by an old offline result.

## API configuration

The PWA calls the PriceCheck comparison backend from the browser. It defaults to the current Render API for local review. Configure `NEXT_PUBLIC_PRICE_API_URL` in the deployment environment only when pointing the PWA at another HTTPS backend origin.

```bash
pnpm install
pnpm dev
```

`NEXT_PUBLIC_PRICE_API_URL` must be an HTTPS origin in a deployed PWA. The API must permit the PWA origin through CORS and provide the following routes:

| Route | Browser use |
|---|---|
| `GET /price/:barcode` | Retrieves the product and retailer `results` array. |
| `POST /price/:barcode/refresh` | Requests a fresh comparison from the result screen. |
| `GET /search?q=<query>` | Lists product records already known to the API. |
| `POST /product-requests` | Adds a missing barcode and optional product hint to the coverage-retry queue. |

## Build verification

```bash
NODE_ENV=production pnpm build
```

The explicit `NODE_ENV=production` avoids a non-standard sandbox environment value affecting the Next.js build command.

## Deployment

For the approved Manus deployment, create a checkpoint and then use the **Publish** control in the project interface. The deployed origin must use HTTPS for browser camera access and PWA installation. Confirm that the host serves `manifest.json`, `sw.js`, and both PNG icon paths unchanged.
