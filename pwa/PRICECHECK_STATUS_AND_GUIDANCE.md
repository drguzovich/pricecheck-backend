# PriceCheck: Status and Guidance Required

**Project:** PriceCheck South African grocery comparison PWA  
**Status:** Core web PWA and comparison backend built; full customer-product scope remains incomplete pending user-account, catalogue, location-pricing, and release decisions.

## Executive summary

The core Next.js PWA and price-comparison backend are complete and have been pushed to the private [`drguzovich/pricecheck-app`](https://github.com/drguzovich/pricecheck-app) repository. The legacy Expo source is preserved on the `native-expo-archive` branch. The product is not yet a complete customer offering because it has no user-account system, does not yet ingest complete retailer catalogues, and cannot show branch-specific SPAR prices.

## Completed work

| Area | Completed work | Notes |
|---|---|---|
| **Application foundation** | Replaced the legacy Expo source with the Next.js PWA and preserved the native source on `native-expo-archive`. | The PWA is prepared for Manus-hosted deployment. |
| **Customer flows** | Implemented Home, Search, Scan, and Result routes; manual barcode entry; local recent searches; and PWA install/update controls. | Recent searches are local to the browser/device, not a cloud user profile. |
| **Barcode scanning** | Implemented automatic rear-camera opening, `BarcodeDetector` with a ZXing fallback, a compact horizontal scanning band, curved-bottle guidance, and manual fallback. | Further hardware-specific tuning can follow core product completion. |
| **Retailer comparison** | Implemented unified Checkers, Pick n Pay, Woolworths, and visible SPAR rows; exact-EAN safety; price freshness; cache states; accessible ranking; refresh; retry; and source-specific unavailable explanations. | Similar product packs are deliberately not substituted for an exact barcode match. |
| **Shared backend** | Implemented product/price caching, missing-product requests, submitted product hints, scheduled retries, coverage reporting, rate limiting, protected refresh/queue routes, and deployment checks. | The shared database grows from live exact-barcode lookups. |
| **Reliability** | Fixed the mobile Next.js runtime regression, update-safe service-worker handling, error/not-found states, comparison time budgets, and automated API/route checks. | The mobile preview now removes stale development caches and does not cache Next.js bundles. |
| **Catalogue assessment** | Assessed compliant bulk-catalogue approaches and documented a staged ingestion path. | A commercial/authorised source remains necessary for full catalogues. |

## Outstanding work

| Area | Outstanding work | Why it matters |
|---|---|---|
| **User accounts** | Signup/login, cloud user profile, favourites, private scan history, product-interest tracking, price alerts, shopping lists, and preferred stores. | This is the largest functional gap relative to the intended customer product. |
| **Full catalogue coverage** | No complete Checkers, Pick n Pay, Woolworths, or SPAR catalogue has been imported. | Current coverage expands from verified on-demand barcode lookups. |
| **Exact Pick n Pay benchmark** | The original Ouma benchmark EAN is unavailable in the configured Pick n Pay provider catalogue. | PriceCheck correctly avoids comparing a similar product/pack as if it were the same item. |
| **SPAR pricing** | Store/postcode selection and a branch-price source are not connected. | SPAR prices are store-specific, so a national comparison would be misleading. |
| **Production release** | The PWA has not yet been deliberately published to a stable public URL. | Publishing requires the user to click **Publish** in the Manus project interface. |
| **Production operations** | Configure durable production observability, provider-credit monitoring, and an appropriate access/rate policy. | Required before broad public use. |

## Current live-data behaviour

The shared database currently contains products and price histories found during real lookups. The backend was most recently reporting **18 tracked products**, with historic confirmed records across Checkers, Pick n Pay, and Woolworths. A retailer price appears only when the source confirms the **same exact EAN**.

| Retailer | Current model | Why a price can be missing |
|---|---|---|
| **Checkers** | Managed on-demand lookup | No confirmed exact EAN result in the active source. |
| **Pick n Pay** | Managed on-demand lookup | The provider can carry a similar pack without listing the scanned EAN. |
| **Woolworths** | Public product lookup with caching | The product may not be stocked or the retailer may not expose that EAN. |
| **SPAR** | Explicit store-dependent state | A branch-level source and selected store are required. |

## Guidance required

| Decision | Options to choose from |
|---|---|
| **Account model** | Guest-first with optional account; required account; email/password; Google/Apple sign-in; or a combination. |
| **Account data** | Scan history, favourite products, product interests, price alerts, shopping lists, and preferred stores. |
| **Catalogue strategy** | Continue on-demand enrichment; approve a licensed bulk feed; pursue direct retailer partnerships; or start with a defined high-demand seed catalogue. |
| **SPAR scope** | Add postcode/store selection now, or leave SPAR store-specific unavailable until a branch-price source is secured. |
| **Release posture** | Keep private test-only, publish a restricted beta, or publish publicly after account/rate-limit/monitoring work. |

## Recommended next phase

The recommended next phase is **guest-first accounts with optional signup**, because it preserves frictionless barcode comparison while enabling private scan history, saved products, product-interest tracking, and price alerts. In parallel, choose an authorised catalogue source or direct retailer data agreement for broad, frequently refreshed coverage. Then add a preferred-store/postcode model before expanding SPAR.

## Key repository links

| Repository | Purpose |
|---|---|
| [drguzovich/pricecheck-app](https://github.com/drguzovich/pricecheck-app) | Next.js PriceCheck PWA. |
| [drguzovich/pricecheck-backend](https://github.com/drguzovich/pricecheck-backend) | Unified retailer comparison API and shared database backend. |
| [drguzovich/pricecheck-web](https://github.com/drguzovich/pricecheck-web) | Earlier standalone PWA development repository. |

