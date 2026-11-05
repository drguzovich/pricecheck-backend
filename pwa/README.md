# TrolleyWise

A mobile-first South African grocery comparison PWA built with Next.js14, React18 and TypeScript. The original repositories and hosted domains are retained for continuity. Customer-facing branding, install icons, legal pages and share text now use TrolleyWise. The previous Expo implementation remains untouched on `native-expo-archive`.

## Source and deployment

Frontend source, UX components/styles, route metadata, PWA assets and this checklist live in [`drguzovich/pricecheck-app`](https://github.com/drguzovich/pricecheck-app). Express APIs, retailer adapters, Neon schemas, auth flows, watchlist worker and regression tests live in [`drguzovich/pricecheck-backend`](https://github.com/drguzovich/pricecheck-backend). Its `pwa/` directory mirrors this frontend source for the existing Render service. Run `python3 scripts/sync-pwa.py /absolute/path/to/frontend` from the backend before its build. Dependencies, `.env` files and Git metadata are excluded.

The published frontend origin is `https://pricecheck-7dykljea.manus.space`; the existing backend is `https://pricecheck-backend-7tkh.onrender.com`. A committed Dockerfile produces Next standalone output with Node22. Manus checkpoint saving and actual publication are separate. No protected value belongs in source, public variables, logs or these docs.

## Shopping and account flows

Guest history/favourites stay on the device. Canonical `trolleywise-*` storage copies previous `pricecheck-*` records without deleting the old copy; canonical empty values prevent cleared/migrated records reappearing. Continuous camera scanning and manual entry keep a bounded, deduplicated100-item queue with per-item comparison, retry, cancellation and batch favourites. Confirmed queue history is not saved again by the result page. Uncertain history retries require user confirmation.

Real email/password accounts use the Express/Neon backend and NextAuth sessions. Optional Google requires separately configured Google credentials and a genuine successful callback. When the Manus frontend has no independent local session key, only allowlisted account/auth routes are bounded-proxied to the real NextAuth routes in the Render PWA. Render must have its own independent `APP_SESSION_SECRET` (or intended `NEXTAUTH_SECRET`), the existing independent `USER_SYNC_JWT_SECRET`, and `NEXTAUTH_URL` set to the published frontend origin. The frontend never borrows a Manus platform signing key. Missing configuration fails closed; it never creates a mock session or anonymous account token.

`/demo` is an isolated on-device fixture demonstration, not a test login: it does not request account/session/product APIs, migrate guest records or change real history/favourites. Genuine private test-account acceptance remains a separate checklist gate.

## Prices, health and monitoring

Comparisons preserve exact barcode identity, retailer timestamps, unavailable/stale states and individual15-second adapter budgets. Woolworths and public Pick n Pay OCC flow are distinct adapters. Checkers requires `SCRAPER_API_KEY` and otherwise returns safe unavailable. SPAR is explicitly coming soon with franchise-specific price explanation. A cached historical price cannot become current again after a newer unavailable check. Manual/background/worker refreshes share barcode coordination.

Open Food Facts supplies actual ingredient text, numeric nutrients per100g, allergen/trace tags and source references where provided. Missing amounts are unknown, not zero. The original1–10 Clean Score remains a limited non-medical heuristic, not a good/bad health or allergy-safety endorsement. Empty-source records, temporary outages, partial facts, source timestamps and offline stale facts are distinct. User-confirmed label notes/photos stay on-device, are explicitly unverified, never replace Open Food Facts and never produce a Clean Score.

Every cloud favourite/active alert is eligible for the dedicated six-hour watchlist worker; refresh runs independently of email readiness and writes durable check/run/trend evidence. `render.yaml` is a declaration, not evidence that a cron exists. Web replicas never run process-local cron. New Render cron billing needs approval and actual deployment/run verification. Email flows/alerts require a configured provider and sender, with actual delivery verification. Credentials/config readiness alone are not delivery proof.

## Local checks

```sh
npx --yes pnpm@11.0.0 install --frozen-lockfile
pnpm check
pnpm lint
pnpm build
PORT=3000 pnpm start
```

The backend includes isolated auth, watchlist, price-cache, health/SW, retailer, guest-migration and Express/Next request-boundary regression suites. Injected synthetic prices, product labels and mocked sends are labelled fixtures and are never actual live evidence. Mobile fixtures likewise do not establish camera hardware, real cloud login, source coverage or email delivery.

## Completion discipline

Follow `pricecheck-build-checklist.md` and `TODO.md`; do not claim completion until every final gate is verified. The exact original barcode `6001069206154` must not be silently replaced by a similar pack or another barcode to satisfy price/health gates. No second retailer price or source-derived Clean Score may be fabricated when the source lacks the exact record. Legal/trademark clearance of the chosen name is not implied by this code or deployment.
