'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Resolve the SQLite database path.
 *
 * Priority:
 *   1. DB_PATH env var (explicit override)
 *   2. /data/pricecheck.db  — only if /data is writable (Render persistent disk)
 *   3. <project-root>/data/pricecheck.db  — works on Render free tier (ephemeral)
 *   4. <os.tmpdir()>/pricecheck.db        — last-resort fallback
 *
 * Note: Render free-tier instances do NOT support persistent disks, so /data
 * will not exist / will not be writable.  We probe before using it so the
 * server does not crash on startup with EACCES.
 */
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  // Probe /data
  const persistentPath = '/data/pricecheck.db';
  try {
    fs.mkdirSync('/data', { recursive: true });
    // Quick write-test
    const testFile = '/data/.write_test';
    fs.writeFileSync(testFile, '1');
    fs.unlinkSync(testFile);
    return persistentPath; // /data is writable — use it
  } catch (_) {
    // /data not available or not writable — fall through
  }

  // Use project-local data dir (ephemeral on Render free tier, fine for MVP)
  const localPath = path.join(__dirname, '..', 'data', 'pricecheck.db');
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    return localPath;
  } catch (_) {
    // Last resort: OS temp dir
    return path.join(os.tmpdir(), 'pricecheck.db');
  }
}

const DB_PATH = resolveDbPath();
console.log(`[db] SQLite path: ${DB_PATH}`);

// Ensure data directory exists (no-op if already created above)
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    barcode    TEXT PRIMARY KEY,          -- EAN-13 barcode
    name       TEXT NOT NULL,
    brand      TEXT,
    pack_size  TEXT,
    image_url  TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS retailer_prices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    retailer   TEXT NOT NULL,             -- e.g. 'woolworths'
    product_id TEXT NOT NULL,             -- FK -> products.barcode
    price      REAL NOT NULL,             -- numeric price in ZAR
    price_str  TEXT,                      -- raw string e.g. "R 24.95"
    scraped_at TEXT NOT NULL,             -- ISO-8601 UTC
    url        TEXT,
    promo_flag INTEGER DEFAULT 0,         -- 1 = on promotion
    FOREIGN KEY (product_id) REFERENCES products(barcode)
  );

  CREATE INDEX IF NOT EXISTS idx_retailer_prices_lookup
    ON retailer_prices (retailer, product_id, scraped_at DESC);
`);

module.exports = db;
