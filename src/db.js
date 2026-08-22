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

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id           BIGSERIAL PRIMARY KEY,
      google_id    TEXT NOT NULL UNIQUE,
      email        TEXT NOT NULL,
      display_name TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'google'`;

  await sql`
    CREATE TABLE IF NOT EXISTS scan_history (
      id           BIGSERIAL PRIMARY KEY,
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      barcode      TEXT NOT NULL,
      product_name TEXT NOT NULL,
      last_price   NUMERIC,
      scanned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_history_user_date ON scan_history (user_id, scanned_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS favourites (
      id           BIGSERIAL PRIMARY KEY,
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      barcode      TEXT NOT NULL,
      product_name TEXT NOT NULL,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, barcode)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_favourites_user_date ON favourites (user_id, added_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS price_alerts (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      barcode         TEXT NOT NULL,
      target_price    NUMERIC NOT NULL CHECK (target_price > 0),
      email           TEXT NOT NULL,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      last_sent_at    TIMESTAMPTZ,
      last_sent_price NUMERIC,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts (active, barcode)`;

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

async function checkDatabase() {
  await sql`SELECT 1 AS connected`;
  return true;
}

async function upsertUser(principal) {
  const accountId = principal.accountId ?? principal.googleId;
  if (!accountId) throw new Error('Account identity is required.');
  const [user] = await sql`
    INSERT INTO users (google_id, email, display_name)
    VALUES (${accountId}, ${principal.email}, ${principal.displayName ?? null})
    ON CONFLICT (google_id) DO UPDATE
    SET email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        updated_at = NOW()
    RETURNING id, google_id, email, display_name, created_at
  `;
  return user;
}

async function createPasswordUser({ email, displayName, passwordHash }) {
  const accountId = `password:${email}`;
  const [existing] = await sql`SELECT id FROM users WHERE google_id = ${accountId} LIMIT 1`;
  if (existing) return { duplicate: true, user: null };
  const [user] = await sql`
    INSERT INTO users (google_id, email, display_name, password_hash, auth_provider)
    VALUES (${accountId}, ${email}, ${displayName}, ${passwordHash}, 'password')
    RETURNING id, google_id AS account_id, email, display_name, created_at
  `;
  return { duplicate: false, user };
}

async function getPasswordUser(email) {
  const accountId = `password:${email}`;
  const [user] = await sql`
    SELECT id, google_id AS account_id, email, display_name, password_hash
    FROM users
    WHERE google_id = ${accountId} AND auth_provider = 'password'
    LIMIT 1
  `;
  return user ?? null;
}

async function listScanHistory(userId, limit = 100) {
  return sql`
    SELECT id, barcode, product_name, last_price, scanned_at
    FROM scan_history
    WHERE user_id = ${userId}
    ORDER BY scanned_at DESC
    LIMIT ${limit}
  `;
}

async function recordScan(userId, scan) {
  const [entry] = await sql`
    INSERT INTO scan_history (user_id, barcode, product_name, last_price, scanned_at)
    VALUES (${userId}, ${scan.barcode}, ${scan.productName}, ${scan.lastPrice ?? null}, ${scan.scannedAt ?? new Date()})
    RETURNING id, barcode, product_name, last_price, scanned_at
  `;
  return entry;
}

async function listFavourites(userId) {
  return sql`
    SELECT id, barcode, product_name, added_at
    FROM favourites
    WHERE user_id = ${userId}
    ORDER BY added_at DESC
  `;
}

async function addFavourite(userId, favourite) {
  const [entry] = await sql`
    INSERT INTO favourites (user_id, barcode, product_name)
    VALUES (${userId}, ${favourite.barcode}, ${favourite.productName})
    ON CONFLICT (user_id, barcode) DO UPDATE SET product_name = EXCLUDED.product_name
    RETURNING id, barcode, product_name, added_at
  `;
  return entry;
}

async function removeFavourite(userId, barcode) {
  const rows = await sql`
    DELETE FROM favourites WHERE user_id = ${userId} AND barcode = ${barcode}
    RETURNING id
  `;
  return rows.length > 0;
}

async function listAlerts(userId) {
  return sql`
    SELECT id, barcode, target_price, email, active, last_sent_at, last_sent_price, created_at
    FROM price_alerts WHERE user_id = ${userId} ORDER BY active DESC, created_at DESC
  `;
}

async function createAlert(userId, alert) {
  const [entry] = await sql`
    INSERT INTO price_alerts (user_id, barcode, target_price, email)
    VALUES (${userId}, ${alert.barcode}, ${alert.targetPrice}, ${alert.email})
    RETURNING id, barcode, target_price, email, active, created_at
  `;
  return entry;
}

async function deactivateAlert(userId, alertId) {
  const rows = await sql`
    UPDATE price_alerts SET active = FALSE WHERE id = ${alertId} AND user_id = ${userId} RETURNING id
  `;
  return rows.length > 0;
}

async function getActiveAlerts() {
  return sql`
    SELECT id, barcode, target_price, email, last_sent_at, last_sent_price
    FROM price_alerts
    WHERE active = TRUE
    ORDER BY created_at ASC
    LIMIT 500
  `;
}

async function recordAlertSent(alertId, price) {
  const [entry] = await sql`
    UPDATE price_alerts
    SET last_sent_at = NOW(), last_sent_price = ${price}
    WHERE id = ${alertId}
    RETURNING id, last_sent_at, last_sent_price
  `;
  return entry ?? null;
}

async function getUserSummary(userId) {
  const [summary] = await sql`
    SELECT
      (SELECT COUNT(*) FROM scan_history WHERE user_id = ${userId}) AS scan_count,
      (SELECT COUNT(*) FROM favourites WHERE user_id = ${userId}) AS favourites_count,
      (SELECT COUNT(*) FROM price_alerts WHERE user_id = ${userId} AND active = TRUE) AS alerts_count
  `;
  return {
    scanCount: Number(summary?.scan_count ?? 0),
    favouritesCount: Number(summary?.favourites_count ?? 0),
    alertsCount: Number(summary?.alerts_count ?? 0),
  };
}

async function migrateGuestData(userId, payload) {
  const scans = Array.isArray(payload.scans) ? payload.scans.slice(0, 250) : [];
  const favouritesToAdd = Array.isArray(payload.favourites) ? payload.favourites.slice(0, 250) : [];
  await sql.begin(async (transaction) => {
    for (const scan of scans) {
      if (!scan?.barcode || !scan?.productName) continue;
      await transaction`
        INSERT INTO scan_history (user_id, barcode, product_name, last_price, scanned_at)
        VALUES (${userId}, ${String(scan.barcode)}, ${String(scan.productName).slice(0, 240)}, ${Number.isFinite(Number(scan.lastPrice)) ? Number(scan.lastPrice) : null}, ${scan.scannedAt ? new Date(scan.scannedAt) : new Date()})
      `;
    }
    for (const favourite of favouritesToAdd) {
      if (!favourite?.barcode || !favourite?.productName) continue;
      await transaction`
        INSERT INTO favourites (user_id, barcode, product_name)
        VALUES (${userId}, ${String(favourite.barcode)}, ${String(favourite.productName).slice(0, 240)})
        ON CONFLICT (user_id, barcode) DO UPDATE SET product_name = EXCLUDED.product_name
      `;
    }
  });
  return getUserSummary(userId);
}

module.exports = {
  sql, initSchema, checkDatabase, recordProductRequest, getProductRequest, listProductRequests,
  recordProductRequestOutcome, getCoverageStats, upsertUser, createPasswordUser, getPasswordUser, listScanHistory, recordScan,
  listFavourites, addFavourite, removeFavourite, listAlerts, createAlert, deactivateAlert,
  getActiveAlerts, recordAlertSent, getUserSummary, migrateGuestData,
};
