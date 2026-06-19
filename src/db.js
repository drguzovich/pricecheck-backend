'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// In production (Render), use the persistent disk at /data
// In development, use a local ./data directory
const DB_PATH =
  process.env.DB_PATH ||
  (process.env.NODE_ENV === 'production'
    ? '/data/pricecheck.db'
    : path.join(__dirname, '..', 'data', 'pricecheck.db'));

// Ensure data directory exists
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
