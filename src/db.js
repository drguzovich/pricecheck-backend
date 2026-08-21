'use strict';

/**
 * Database layer — Neon (serverless Postgres) via postgres.js
 *
 * Connection is driven entirely by the DATABASE_URL environment variable,
 * which must be set in the Render service's environment (never committed).
 *
 * Schema is created idempotently on startup so the service self-migrates on
 * first boot against a fresh database.
 */

const postgres = require('postgres');

if (!process.env.DATABASE_URL) {
  throw new Error('[db] DATABASE_URL environment variable is not set. ' +
    'Add it to your Render service environment variables.');
}

const sql = postgres(process.env.DATABASE_URL, {
  ssl: 'require',
  max: 5,                // small pool — Neon free tier has connection limits
  idle_timeout: 20,      // release idle connections quickly (Neon auto-suspends)
  connect_timeout: 10,
});

/**
 * Create tables idempotently.  Called once at startup; awaited before the
 * HTTP server starts accepting requests.
 */
async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS products (
      barcode    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      brand      TEXT,
      pack_size  TEXT,
      image_url  TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS retailer_prices (
      id         BIGSERIAL PRIMARY KEY,
      retailer   TEXT        NOT NULL,
      product_id TEXT        NOT NULL REFERENCES products(barcode),
      price      NUMERIC     NOT NULL,
      price_str  TEXT,
      scraped_at TIMESTAMPTZ NOT NULL,
      url        TEXT,
      promo_flag BOOLEAN     NOT NULL DEFAULT FALSE
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_retailer_prices_lookup
      ON retailer_prices (retailer, product_id, scraped_at DESC)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS product_requests (
      barcode            TEXT PRIMARY KEY,
      product_hint       TEXT,
      request_count      INTEGER     NOT NULL DEFAULT 1,
      first_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_product_requests_recent
      ON product_requests (last_requested_at DESC)
  `;

  await sql`ALTER TABLE product_requests ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE product_requests ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ`;
  await sql`ALTER TABLE product_requests ADD COLUMN IF NOT EXISTS last_retry_status TEXT`;
  await sql`ALTER TABLE product_requests ADD COLUMN IF NOT EXISTS last_retry_matched_retailers TEXT[] NOT NULL DEFAULT '{}'::TEXT[]`;

  console.log('[db] Schema ready (Neon Postgres)');
}

async function recordProductRequest(barcode, productHint) {
  const hint = productHint?.trim() || null;
  const [request] = await sql`
    INSERT INTO product_requests (barcode, product_hint)
    VALUES (${barcode}, ${hint})
    ON CONFLICT (barcode) DO UPDATE
    SET request_count = product_requests.request_count + 1,
        product_hint = COALESCE(EXCLUDED.product_hint, product_requests.product_hint),
        last_requested_at = NOW()
    RETURNING barcode, product_hint, request_count, last_requested_at
  `;
  return request;
}

async function getProductRequest(barcode) {
  const [request] = await sql`
    SELECT barcode, product_hint, request_count, last_requested_at, retry_count,
           last_retry_at, last_retry_status, last_retry_matched_retailers
    FROM product_requests
    WHERE barcode = ${barcode}
    LIMIT 1
  `;
  return request ?? null;
}

async function listProductRequests(limit = 50) {
  return sql`
    SELECT barcode, product_hint, request_count, first_requested_at, last_requested_at,
           retry_count, last_retry_at, last_retry_status, last_retry_matched_retailers
    FROM product_requests
    ORDER BY request_count DESC, last_requested_at DESC
    LIMIT ${limit}
  `;
}

async function recordProductRequestOutcome(barcode, results) {
  const matchedRetailers = results.filter((result) => result.available).map((result) => result.retailer);
  const status = matchedRetailers.length > 0 ? 'resolved' : 'unavailable';
  const [request] = await sql`
    UPDATE product_requests
    SET retry_count = product_requests.retry_count + 1,
        last_retry_at = NOW(),
        last_retry_status = ${status},
        last_retry_matched_retailers = ${matchedRetailers}
    WHERE barcode = ${barcode}
    RETURNING barcode, retry_count, last_retry_at, last_retry_status, last_retry_matched_retailers
  `;
  return request ?? null;
}

async function getCoverageStats() {
  const [summary] = await sql`
    SELECT
      (SELECT COUNT(*) FROM products) AS tracked_products,
      (SELECT COUNT(*) FROM product_requests WHERE COALESCE(last_retry_status, 'pending') <> 'resolved') AS pending_product_requests,
      (SELECT MAX(scraped_at) FROM retailer_prices) AS latest_price_update
  `;
  const retailers = await sql`
    SELECT retailer, COUNT(DISTINCT product_id) AS product_count, MAX(scraped_at) AS latest_price_update
    FROM retailer_prices
    GROUP BY retailer
    ORDER BY retailer ASC
  `;
  return {
    tracked_products: Number(summary?.tracked_products ?? 0),
    pending_product_requests: Number(summary?.pending_product_requests ?? 0),
    latest_price_update: summary?.latest_price_update ?? null,
    retailers: retailers.map((retailer) => ({
      retailer: retailer.retailer,
      product_count: Number(retailer.product_count ?? 0),
      latest_price_update: retailer.latest_price_update ?? null,
    })),
  };
}

module.exports = { sql, initSchema, recordProductRequest, getProductRequest, listProductRequests, recordProductRequestOutcome, getCoverageStats };
