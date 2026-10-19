# PriceCheck implementation plan

The user delegates product decisions and requires the master checklist to remain authoritative. Preserve the audited Next.js 14 source and Express/Neon backend, legacy compatibility, current password accounts and the protected native-expo-archive branch. Do not substitute products or fabricate retailer prices/ingredient data. Complete all code-level gaps and deploy both repositories plus a Manus-hosted frontend; unresolved live-source or credential gates remain unchecked and are explicitly reported, never called done.

## Architecture and structure

`src/app` retains existing routes and NextAuth API routes. `src/components` hosts reusable icons, price/health/skeleton/navigation components. `src/lib` owns API types, guest persistence, cloud-account transport and authentication. `public` owns PWA manifest, icons, service worker and route manifest. `Dockerfile` builds and serves Next.js on PORT or 3000 for Manus. The Express backend remains at the current Render URL; frontend requests proxy through its own origin where useful to avoid cross-origin policy issues. Backend `src/scrapers` keeps exact-product parsing and bounded public-source retrieval; `src/productHealth.js` owns transparent heuristic scoring. Database errors should return controlled unavailability without preventing a no-database process from starting. Backend `src/scripts/seed-catalogue.js` wraps the existing sourced seed flow. Mirror finalized frontend source into backend `pwa/` before its Render release.

## Implementation outcomes

Repair three parallel 15s retailer lookups with fresh four-hour Neon cache and honest stale flags; real Woolworths R24.95 exact-code evidence is recorded in AUDIT.md. Discover PnP shopper JSON using Playwright, with explicit store context and no variant substitution. Checkers missing-key state stays clean and implements configured ScraperAPI proxy/stealth. Implement and unit-test the exact Clean Score rules using real Open Food Facts response data, no-data/error contract and data completeness warnings.

Fix signed account JWT claim compatibility, authenticated error handling, idempotent guest migration, Google configuration state, third-scan prompt, history/favourite empty states and alert links. Add Resend while preserving existing SMTP fallback and six-hour execution. Finish share text, stars, offline API/result caches, visit-two install prompt, skeletons, legal content, Sentry guards, rate limiting and deployment placeholders. Keep no-key operation guest-first.

## Apple-informed design

Use the requested dark #121212, cards #1E1E1E, white primary and #9E9E9E secondary, teal #00BFA5 to green #00E676, Inter with optical sizing, 16px cards, 12px buttons and 8px badges. A calm editorial hierarchy leads with a prominent search input and scan action; price cards use readable numerals, exact timestamps and a clear lowest-price anchor. Four consistent outlined SVG tabs live in restrained frosted bottom chrome, minimum 44px targets and safe-area padding. Product imagery uses existing real-source URLs with graceful fallback. All statuses have text, not color alone. Focus-visible styling, scalable rem spacing and mobile wrapping are first-class. Immediate press feedback uses 100–160ms transform/opacity CSS and retargetable transitions; no decorative bounce or animation of readable prices. Reduced motion removes movement, reduced transparency uses solid chrome, high contrast strengthens borders. No generated decorative assets are needed.

## Delivery constraints

Credential values never committed. Optional Google, ScraperAPI, Resend and Sentry configuration degrade visibly. Signing secrets must match across frontend/backend; absent shared signing configuration must not fake authentication. Publication uses recorded Manus checkpoint and confirmed result; GitHub pushes never force history. One read-only integration review follows implementation, with targeted corrections. Master checklist is updated only from actual evidence. The final completion report requires a confirmed stable URL, real exact-barcode prices and actual Clean Score; unavailable source data is a blocker rather than a invented score.
