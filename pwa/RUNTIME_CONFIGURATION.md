# PriceCheck runtime configuration

The PWA and backend are designed to run safely with empty optional integrations in local development. Configure the following values in the relevant deployment secret manager before enabling their user-facing feature.

| Service | Required values | Purpose |
|---|---|---|
| PWA | `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enables Google sign-in and the signed cloud-migration token. |
| Backend | `USER_SYNC_JWT_SECRET` | Must match the PWA `NEXTAUTH_SECRET`; validates the short-lived account sync token. |
| Backend | `ALLOWED_ORIGINS`, `PRICECHECK_WEB_URL` | Restricts browser API origins and creates email alert links. |
| Backend | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Enables six-hour email price alerts. No email is attempted until all values are set. |
| PWA and backend | `SENTRY_DSN` or `NEXT_PUBLIC_SENTRY_DSN` | Enables optional exception monitoring. |
| Backend | `PARSE_API_KEY`, `PNP_PRODUCT_LOOKUP_URL` | Enables managed retailer catalogue integrations where authorised. |

> Do not commit any of these values. Configure them as protected deployment secrets. Google OAuth should use the released PWA domain and the local development URL as authorised redirect origins.
