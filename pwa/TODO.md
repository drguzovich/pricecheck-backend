# PriceCheck — Build Checklist

Reference this file throughout the build. Work through every section in order.
Do not report completion until every item is checked off.

---

## Section 1 — Audit (do first)

- [x] Clone and read pricecheck-app (https://github.com/drguzovich/pricecheck-app)
- [x] Clone and read pricecheck-backend (https://github.com/drguzovich/pricecheck-backend) — main cloned; server, scrapers, src/db.js and package.json read on 2026-10-19
- [x] Confirm backend /health returns `{ status: "ok" }` at https://pricecheck-backend-7tkh.onrender.com/health — verified HTTP 200, db connected, 2026-10-19T11:04:26Z
- [x] Confirm Woolworths scraper works — test barcode `6001069206154`
- [x] Document what is already built vs what is missing before writing any code

---

## Section 2 — Retailer Scrapers

- [x] Woolworths scraper working (fix if broken)
- [x] Pick n Pay scraper — OCC v2 JSON API via Playwright XHR interception (no proxy needed)
- [x] Checkers scraper — playwright-extra + stealth + ScraperAPI proxy (`SCRAPER_API_KEY` env var)
- [x] Checkers returns clean `{ available: false }` if `SCRAPER_API_KEY` not set — never crashes
- [x] `GET /price/:barcode` runs all 3 scrapers in parallel (`Promise.allSettled`, 15s timeout each)
- [x] One scraper failure never blocks the others
- [x] Results cached in Neon Postgres — reuse if under 4 hours old
- [ ] Test: barcode `6001069206154` returns real prices from Woolworths + Pick n Pay

---

## Section 3 — Product Health Index (new feature)

> Similar to "Think Dirty" — score a product's ingredients for health concerns using Open Food Facts (free API, no key needed).

- [x] Backend: `GET /product/:barcode/health` endpoint
- [x] Fetch ingredient + nutrition data from `https://world.openfoodfacts.org/api/v2/product/{barcode}.json`
- [x] Calculate Clean Score (1–10):
  - Start at 10
  - -1 per E-number additive (max -4)
  - -1 for artificial colors (E102, E110, E122, E124, E129, etc.)
  - -1 for artificial preservatives (E211, E220, E250, etc.)
  - -1 if sugar per 100g > 20g
  - -1 if sodium per 100g > 1g
  - -1 if Nutri-Score grade is D or E
  - Floor at 1
- [x] Score → Grade: 8–10 = "Clean" (green), 5–7 = "OK" (amber), 1–4 = "Concerning" (red)
- [x] Build concern tags list: e.g. `["3 additives", "High sugar", "Artificial colors"]`
- [x] If Open Food Facts returns no data: respond `{ dataAvailable: false }` — never crash
- [x] Frontend: "Product Health" section on `/result` page below price cards
- [x] Health score shown as circular badge — number + grade text (BOTH color AND text label required)
- [x] Concern tags shown as small pills (e.g. "High sugar" in amber)
- [x] Nutri-Score letter (A–E) shown as a small badge
- [x] If no data: grayed section "No ingredient data available for this product"
- [x] Loading skeleton while health score is fetching

---

## Section 4 — User Accounts

- [x] Guest mode: full app works without signup (scan history + favourites in localStorage)
- [ ] Google Sign-In via NextAuth.js on `/account` page
- [x] Soft prompt after 3rd scan: "Save your history across devices?"
- [ ] On sign-in: migrate localStorage history + favourites to Postgres DB
- [x] DB schema: `users`, `scan_history`, `favourites`, `price_alerts` tables
- [x] `/account` page — signed out state (Google Sign-In + benefits)
- [ ] `/account` page — signed in state (name, scan count, favourites count, sign out)
- [x] `/history` page — recent scans, newest first, tap → `/result?barcode=`
- [x] `/history` page — guest banner: "Sign in to sync across devices"
- [x] `/history` page — empty state: "You haven't scanned anything yet."
- [x] `/favourites` page — starred products list, tap → result page
- [x] `/favourites` page — empty state: "No favourites yet."
- [x] `/favourites` page — "Set price alert" button per product
- [x] Price alerts: "Alert me when price drops below R[input]" on `/result` page
- [ ] Price alert emails sent via `RESEND_API_KEY` env var (skip gracefully if not set)
- [x] Backend scheduled job (every 6h) checks prices vs active alerts and sends emails

---

## Section 5 — Catalogue Seed

- [x] Seed list of 100 common SA grocery barcodes created (Ouma Rusks, Albany, Clover, Simba, Jungle Oats, Tastic, All Gold, Rama, Huletts, Ricoffy, Nescafé, Oros, Coke, Sunlight, Colgate, Dove, Pampers, etc.)
- [x] `src/scripts/seed-catalogue.js` script created
- [x] Script calls scraper logic directly (not via HTTP), throttled 1 barcode/3s
- [x] `npm run seed` command added to package.json

---

## Section 6 — SPAR

- [x] SPAR row on `/result` page shows grayed card: "SPAR · Store prices vary · Coming soon"
- [x] Info tooltip: "SPAR is a franchise — prices differ per store. We're working on store-specific pricing."
- [x] No fake or misleading SPAR prices shown

---

## Section 7 — UI / UX Polish

- [x] Bottom navigation bar: Home 🏠 | Scan 📷 | History 🕐 | Account 👤
- [x] Active tab highlighted in teal on all pages
- [x] Bottom nav visible on all pages on mobile
- [x] Star/favourite button on `/result` page (top-right, filled = saved, outline = not saved)
- [ ] Star works for guest (localStorage) and signed-in user (DB)
- [x] Share button on `/result` page (`navigator.share` API, clipboard fallback)
- [x] Share text: "[Product] — best price R[X] at [Retailer]. PriceCheck: [URL]"
- [x] Loading skeleton on every data-fetching page — no blank screens ever
- [x] Offline banner: "You're offline — showing cached prices" (service worker)
- [x] Service worker caches last result per barcode
- [x] PWA install prompt after 2nd visit (`beforeinstallprompt` event)
- [x] **CRITICAL — Rank badges**: every badge shows BOTH color AND text label
  - Best Price = green background + "Best Price" white text
  - 2nd = orange background + "2nd" white text
  - 3rd = red background + "3rd" white text
  - Color alone is inaccessible (~8% of men are colorblind)

---

## Section 8 — Production Readiness

- [x] Sentry added to frontend (read `NEXT_PUBLIC_SENTRY_DSN` env var, skip if missing)
- [x] Sentry added to backend (read `SENTRY_DSN` env var, skip if missing)
- [x] Rate limiting: `express-rate-limit`, max 30 req/min/IP on `/price/:barcode`
- [x] `GET /health` endpoint returns `{ status: "ok", db: "connected", uptime: X }`
- [x] `public/robots.txt` added (allow all crawlers)
- [ ] `sitemap.xml` added (home, search, scan pages)
- [x] `/privacy` page — data collected, how used, how to delete, contact: drguzovich@gmail.com
- [x] `/terms` page — personal use, prices indicative, no warranties
- [x] `/about` page — what PriceCheck is, how it works (3 steps), links to /privacy and /terms

---

## Section 9 — Design System (apply to all screens)

| Token | Value |
|---|---|
| Background | `#121212` |
| Card background | `#1E1E1E` |
| Primary gradient | `#00BFA5 → #00E676` |
| Text primary | `#FFFFFF` |
| Text secondary | `#9E9E9E` |
| Border radius (cards) | `16px` |
| Border radius (buttons) | `12px` |
| Border radius (badges) | `8px` |
| Font | Inter (Google Fonts) |
| Best Price badge | `#00E676` + "Best Price" white text |
| 2nd badge | `#FF9800` + "2nd" white text |
| 3rd badge | `#F44336` + "3rd" white text |
| Health: Clean (8–10) | `#00E676` green |
| Health: OK (5–7) | `#FF9800` amber |
| Health: Concerning (1–4) | `#F44336` red |

---

## Section 10 — Environment Variables

Add all as empty-string placeholders in `render.yaml`. Real values set by user in Render dashboard / Manus settings. **Never hardcode secrets. App must never crash if a var is missing.**

**Backend (Render):**
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres (already set) |
| `SCRAPER_API_KEY` | scraperapi.com — Checkers WAF bypass |
| `RESEND_API_KEY` | resend.com — price alert emails |
| `SENTRY_DSN` | Backend error monitoring |
| `ALERT_FROM_EMAIL` | Sender address for price alert emails |

**Frontend:**
| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://pricecheck-backend-7tkh.onrender.com` |
| `NEXTAUTH_SECRET` | Random 32-char string (generate one) |
| `NEXTAUTH_URL` | The live frontend URL |
| `GOOGLE_CLIENT_ID` | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console |
| `NEXT_PUBLIC_SENTRY_DSN` | Frontend error monitoring |

---

## Section 11 — Deploy

- [x] Backend changes pushed to https://github.com/drguzovich/pricecheck-backend
- [x] Render auto-deploy succeeds — `/health` returns `{ status: "ok" }`
- [x] Frontend changes pushed to https://github.com/drguzovich/pricecheck-app
- [x] Frontend deployed AND published via Manus built-in hosting
- [x] Stable public URL obtained

---

## Final Completion Checklist

Do not report done until every item below is confirmed:

- [x] 1. Public URL exists and loads on mobile browser
- [x] 2. Home page loads with search + scan CTAs and bottom nav
- [x] 3. Barcode `6001069206154` returns price results
- [ ] 4. Woolworths + Pick n Pay show real prices
- [x] 5. Checkers shows price OR clean "not available" — no crash
- [x] 6. SPAR shows grayed "Store prices vary — coming soon" card
- [x] 7. Product Health score shown on `/result` (Clean Score 1–10)
- [x] 8. Health score shows concern tags (e.g. "High sugar")
- [x] 9. If no ingredient data: grayed "No data available" section shown
- [x] 10. Rank badges show BOTH color AND text on every result
- [x] 11. Star/favourite button works (saves product)
- [x] 12. Share button works
- [x] 13. `/history` page works with empty state
- [x] 14. `/favourites` page works with empty state
- [x] 15. `/account` page shows Google Sign-In option
- [x] 16. `/privacy` page exists with real content
- [x] 17. `/terms` page exists with real content
- [x] 18. `/about` page exists with real content
- [x] 19. Bottom nav works on all pages
- [x] 20. Loading skeletons on all data-fetching pages — no blank screens
- [x] 21. Backend `/health` returns `{ status: "ok" }` — verified HTTP 200 on 2026-10-19
- [ ] 22. Both repos pushed to GitHub with all changes
- [x] 23. Completion report includes: **live public URL**
- [x] 24. Completion report includes: **actual prices for barcode `6001069206154`**
- [ ] 25. Completion report includes: **Clean Score for barcode `6001069206154`**

## Evidence and remaining gates — 19 October 2026

Published frontend: https://pricecheck-7dykljea.manus.space, Manus publication confirmed for checkpoint03c7d54550e9906b16ba374fd65449d9cf98f7f9. Actual public 390px mobile browser checks passed (not mocked): all page routes, navigation, guest star/history/favourites/share, legal content and benchmark no-data UI. Render releasee21bbd699bc60d9815524a970cdf2d63f6b9b84f verified HTTP200 with statusok/dbconnected.

Benchmark6001069206154: WoolworthsR24.95ZAR. PicknPay unavailable/timed out; direct source research found no exact-EAN listing and a different Chunky variant is deliberately not substituted. Checkers clean unavailable because SCRAPER_API_KEY is absent. SPAR has no store-specific price. OFF has no record for this benchmark; cleanScore is null/dataAvailablefalse. **Final items4 and25 remain open. No done/completed claim is authorized.**

Final items7 and8 were genuinely validated with a different actual catalogue product (Coca-Cola2L5449000009067): score7/10OK, two additives, Nutri-ScoreE. This confirms the health feature, but is NOT a substitute for the benchmark score required byitem25. Complete-data scoring, partial/no-data behavior, colour+text badges, signed proxy identities, and failure isolation also passed regression tests.

Google OAuth, authenticated cross-device migration/favourites and real email delivery remain unverified until Google/app shared signing/email credentials are configured. No keys were hardcoded; absent keys fail safely. A sourced100-item checksum-valid catalogue and direct3s seed command are supplied; rerunning live seeding requires authorised DB/admin execution access. Sitemap/public-origin configuration is being finalized using the confirmed hostname.
