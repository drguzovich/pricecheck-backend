# PriceCheck Release Activation Checklist

The source code, PWA routes, account data model, alert scheduler, verified 100-barcode catalogue workflow, legal pages, and backend APIs are implemented. This checklist covers the external settings that must be supplied in the deployment environments before a public release.

## 1. Backend deployment settings

Configure these values in the `pricecheck-backend` Render service. Store them only in protected environment-variable settings.

| Setting | Purpose | Required for |
|---|---|---|
| `DATABASE_URL` | Existing shared PostgreSQL/Neon connection | All product, account, and history data |
| `PARSE_API_KEY` | Approved managed retailer lookup | Pick n Pay and Checkers coverage |
| `USER_SYNC_JWT_SECRET` | Verifies short-lived PWA-to-backend user sync tokens | Cloud history, favourites, and alerts |
| `ADMIN_REFRESH_TOKEN` | Guards seed, refresh, and coverage administration | Running the verified seed safely |
| `ALLOWED_ORIGINS` | Comma-separated PWA origins | Browser API access restriction |
| `PRICECHECK_WEB_URL` | Final public PWA URL | Alert links and email content |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Transactional email configuration | Price-drop alerts |
| `SENTRY_DSN` | Optional backend error reporting | Error monitoring |

## 2. PWA deployment settings

Configure these values in the PriceCheck PWA host.

| Setting | Purpose |
|---|---|
| `NEXTAUTH_URL` | Final HTTPS PWA origin |
| `NEXTAUTH_SECRET` | Encrypts NextAuth session JWTs |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enables optional Google account sign-in |
| `USER_SYNC_JWT_SECRET` | Must match the backend value exactly |
| `NEXT_PUBLIC_PRICE_API_URL` | Production backend URL |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional browser error reporting |

## 3. One-time launch operations

First, deploy the backend after the latest GitHub commit. Set `ADMIN_REFRESH_TOKEN`, then call `POST /admin/seed-catalogue` with `x-admin-refresh-token` to start the resumable 100-product seed. Poll `GET /admin/seed-catalogue` with the same header until it reports `complete`.

Second, create the Render `pricecheck-alerts` cron service from `render.yaml`. It runs `npm run alerts:run` every six hours and remains dormant until all SMTP settings are supplied.

Third, publish the PWA from the Manus project UI. Use the resulting HTTPS URL for `NEXTAUTH_URL`, `PRICECHECK_WEB_URL`, and `ALLOWED_ORIGINS`. Configure the Google OAuth redirect URI as:

```
https://YOUR_PUBLISHED_PRICECHECK_DOMAIN/api/auth/callback/google
```

## 4. Release acceptance record

The final release check should confirm a new visitor can search, scan, share a result, save a product locally, install the PWA, sign in with Google, see guest data migrate, create an alert, and receive a test email. It should also record actual retailer responses, not assumed data:

| Barcode | Product | Confirmed live results on 21 August 2026 |
|---|---|---|
| `6001069206154` | Ouma Buttermilk Rusks 500g | Woolworths R24.95; other sources did not return an exact EAN listing |
| `6001069600754` | Ouma Buttermilk Sliced Rusks 450g | Checkers R62.99; Pick n Pay R63.99 |
| `6001253010178` | Albany Superior White Sliced Bread 700g | Checkers R17.99; Pick n Pay R18.99; Woolworths R4.00 as returned by its source |

> Retailer values must be rechecked at release time. PriceCheck intentionally leaves a retailer unavailable when the exact EAN cannot be established or the source is store-specific.
