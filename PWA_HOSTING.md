# PriceCheck PWA Hosting

The legacy Manus workspace still exposes the original mobile-package publisher, which is not compatible with the Next.js browser PWA. The production release instead serves the copied `pwa/` Next.js application through the existing Render web service, preserving the private GitHub repositories and reusing the established HTTPS API origin.

The unified build was verified locally with `npm run build:pwa`; the resulting application served the PriceCheck home document successfully. The Render service’s build setting now runs dependency installation with peer-resolution compatibility, builds the PWA, and installs the Playwright browser required by the retailer integrations.

Render completed the unified build successfully on August 22, 2026 and began the production `npm start` process. The active deployment should now be verified through both `GET /health` and the root PWA document before this release is marked complete. Google OAuth, SMTP delivery, and Sentry remain optional production credentials and are intentionally not enabled until their respective credentials are provided.
