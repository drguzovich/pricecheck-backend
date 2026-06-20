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

  console.log('[db] Schema ready (Neon Postgres)');
}

module.exports = { sql, initSchema };
