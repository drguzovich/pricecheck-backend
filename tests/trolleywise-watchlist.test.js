'use strict';

// All monetary values and identities below are synthetic test fixtures.
// The real DB is disabled before modules load; no retailer/provider is called.
process.env.DATABASE_URL = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const { runWatchlistWorker, watchlistItem, integrateWatchlist, workerConfiguration } = require('../src/watchlist');
const { evaluatePriceAlerts, shouldNotify, lowestAvailable } = require('../src/alerts');
const { forceRefreshComparison } = require('../src/priceService');

const BARCODE = '6000000000001';
const OTHER = '6000000000002';
const stamp = new Date().toISOString();
const price = (value = 20, extra = {}) => ({ available: true, stale: false, price: value,
  retailer: 'fixture_retailer', updated_at: stamp, url: 'https://retailer.invalid/item', ...extra });
const comparison = (barcode = BARCODE, value = 20) => ({ barcode, product: { name: 'Synthetic test item' }, results: [price(value)] });
const alert = (id = 1, extra = {}) => ({ id, user_id: id, barcode: BARCODE, active: true, target_price: 25,
  email: `fixture-${id}@example.invalid`, last_sent_at: null, last_sent_price: null, ...extra });
const fakeLock = async (_namespace, _key, callback) => ({ acquired: true, result: await callback({ isHeld: () => true }) });
const noop = async () => {};

