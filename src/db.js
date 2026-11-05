'use strict';

/**
 * Database layer  -  Neon (serverless Postgres) via postgres.js
 *
 * Connection is driven entirely by the DATABASE_URL environment variable,
 * which must be set in the Render service's environment (never committed).
 *
 * Schema is created idempotently on startup so the service self-migrates on
 * first boot against a fresh database.
 */

const { createHash } = require('crypto');
const postgres = require('postgres');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const databaseConfigured = Boolean(databaseUrl);

function databaseUnavailableError() {
  const error = new Error('[db] DATABASE_URL environment variable is not configured.');
  error.code = 'DATABASE_NOT_CONFIGURED';
  return error;
}

// Keep the tagged-template interface available when the database is optional.
// Route handlers can then return an honest service-unavailable response rather
// than crashing during module import or process startup.
function unavailableSql() { throw databaseUnavailableError(); }
unavailableSql.begin = async () => { throw databaseUnavailableError(); };

const sql = databaseConfigured ? postgres(databaseUrl, {
  ssl: 'require',
  max: 3,                // data pool plus two lock connections stays at five
  idle_timeout: 20,      // release idle connections quickly (Neon auto-suspends)
  connect_timeout: 10,
}) : unavailableSql;

const lockSql = databaseConfigured ? postgres(databaseUrl, {
  ssl: 'require', max: 2, idle_timeout: 20, connect_timeout: 10,
}) : unavailableSql;

function isDatabaseConfigured() {
  return databaseConfigured;
}

/**
 * Create tables idempotently.  Called once at startup; awaited before the
 * HTTP server starts accepting requests.
 */
