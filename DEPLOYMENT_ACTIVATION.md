# Backend Deployment Activation

See the PWA repository's `RELEASE_ACTIVATION.md` for the complete cross-service release sequence. The backend must be deployed with the protected environment variables defined in `render.yaml` before running its seed or alert jobs.

The verified catalogue seed is intentionally protected. It requires `ADMIN_REFRESH_TOKEN` and runs only through `POST /admin/seed-catalogue`; status is available at `GET /admin/seed-catalogue`. Neither endpoint exposes the token or retailer-provider credentials.

The `pricecheck-alerts` Render cron definition runs the alert processor every six hours. It sends no email until SMTP settings are present, and it suppresses repeated notifications for the same alert price within 24 hours.