function mockSqlDatabase(responder = () => []) {
  const queries = []; const options = [];
  function postgres(_url, config) {
    options.push(config);
    function tag(strings, ...values) {
      if (!strings.raw) return { list: strings };
      const text = strings.join('?'); queries.push({ text, values });
      return Promise.resolve(responder(text, values));
    }
    tag.begin = async (callback) => callback(tag);
    tag.json = (value) => value;
    tag.end = async () => {};
    return tag;
  }
  const context = { module: { exports: {} }, require: (name) => name === 'postgres' ? postgres : require(name),
    process: { env: { DATABASE_URL: 'postgres://fixture.invalid/test' } }, console: { log() {} },
    URL, Buffer, Date, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/db'), 'utf8'), context);
  return { api: context.module.exports, queries, options };
}

test('schema is additive and legacy alert duplicates are not deleted', async () => {
  const fixture = mockSqlDatabase();
  await fixture.api.initSchema();
  const statements = fixture.queries.map((query) => query.text);
  assert.ok(statements.some((query) => /CREATE TABLE IF NOT EXISTS watchlist_checks/.test(query)));
  assert.ok(statements.some((query) => /CREATE TABLE IF NOT EXISTS watchlist_runs/.test(query)));
  assert.ok(statements.some((query) => /CREATE UNIQUE INDEX IF NOT EXISTS idx_price_alerts_canonical/.test(query) && /dedupe_key IS NOT NULL/.test(query)));
  assert.ok(!statements.some((query) => /^\s*(DROP|DELETE|TRUNCATE)\b/i.test(query)));
  assert.equal(typeof fixture.api.sql, 'function');
});

test('queue SQL unions favourites and active alerts, deduplicates and interleaves fair rotation', async () => {
  const fixture = mockSqlDatabase();
  await fixture.api.getWatchlistCandidates(200);
  const query = fixture.queries[0];
  assert.match(query.text, /SELECT barcode FROM favourites\s+UNION SELECT barcode FROM price_alerts WHERE active = TRUE/);
  assert.match(query.text, /SELECT product_id AS barcode FROM retailer_prices/);
  assert.match(query.text, /SELECT barcode FROM product_requests/);
  assert.match(query.text, /ROW_NUMBER\(\) OVER \(PARTITION BY c.kind ORDER BY w.last_checked_at ASC NULLS FIRST/);
  assert.match(query.text, /r.rank::NUMERIC \/ CASE/);
  assert.ok(query.values.includes(160)); assert.ok(query.values.includes(40));
});

test('database lock is transaction scoped and the independent pools remain bounded', async () => {
  const fixture = mockSqlDatabase((query) => /pg_try_advisory_xact_lock/.test(query) ? [{ locked: true }] : []);
  let called = false;
  const result = await fixture.api.withDatabaseLock(71001, 'watchlist', async (ownership) => { called = ownership.isHeld(); return 42; });
  assert.equal(result.acquired, true); assert.equal(result.result, 42); assert.equal(called, true);
  assert.match(fixture.queries[0].text, /pg_try_advisory_xact_lock/);
  assert.ok(!fixture.queries.some((query) => /pg_advisory_unlock/.test(query.text)));
  assert.equal(fixture.options[0].max + fixture.options[1].max, 5);
});

test('canonical alert creation reuses a legacy row under transaction lock', async () => {
  const fixture = mockSqlDatabase((query) => /SELECT id FROM price_alerts/.test(query) ? [{ id: 7 }]
    : /UPDATE price_alerts SET target_price/.test(query) ? [{ id: 7, barcode: BARCODE, active: true }] : []);
  const created = await fixture.api.createAlert(11, { barcode: BARCODE, targetPrice: 25, email: 'fixture@example.invalid' });
  assert.equal(created.id, 7);
  assert.ok(fixture.queries.some((query) => /pg_advisory_xact_lock/.test(query.text)));
  assert.ok(fixture.queries.some((query) => /dedupe_key = 'canonical'/.test(query.text)));
  assert.ok(!fixture.queries.some((query) => /^\s*DELETE\b/.test(query.text)));
});

test('alert SQL paginates by canonical ID and enforces durable overlap protection', async () => {
  const fixture = mockSqlDatabase();
  await fixture.api.getActiveAlerts({ afterId: 501, limit: 250, barcodes: [BARCODE] });
  await fixture.api.claimAlertDelivery(alert(), 20, '00000000-0000-0000-0000-000000000001');
  const page = fixture.queries.find((query) => /WITH canonical AS/.test(query.text));
  const claim = fixture.queries.find((query) => /INSERT INTO alert_delivery_claims/.test(query.text));
  assert.match(page.text, /DISTINCT ON \(user_id, barcode\)/);
  assert.match(page.text, /WHERE active = TRUE/);
  assert.match(page.text, /WHERE id > \?/);
  assert.ok(page.values.includes(501));
  assert.match(claim.text, /ON CONFLICT \(user_id, barcode\)/);
  assert.match(claim.text, /target_price > \?/);
  assert.match(claim.text, /INTERVAL '24 hours'/);
});

test('worker deduplicates barcodes across users and refreshes even without mail', async () => {
  const refreshes = []; const states = [];
  const result = await runWatchlistWorker({ isConfigured: () => true, lock: fakeLock,
    candidates: async () => [{ barcode: BARCODE, kind: 'watch', product_name: 'Named no-price favourite' },
      { barcode: BARCODE, kind: 'watch' }, { barcode: OTHER, kind: 'history' }],
    refresh: async (barcode) => { refreshes.push(barcode); return comparison(barcode); },
    startRun: noop, updateRun: async (_id, metrics, state) => states.push({ metrics: { ...metrics }, state }),
    evaluate: (map, options) => evaluatePriceAlerts(map, { ...options, enabled: false }), onProgress() {},
  });
  assert.deepEqual(refreshes, [BARCODE, OTHER]); assert.equal(result.selected, 2); assert.equal(result.checked, 2);
  assert.equal(result.deliverySkipped, 'mail_not_configured'); assert.equal(result.state, 'complete');
  assert.equal(states.at(-1).state, 'complete');
});

test('worker-wide concurrency lock suppresses overlap without refreshing', async () => {
  let called = false;
  const result = await runWatchlistWorker({ isConfigured: () => true,
    lock: async () => ({ acquired: false }), refresh: async () => { called = true; }, onProgress() {},
  });
  assert.equal(result.skipped, 'worker_already_running'); assert.equal(called, false);
});

test('worker bounds runtime and records deferred work rather than claiming completion', async () => {
  let time = 0; const checked = [];
  const result = await runWatchlistWorker({ isConfigured: () => true, lock: fakeLock, now: () => time, maxRuntimeMs: 60000,
    candidates: async () => [{ barcode: BARCODE, kind: 'watch' }, { barcode: OTHER, kind: 'watch' }],
    refresh: async (barcode) => { checked.push(barcode); time += 10000; return comparison(barcode); },
    startRun: noop, updateRun: noop, evaluate: async () => ({ checked: 0, sent: 0, failed: 0 }), onProgress() {},
  });
  assert.deepEqual(checked, [BARCODE]); assert.equal(result.deferred, 1); assert.equal(result.state, 'partial');
});

test('failed items get check outcomes for fair rotation and do not block other items', async () => {
  const failures = [];
  const result = await runWatchlistWorker({ isConfigured: () => true, lock: fakeLock,
    candidates: async () => [{ barcode: BARCODE, kind: 'watch' }, { barcode: OTHER, kind: 'watch' }],
    refresh: async (barcode) => { if (barcode === BARCODE) throw new Error('Synthetic failure'); return comparison(barcode); },
    recordFailure: async (barcode) => failures.push(barcode), startRun: noop, updateRun: noop,
    evaluate: async () => ({ checked: 0, sent: 0, failed: 0 }), onProgress() {},
  });
  assert.deepEqual(failures, [BARCODE]); assert.equal(result.failed, 1); assert.equal(result.checked, 1); assert.equal(result.state, 'partial');
});

test('strict target, inactive filtering, stale exclusion and cooldown are enforced', () => {
  assert.equal(shouldNotify(alert(), price(25)), false);
  assert.equal(shouldNotify(alert(), price(24.99)), true);
  assert.equal(shouldNotify(alert(1, { active: false }), price(20)), false);
  assert.equal(lowestAvailable([price(-1), price(0), price(1, { stale: true }), price(5)]).price, 5);
  assert.equal(lowestAvailable([price(1, { updated_at: null })]), null);
  assert.equal(lowestAvailable([price(1, { updated_at: new Date(Date.now() - 7 * 3600000).toISOString() })]), null);
  assert.equal(shouldNotify(alert(1, { last_sent_at: stamp, last_sent_price: 20 }), price(20)), false);
  assert.equal(shouldNotify(alert(1, { target_price: NaN }), price(20)), false);
});

test('alert evaluation checks more than 500 recipients using one supplied comparison', async () => {
  const recipients = Array.from({ length: 751 }, (_value, index) => alert(index + 1));
  let sent = 0; const cursors = [];
  const result = await evaluatePriceAlerts(new Map([[BARCODE, comparison()]]), {
    enabled: true, loadPage: async ({ afterId, limit, barcodes }) => {
      cursors.push(afterId); assert.deepEqual(barcodes, [BARCODE]);
      return recipients.filter((item) => item.id > afterId).slice(0, limit);
    }, claim: async () => ({ claim_token: 'fixture' }), complete: noop,
    send: async (message) => { assert.match(message.subject, /^TrolleyWise alert:/); sent += 1; },
  });
  assert.equal(result.checked, 751); assert.equal(sent, 751); assert.deepEqual(cursors, [0, 250, 500, 750]);
});

test('overlapping alert evaluators cannot send the same notification twice', async () => {
  let claimed = false; let sent = 0;
  const options = { enabled: true, loadPage: async () => [alert()],
    claim: async () => { if (claimed) return null; claimed = true; return { claim_token: 'fixture' }; },
    complete: noop, send: async () => { sent += 1; },
  };
  const map = new Map([[BARCODE, comparison()]]);
  await Promise.all([evaluatePriceAlerts(map, options), evaluatePriceAlerts(map, options)]);
  assert.equal(sent, 1);
});

test('uncertain delivery preserves a claim rather than blind immediate retry', async () => {
  const completions = [];
  const result = await evaluatePriceAlerts(new Map([[BARCODE, comparison()]]), {
    enabled: true, loadPage: async () => [alert()], claim: async () => ({ claim_token: 'fixture' }),
    complete: async (_alert, _price, _token, sent) => completions.push(sent),
    send: async () => { throw new Error('Synthetic timeout'); },
  });
  assert.equal(result.failed, 1); assert.equal(result.sent, 0); assert.deepEqual(completions, [false]);
});

test('watchlist distinguishes actual prices, stale timestamps and latest unavailability', () => {
  const base = { barcode: BARCODE, display_name: 'Named favourite', favourite: true, results: [price(20)], latest_prices: [price(18)], last_checked_at: stamp };
  assert.equal(watchlistItem({ ...base, availability: 'available' }).best.price, 20);
  const unavailable = watchlistItem({ ...base, availability: 'unavailable', results: [] });
  assert.equal(unavailable.best, null); assert.equal(unavailable.lastKnownBest.price, 18); assert.equal(unavailable.availability, 'unavailable');
  const stale = watchlistItem({ ...base, availability: 'available', results: [price(20, { updated_at: new Date(Date.now() - 7 * 3600000).toISOString() })] });
  assert.equal(stale.stale, true);
  const missing = watchlistItem({ barcode: OTHER, display_name: 'Named no-price item', favourite: true, results: [], latest_prices: [] });
  assert.equal(missing.best, null); assert.equal(missing.availability, 'not_checked'); assert.equal(missing.last_checked_at, null);
});

test('comparison single-flight refreshes a barcode once with fake adapters and preserves name hints', async () => {
  let calls = 0;
  const adapter = { RETAILER: 'fixture_retailer', scrapeByBarcode: async (barcode, options) => {
    calls += 1; await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(options.productName, 'Named favourite');
    return { barcode, retailer: 'fixture_retailer', name: options.productName, price: 20, scraped_at: stamp };
  } };
  const options = { adapters: [adapter], productHint: { name: 'Named favourite' }, productMetadata: null };
  const results = await Promise.all([forceRefreshComparison(BARCODE, options), forceRefreshComparison(BARCODE, options)]);
  assert.equal(calls, 1); assert.equal(results[0], results[1]);
});

test('private routes reject guests/cross-user access and accept targets for named no-price favourites', async () => {
  const names = ['upsertUser', 'getWatchlistItems', 'getWatchlistTrend', 'getWatchlistRunStatus', 'createAlert'];
  const saved = Object.fromEntries(names.map((name) => [name, db[name]]));
  const priorSecret = process.env.USER_SYNC_JWT_SECRET;
  process.env.USER_SYNC_JWT_SECRET = 'isolated-watchlist-test-secret-not-a-real-credential';
  const named = { barcode: BARCODE, display_name: 'Named no-price favourite', favourite: true, results: [], latest_prices: [] };
  db.upsertUser = async (principal) => ({ id: principal.accountId === 'fixture-A' ? 11 : 22, email: principal.email });
  db.getWatchlistItems = async (userId, barcode) => userId === 11 && (!barcode || barcode === BARCODE) ? [named] : [];
  db.getWatchlistTrend = async () => [];
  db.getWatchlistRunStatus = async () => ({ latestRun: null, lastSuccessfulRunAt: null });
  let target = null;
  db.createAlert = async (userId, input) => { assert.equal(userId, 11); target = input.targetPrice; return alert(13); };
  const app = express(); app.use(express.json()); integrateWatchlist(app);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = (id) => ({ Authorization: `Bearer ${jwt.sign({ account_id: id, email: 'fixture@example.invalid' }, process.env.USER_SYNC_JWT_SECRET, { algorithm: 'HS256' })}` });
  try {
    assert.equal((await fetch(`${base}/users/watchlist`)).status, 401);
    assert.equal((await fetch(`${base}/users/watchlist/${BARCODE}/trend`, { headers: auth('fixture-B') })).status, 404);
    assert.equal((await fetch(`${base}/users/watchlist/${BARCODE}/refresh`, { method: 'POST', headers: auth('fixture-B') })).status, 404);
    const response = await fetch(`${base}/users/watchlist`, { headers: auth('fixture-A') });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json(); assert.equal(body.items[0].best, null); assert.equal(body.items[0].last_checked_at, null);
    const created = await fetch(`${base}/users/watchlist/${BARCODE}/alert`, { method: 'POST',
      headers: { ...auth('fixture-A'), 'Content-Type': 'application/json' }, body: JSON.stringify({ target_price: 19.99 }) });
    assert.equal(created.status, 201); assert.equal(target, 19.99);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const name of names) db[name] = saved[name];
    if (priorSecret === undefined) delete process.env.USER_SYNC_JWT_SECRET; else process.env.USER_SYNC_JWT_SECRET = priorSecret;
  }
});

test('configuration never substitutes readiness for proof of actual previous success', () => {
  const configuration = workerConfiguration();
  assert.equal(configuration.databaseConfigured, false); assert.equal(configuration.workerConfigured, false);
  assert.equal(configuration.scheduleHours, 6); assert.match(configuration.monitoringMessage, /does not prove/);
});