async function initSchema() {
  if (!databaseConfigured) throw databaseUnavailableError();
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
      scanned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      migration_key TEXT
    )
  `;
  // Existing scans intentionally retain a NULL migration key. This avoids
  // rewriting or deleting established account history while making subsequent
  // guest-sync imports idempotent.
  await sql`ALTER TABLE scan_history ADD COLUMN IF NOT EXISTS migration_key TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scan_history_user_date ON scan_history (user_id, scanned_at DESC)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_history_user_migration_key
    ON scan_history (user_id, migration_key)
    WHERE migration_key IS NOT NULL
  `;

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

  // Legacy duplicate rows remain intact. Only the canonical row selected by
  // createAlert receives a key, so this additive index is safe on existing data.
  await sql`ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS dedupe_key TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_price_alerts_canonical
    ON price_alerts (user_id, barcode) WHERE dedupe_key IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_price_alerts_user_barcode ON price_alerts (user_id, barcode, id DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS watchlist_checks (
    barcode TEXT PRIMARY KEY,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_available_at TIMESTAMPTZ,
    availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable', 'failed')),
    results JSONB NOT NULL DEFAULT '[]'::JSONB
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_watchlist_checks_rotation ON watchlist_checks (last_checked_at, barcode)`;
  await sql`CREATE TABLE IF NOT EXISTS watchlist_observations (
    id BIGSERIAL PRIMARY KEY,
    barcode TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    availability TEXT NOT NULL,
    best_price NUMERIC,
    retailer TEXT,
    source_updated_at TIMESTAMPTZ,
    source_url TEXT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_watchlist_observations_trend ON watchlist_observations (barcode, checked_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_retailer_prices_barcode_date ON retailer_prices (product_id, scraped_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS watchlist_runs (
    id UUID PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    state TEXT NOT NULL DEFAULT 'running',
    metrics JSONB NOT NULL DEFAULT '{}'::JSONB
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_watchlist_runs_date ON watchlist_runs (started_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS alert_delivery_claims (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    barcode TEXT NOT NULL,
    price NUMERIC NOT NULL,
    claim_token UUID NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    state TEXT NOT NULL DEFAULT 'claimed',
    PRIMARY KEY (user_id, barcode)
  )`;

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
  if (!databaseConfigured) throw databaseUnavailableError();
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
    ON CONFLICT (google_id) DO NOTHING
    RETURNING id, google_id AS account_id, email, display_name, created_at
  `;
  return { duplicate: !user, user: user || null };
}

async function getPasswordUser(email) {
  const accountId = `password:${email}`;
  const [user] = await sql`
    SELECT id, google_id AS account_id, email, display_name, password_hash, auth_version
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
    SELECT DISTINCT ON (a.barcode) a.id, a.barcode, a.target_price, a.email,
      a.active, a.last_sent_at, a.last_sent_price, a.created_at,
      COALESCE(p.name, f.product_name) AS product_name
    FROM price_alerts a
    LEFT JOIN products p ON p.barcode = a.barcode
    LEFT JOIN favourites f ON f.user_id = a.user_id AND f.barcode = a.barcode
    WHERE a.user_id = ${userId} AND a.active = TRUE
    ORDER BY a.barcode, (a.dedupe_key IS NOT NULL) DESC, a.id DESC
  `;
}

async function createAlert(userId, alert) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`alert:${userId}:${alert.barcode}`}))`;
    const [existing] = await tx`SELECT id FROM price_alerts
      WHERE user_id = ${userId} AND barcode = ${alert.barcode}
      ORDER BY (dedupe_key IS NOT NULL) DESC, id DESC LIMIT 1 FOR UPDATE`;
    const rows = existing
      ? await tx`UPDATE price_alerts SET target_price = ${alert.targetPrice}, email = ${alert.email},
          active = TRUE, dedupe_key = 'canonical' WHERE id = ${existing.id}
          RETURNING id, barcode, target_price, email, active, created_at`
      : await tx`INSERT INTO price_alerts (user_id, barcode, target_price, email, dedupe_key)
          VALUES (${userId}, ${alert.barcode}, ${alert.targetPrice}, ${alert.email}, 'canonical')
          ON CONFLICT (user_id, barcode) WHERE dedupe_key IS NOT NULL
          DO UPDATE SET target_price = EXCLUDED.target_price, email = EXCLUDED.email, active = TRUE
          RETURNING id, barcode, target_price, email, active, created_at`;
    return rows[0];
  });
}

async function deactivateAlert(userId, alertId) {
  // Disable legacy duplicates as well so removing a displayed canonical alert
  // cannot unexpectedly reveal another active alert for the same product.
  const rows = await sql`
    UPDATE price_alerts SET active = FALSE WHERE user_id = ${userId}
      AND barcode = (SELECT barcode FROM price_alerts WHERE id = ${alertId} AND user_id = ${userId})
    RETURNING id
  `;
  return rows.length > 0;
}

async function getActiveAlerts({ afterId = 0, limit = 250, barcodes = null } = {}) {
  const pageSize = Math.min(1000, Math.max(1, Number(limit) || 250));
  return sql`
    WITH canonical AS (
      SELECT DISTINCT ON (user_id, barcode) id, user_id, barcode, target_price, email,
        active, last_sent_at, last_sent_price
      FROM price_alerts WHERE active = TRUE
      ORDER BY user_id, barcode, (dedupe_key IS NOT NULL) DESC, id DESC
    )
    SELECT * FROM canonical WHERE id > ${afterId}
      ${barcodes ? sql`AND barcode IN ${sql(barcodes)}` : sql``}
    ORDER BY id ASC LIMIT ${pageSize}
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
      (SELECT COUNT(DISTINCT barcode) FROM price_alerts WHERE user_id = ${userId} AND active = TRUE) AS alerts_count
  `;
  return {
    scanCount: Number(summary?.scan_count ?? 0),
    favouritesCount: Number(summary?.favourites_count ?? 0),
    alertsCount: Number(summary?.alerts_count ?? 0),
  };
}

function validGuestBarcode(value) {
  return /^\d{8,14}$/.test(String(value || '').replace(/\D/g, ''));
}

function validGuestDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function migrationKey(scan) {
  // Prefer a client-provided stable identifier where available. The canonical
  // fallback makes the usual localStorage record idempotent across retries.
  const sourceId = scan.clientId ?? scan.client_id ?? scan.id ?? '';
  const canonical = [
    sourceId,
    String(scan.barcode || '').replace(/\D/g, ''),
    String(scan.productName ?? scan.product_name ?? '').trim(),
    Number.isFinite(Number(scan.lastPrice ?? scan.last_price)) ? Number(scan.lastPrice ?? scan.last_price) : '',
    String(scan.scannedAt ?? scan.scanned_at ?? ''),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

function normaliseGuestScan(scan) {
  const barcode = String(scan?.barcode || '').replace(/\D/g, '');
  const productName = String(scan?.productName ?? scan?.product_name ?? '').trim();
  const scannedAt = validGuestDate(scan?.scannedAt ?? scan?.scanned_at);
  const priceValue = scan?.lastPrice ?? scan?.last_price;
  const lastPrice = Number.isFinite(Number(priceValue)) && Number(priceValue) > 0 && Number(priceValue) <= 100000
    ? Number(priceValue) : null;
  if (!validGuestBarcode(barcode) || !productName || productName.length > 240 || !scannedAt) return null;
  return { barcode, productName, lastPrice, scannedAt, migrationKey: migrationKey(scan) };
}

function normaliseGuestFavourite(favourite) {
  const barcode = String(favourite?.barcode || '').replace(/\D/g, '');
  const productName = String(favourite?.productName ?? favourite?.product_name ?? '').trim();
  if (!validGuestBarcode(barcode) || !productName || productName.length > 240) return null;
  return { barcode, productName };
}

async function migrateGuestData(userId, payload) {
  const scans = (Array.isArray(payload?.scans) ? payload.scans : []).slice(0, 250).map(normaliseGuestScan).filter(Boolean);
  const favouritesToAdd = (Array.isArray(payload?.favourites) ? payload.favourites : []).slice(0, 250).map(normaliseGuestFavourite).filter(Boolean);
  await sql.begin(async (transaction) => {
    for (const scan of scans) {
      await transaction`
        INSERT INTO scan_history (user_id, barcode, product_name, last_price, scanned_at, migration_key)
        VALUES (${userId}, ${scan.barcode}, ${scan.productName}, ${scan.lastPrice}, ${scan.scannedAt}, ${scan.migrationKey})
        ON CONFLICT (user_id, migration_key) WHERE migration_key IS NOT NULL DO NOTHING
      `;
    }
    for (const favourite of favouritesToAdd) {
      await transaction`
        INSERT INTO favourites (user_id, barcode, product_name)
        VALUES (${userId}, ${favourite.barcode}, ${favourite.productName})
        ON CONFLICT (user_id, barcode) DO UPDATE SET product_name = EXCLUDED.product_name
      `;
    }
  });
  return getUserSummary(userId);
}

module.exports = {
  sql, initSchema, checkDatabase, isDatabaseConfigured, recordProductRequest, getProductRequest, listProductRequests,
  recordProductRequestOutcome, getCoverageStats, upsertUser, createPasswordUser, getPasswordUser, listScanHistory, recordScan,
  listFavourites, addFavourite, removeFavourite, listAlerts, createAlert, deactivateAlert,
  getActiveAlerts, recordAlertSent, getUserSummary, migrateGuestData,
};

/** Transaction advisory locks work with Neon's transaction pooler and release
 * automatically on rollback or process death. A separate lock pool avoids data
 * query deadlocks when the worker-wide and product locks are both held.
 */
async function withDatabaseLock(namespace, key, callback) {
  if (!databaseConfigured) throw databaseUnavailableError();
  return lockSql.begin(async (tx) => {
    const [row] = await tx`SELECT pg_try_advisory_xact_lock(${namespace}::INTEGER, hashtext(${String(key)})) AS locked`;
    if (row.locked !== true) return { acquired: false, result: null };
    let held = true;
    const heartbeat = setInterval(() => { tx`SELECT 1`.catch(() => { held = false; }); }, 10000);
    try {
      const result = await callback({ isHeld: () => held });
      if (!held) throw new Error('Database refresh lock was lost.');
      return { acquired: true, result };
    } finally { held = false; clearInterval(heartbeat); }
  });
}

async function getWatchlistCandidates(limit = 200) {
  const size = Math.min(1000, Math.max(1, Number(limit) || 200));
  const watchQuota = Math.max(1, Math.floor(size * 0.8));
  const historyQuota = size - watchQuota;
  return sql`
    WITH watched AS (
      SELECT barcode FROM favourites
      UNION SELECT barcode FROM price_alerts WHERE active = TRUE
    ), historical AS (
      SELECT product_id AS barcode FROM retailer_prices
      UNION SELECT barcode FROM products
      UNION SELECT barcode FROM product_requests
    ), candidates AS (
      SELECT barcode, 'watch' AS kind FROM watched
      UNION ALL
      SELECT barcode, 'history' AS kind FROM historical WHERE barcode NOT IN (SELECT barcode FROM watched)
    ), ranked AS (
      SELECT c.barcode, c.kind, w.last_checked_at,
        ROW_NUMBER() OVER (PARTITION BY c.kind ORDER BY w.last_checked_at ASC NULLS FIRST, c.barcode) AS rank
      FROM candidates c LEFT JOIN watchlist_checks w ON w.barcode = c.barcode
      WHERE c.barcode ~ '^[0-9]{8,14}$'
    )
    SELECT r.barcode, r.kind, r.last_checked_at,
      COUNT(*) OVER () AS total_candidates,
      COUNT(*) FILTER (WHERE r.kind = 'watch') OVER () AS total_watched,
      COALESCE(p.name, f.product_name, pr.product_hint) AS product_name
    FROM ranked r
    LEFT JOIN products p ON p.barcode = r.barcode
    LEFT JOIN product_requests pr ON pr.barcode = r.barcode
    LEFT JOIN LATERAL (SELECT product_name FROM favourites WHERE barcode = r.barcode ORDER BY added_at DESC LIMIT 1) f ON TRUE
    ORDER BY CASE WHEN (r.kind = 'watch' AND r.rank <= ${watchQuota})
      OR (r.kind = 'history' AND r.rank <= ${historyQuota}) THEN 0 ELSE 1 END,
      r.rank::NUMERIC / CASE WHEN r.kind = 'watch' THEN ${watchQuota} ELSE ${Math.max(1, historyQuota)} END,
      r.last_checked_at ASC NULLS FIRST, r.barcode
    LIMIT ${size}
  `;
}

function positivePrice(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}

function safeSourceUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch (_error) { return null; }
}

function cleanComparisonResults(results) {
  return (Array.isArray(results) ? results : []).map((item) => {
    const stamp = item.updated_at ?? item.updatedAt ?? item.scraped_at;
    const date = stamp ? new Date(stamp) : null;
    const validDate = date && Number.isFinite(date.getTime()) && date.getTime() <= Date.now() + 60000;
    return {
      retailer: String(item.retailer || 'unknown').slice(0, 80),
      available: item.available === true && positivePrice(item.price),
      price: item.available === true && positivePrice(item.price) ? Number(item.price) : null,
      updated_at: validDate ? date.toISOString() : null,
      url: safeSourceUrl(item.url), stale: Boolean(item.stale) || !validDate,
      from_cache: Boolean(item.from_cache), currency: 'ZAR',
    };
  });
}

async function recordComparisonCheck(barcode, comparison, { failed = false } = {}) {
  const results = cleanComparisonResults(comparison?.results);
  const best = results.filter((item) => item.available).sort((a, b) => a.price - b.price)[0] ?? null;
  const availability = failed ? 'failed' : best ? 'available' : 'unavailable';
  return sql.begin(async (tx) => {
    const [check] = await tx`INSERT INTO watchlist_checks (barcode, availability, results, last_available_at)
      VALUES (${barcode}, ${availability}, ${tx.json(results)}, ${best ? new Date() : null})
      ON CONFLICT (barcode) DO UPDATE SET last_checked_at = NOW(), availability = EXCLUDED.availability,
        results = EXCLUDED.results,
        last_available_at = COALESCE(EXCLUDED.last_available_at, watchlist_checks.last_available_at)
      RETURNING *`;
    await tx`INSERT INTO watchlist_observations (barcode, checked_at, availability, best_price, retailer, source_updated_at, source_url)
      VALUES (${barcode}, ${check.last_checked_at}, ${availability}, ${best?.price ?? null},
        ${best?.retailer ?? null}, ${best?.updated_at ?? null}, ${best?.url ?? null})`;
    return check;
  });
}

async function getWatchlistItems(userId, onlyBarcode = null) {
  return sql`
    WITH private_items AS (
      SELECT barcode, product_name, TRUE AS favourite FROM favourites WHERE user_id = ${userId}
      UNION ALL
      SELECT barcode, NULL AS product_name, FALSE AS favourite FROM price_alerts WHERE user_id = ${userId} AND active = TRUE
    ), items AS (
      SELECT barcode, MAX(product_name) AS product_name, BOOL_OR(favourite) AS favourite FROM private_items GROUP BY barcode
    )
    SELECT i.*, COALESCE(p.name, i.product_name, pr.product_hint) AS display_name,
      w.last_checked_at, w.last_available_at, w.availability, w.results,
      COALESCE(prices.latest_prices, '[]'::JSONB) AS latest_prices
    FROM items i LEFT JOIN products p ON p.barcode = i.barcode
    LEFT JOIN product_requests pr ON pr.barcode = i.barcode
    LEFT JOIN watchlist_checks w ON w.barcode = i.barcode
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(ROW_TO_JSON(latest)) AS latest_prices FROM (
        SELECT DISTINCT ON (retailer) retailer, price, scraped_at AS updated_at, url, TRUE AS available
        FROM retailer_prices WHERE product_id = i.barcode ORDER BY retailer, scraped_at DESC, id DESC
      ) latest
    ) prices ON TRUE
    WHERE ${onlyBarcode}::TEXT IS NULL OR i.barcode = ${onlyBarcode}
    ORDER BY i.favourite DESC, i.barcode
  `;
}

async function getWatchlistTrend(userId, barcode, days = 30) {
  // Authorization is performed in SQL as well as at the HTTP boundary.
  return sql`
    SELECT DATE_TRUNC('day', checked_at) AS checked_at, MIN(best_price) AS best_price,
      COUNT(*)::INTEGER AS checks, COUNT(best_price)::INTEGER AS available_checks
    FROM watchlist_observations
    WHERE barcode = ${barcode} AND checked_at >= NOW() - ${days} * INTERVAL '1 day'
      AND (EXISTS (SELECT 1 FROM favourites WHERE user_id = ${userId} AND barcode = ${barcode})
        OR EXISTS (SELECT 1 FROM price_alerts WHERE user_id = ${userId} AND barcode = ${barcode} AND active = TRUE))
    GROUP BY DATE_TRUNC('day', checked_at) ORDER BY checked_at ASC
  `;
}

async function startWatchlistRun(id) {
  // Caller holds the global worker lock, so any previous running record belongs
  // to an interrupted worker rather than a concurrent active worker.
  await sql`UPDATE watchlist_runs SET state = 'interrupted', finished_at = NOW() WHERE state = 'running'`;
  await sql`INSERT INTO watchlist_runs (id) VALUES (${id})`;
}

async function updateWatchlistRun(id, metrics, state = 'running') {
  await sql`UPDATE watchlist_runs SET metrics = ${sql.json(metrics)}, state = ${state},
    finished_at = CASE WHEN ${state} = 'running' THEN NULL ELSE NOW() END WHERE id = ${id}`;
}

async function getWatchlistRunStatus() {
  const [latest] = await sql`SELECT started_at, finished_at, state, metrics FROM watchlist_runs ORDER BY started_at DESC LIMIT 1`;
  const [lastSuccess] = await sql`SELECT finished_at FROM watchlist_runs WHERE state = 'complete' ORDER BY finished_at DESC LIMIT 1`;
  return { latestRun: latest ?? null, lastSuccessfulRunAt: lastSuccess?.finished_at ?? null };
}

async function claimAlertDelivery(alert, price, token) {
  const [claim] = await sql`INSERT INTO alert_delivery_claims (user_id, barcode, price, claim_token)
    SELECT user_id, barcode, ${price}, ${token} FROM price_alerts
    WHERE id = ${alert.id} AND active = TRUE AND target_price > ${price}
    ON CONFLICT (user_id, barcode) DO UPDATE SET price = EXCLUDED.price,
      claim_token = EXCLUDED.claim_token, attempted_at = NOW(), sent_at = NULL, state = 'claimed'
    WHERE alert_delivery_claims.attempted_at < NOW() - INTERVAL '24 hours'
      OR (alert_delivery_claims.price <> EXCLUDED.price AND alert_delivery_claims.state <> 'claimed')
    RETURNING claim_token`;
  return claim ?? null;
}

async function completeAlertDelivery(alert, price, token, sent) {
  await sql.begin(async (tx) => {
    const claimed = await tx`UPDATE alert_delivery_claims SET state = ${sent ? 'sent' : 'uncertain'},
      sent_at = CASE WHEN ${sent} THEN NOW() ELSE NULL END
      WHERE user_id = ${alert.user_id} AND barcode = ${alert.barcode} AND claim_token = ${token}
      RETURNING claim_token`;
    if (sent && claimed.length) await tx`UPDATE price_alerts SET last_sent_at = NOW(), last_sent_price = ${price}
      WHERE user_id = ${alert.user_id} AND barcode = ${alert.barcode}`;
  });
}

Object.assign(module.exports, {
  withDatabaseLock, getWatchlistCandidates, recordComparisonCheck, cleanComparisonResults,
  getWatchlistItems, getWatchlistTrend, startWatchlistRun, updateWatchlistRun, getWatchlistRunStatus,
  claimAlertDelivery, completeAlertDelivery,
  closeDatabase: async () => {
    if (databaseConfigured) await Promise.all([sql.end({ timeout: 5 }), lockSql.end({ timeout: 5 })]);
  },
});
