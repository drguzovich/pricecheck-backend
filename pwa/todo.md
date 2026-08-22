# PriceCheck Web-PWA Completion TODO

## Repository and PWA Foundation
- [x] Preserve the legacy Expo source in a local archive and protected local branch
- [x] Replace the managed project source with the approved Next.js PWA
- [x] Push the approved Next.js PWA replacement to `drguzovich/pricecheck-app`
- [x] Prepare the PWA for Manus-hosted deployment and a stable live URL

## Backend and Data Coverage
- [x] Implement the unified Woolworths, Pick n Pay, Checkers, and visible SPAR comparison shape
- [x] Add bounded cache freshness, rate limiting, a protected refresh route, and deployment verification
- [x] Add missing-product request capture and scheduled enrichment retries using submitted product hints
- [x] Complete backend documentation, coverage administration, and automated acceptance checks
- [x] Resolve the live approved-barcode lookup timeout within the specified comparison budget
- [ ] Obtain an exact Pick n Pay catalogue listing for the approved Ouma barcode or revise the test barcode to one Pick n Pay carries

## User Experience
- [x] Implement mobile-first Home, Search, Scan, and Price Result routes
- [x] Implement BarcodeDetector-first camera scanning with a ZXing fallback and manual entry
- [x] Implement accessible ranked retailer cards, availability explanations, refresh, and retry states
- [x] Implement manifest, install icons, update-safe service worker, and PWA registration
- [x] Implement persistent local recent-search history and an explicit install/update experience
- [x] Complete accessibility, offline, and safe error-state acceptance checks

## Verification
- [x] Verify the approved Ouma barcode against the live backend and record actual retailer prices
- [x] Verify all defined API paths and browser routes with deterministic tests

## Final Production Readiness
- [x] Add visible source freshness and provider-coverage health information without exposing credentials
- [x] Add bounded retry telemetry for exact-EAN retailer gaps and product-request queue progression
- [ ] Reconcile the approved Ouma criterion with the unavailable exact Pick n Pay catalogue record
- [x] Prepare a stable release checklist for the user-controlled Manus Publish action

## Reported Mobile Regression
- [x] Fix the Next.js client runtime error shown on the user’s phone
- [x] Make unavailable Checkers, Pick n Pay, Woolworths, and SPAR states clearly explain the data-source reason

## Catalogue Expansion Assessment
- [x] Document current user parameters, persisted scan behaviour, and database coverage
- [x] Assess compliant full-catalogue ingestion paths for Checkers, Pick n Pay, Woolworths, and SPAR
- [x] Recommend a staged retailer-ingestion approach with source and operating-cost requirements

## Approved 20-Criteria Completion
- [x] Create guest-first account, Google sign-in, cloud migration, scan history, favourites, and price-alert data model
- [x] Build Account, History, Favourites, and bottom navigation user flows
- [x] Add email alert scheduling with credential-safe failure handling
- [x] Create and run a verified 100-product South African grocery seed catalogue
- [x] Run the verified seed through the deployed backend environment with its protected database connection
- [x] Render SPAR as intentional store-specific coming soon with an explanatory tooltip
- [x] Add Sentry-ready monitoring, strengthened API controls, and required environment placeholders
- [x] Add robots, sitemap, Privacy, Terms, and About pages
- [x] Add favourites, sharing, skeletons, offline banner, and second-visit install prompt
- [ ] Verify every completion criterion and publish both source repositories
- [ ] Prepare the stable Manus-hosted public release and report actual benchmark prices
- [ ] Configure Google OAuth, SMTP, Sentry, sync-token, CORS, and administrative deployment secrets

## Production Activation
- [x] Authenticate to the existing Render deployment and configure protected backend variables
- [ ] Configure protected PWA authentication and monitoring variables
- [x] Trigger and monitor the deployed 100-product catalogue seed
- [ ] Verify Google sign-in, cloud migration, alert creation, and a test email against production services
- [ ] Publish the stable PriceCheck PWA from the Manus interface and validate the live URL
- [ ] Provision a compatible public web-PWA host because the inherited Manus workspace exposes only the legacy mobile APK publisher
- [ ] Prepare the existing public backend service to serve the PriceCheck PWA without requiring additional GitHub deployment permissions
