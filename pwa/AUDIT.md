# PriceCheck audit — 19 October 2026

Both repositories have been cloned and read on main: frontend drguzovich/pricecheck-app at 7202731; backend drguzovich/pricecheck-backend. Native-expo-archive has not been checked out or modified. Master checklist: /home/ubuntu/pricecheck-build-checklist.md, transferred privately from the user's local workspace with verified SHA-256.

## Existing implementation

Next.js 14 PWA contains home, scan, search, result, account, history, favourites, alerts, offline, privacy, terms and about routes, Inter dark/teal theme, guest localStorage, NextAuth Google and existing password auth, Sentry, install prompting and shell service worker. Backend contains Express, Neon Postgres schema, four retailer adapters, parallel fault isolation, 4h cache, users/scans/favourites/alerts and six-hour price refresh. A sourced 100-item catalogue and resumable three-second-throttled seed exist. Backend Render serves a bundled copy of the frontend; its source matches the frontend except notes. Frontend fixes must be mirrored to backend/pwa.

## Missing and broken

Health endpoint, score calculation and health UI are absent. Protected account flows fail because frontend bearer tokens use account_id while backend requires google_id. Guest migration is not idempotent. Woolworths Playwright fallback is unreachable. PnP lacks requested XHR/JSON public v2 discovery; Checkers uses a separate Parse provider rather than ScraperAPI/stealth. Default timeout is 11s, not 15s. Rate limiter is custom 30/15min, not express-rate-limit 30/min. Database throws on missing DATABASE_URL. Alerts use SMTP, not Resend. Five bottom tabs should become four. Share text, favourites button shape, required empty/guest copy, accessible SPAR information, skeletons, offline result/API caching, no-data health UI, reduced-motion/transparency, legal contact/no-warranty text and several env names need changes. No existing Manus website declaration found. Manus publication is still required.

## Verified live sources

Backend /health returned HTTP 200 status ok and db connected at 2026-10-19T11:04:26Z. Test barcode 6001069206154 has valid GTIN-13 checksum. Woolworths https://www.woolworths.co.za/prod/_/A-6001069206154 renders Rusks: Ouma Buttermilk, 500g, product code 6001069206154 and R24.95, independently observed around 11:53 UTC. Its public initial state has pdp.productInfo.productId and matching SKU, with SalePrice 24.95. Live backend cache refreshed at 11:04:27Z and is now fresh.

PnP public product API is https://www.pnp.co.za/pnphybris/v2/pnp-spa/products/{productCode}?storeCode=WC21&lang=en&curr=ZAR&fields=FULL, unauthenticated HTTP 200. Store WC21 is Constantia and must be named explicitly. EAN search for 6001069206154 yielded zero products. A name-search candidate Ouma Chunky Buttermilk Rusks 500g, internal code 000000000000544830_EA, is R62.99; its image contains barcode 6001069600822. **Do not claim this is an exact match or report R62.99 as the requested barcode's PnP price.** Actual shopper v2 APIs use pnphybris, while /occ/v2/basesites is discovery. Preserve strict identity, fail closed if different variant/ambiguous. All retailer information returned with actual timestamps/store context; no fabricated data.

## Design and implementation decisions

User explicitly requests Apple design guidance and delegates decisions. Preserve requested #121212/#1e1e1e, #00BFA5 to #00E676, Inter, 16px cards, 12px buttons and 8px badges. Apply immediate press feedback, restrained translucency for navigation, clear hierarchy, consistent SVG icons, readable scalable typography, minimum 44px targets, focus styles, reduced-motion/transparency/high-contrast modes. No decorative hero assets needed; reuse existing icons/product images. Health heuristic must state it is not medical advice and missing ingredients/nutrition must never imply a perfect clean score. Use actual Open Food Facts data only. Preserve existing password accounts and legacy backend response compatibility.

GitHub authenticated ADMIN access is available in cloud; no source changes pushed yet. Optional credentials are absent in the development environment; implement graceful no-key behavior, never invent or hardcode secrets. Google OAuth still requires real Google credentials; cross-device sync requires same protected signing secret on frontend/backend. Checklist items only checked with evidence, and final completion remains open for any real-data or deployment blocker.

## Health source evidence

At 2026-10-19T12:05 UTC the official Open Food Facts v2 endpoint for 6001069206154 returned HTTP404, status0, product not found. A real Clean Score for this barcode cannot currently be calculated. The app must show its no-data state; final score criteria remain open.

## Catalogue correction

The initial 100-item catalogue contained four checksum-invalid variable-weight identifiers. Replaced those four with independently source-verified Huletts White Sugar 1kg (6001042000403), Pampers Baby Dry Size3 Jumbo76 (4015400739098), Gillette Blue3 Cool3 (7702018457229), and Huletts Icing Sugar500g (6009645689735). Official PnP product pages and the official PnP Huletts barcode PDF were opened/read on 19 October2026; URLs/evidence retained per item in data/seed-candidates.json. Validator now reports exactly100 unique checksum-valid GTINs. Running the live Neon seed still requires authorized DATABASE_URL or ADMIN_REFRESH_TOKEN/Render execution access, absent in this sandbox.
