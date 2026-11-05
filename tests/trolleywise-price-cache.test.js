'use strict';

// SYNTHETIC FIXTURES ONLY. Execute the actual priceService source in a VM whose
// require() permits only in-memory DB, metadata, and adapter mocks. No actual
// database connection, user records, retailer/provider, network, or server runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/priceService'), 'utf8');
const BARCODE = '6000000000001';
const OTHER = '6000000000002';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (age = 0) => new Date(NOW - age).toISOString();
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('Synthetic fixture did not reach the expected state');
}
const product = (barcode = BARCODE, name = 'Synthetic fixture item') => ({
  barcode, name, brand: 'Fixture brand', pack_size: '500g', image_url: null,
});
const positive = (retailer, barcode = BARCODE, age = HOUR, price = 20) => ({
  ...product(barcode), retailer, price, price_str: `R ${price.toFixed(2)}`,
  scraped_at: at(age), url: 'https://fixture.invalid/product', promo_flag: false,
});
const check = (results, { age = 0, availability = results.some((row) => row.available) ? 'available' : 'unavailable' } = {}) => ({
  last_checked_at: at(age), availability, results,
});
const negative = (retailer, extra = {}) => ({ retailer, available: false, price: null,
  updated_at: null, stale: true, from_cache: false, ...extra });

function fixture({ prices = [], products = [], checks = new Map(), adapters, configured = true,
  lock = null, request = null, metadata = undefined } = {}) {
  const state = { prices: prices.map((row) => ({ ...row })), products: new Map(products.map((row) => [row.barcode, { ...row }])),
    checks, queries: [], checkWrites: [], productRequestWrites: [], lockCalls: [], calls: [], logs: [], timers: new Map(), delays: [] };
  for (const row of prices) if (!state.products.has(row.barcode)) state.products.set(row.barcode, product(row.barcode, row.name));
  let nextTimer = 1;
  const defaultNames = ['fixture_woolworths', 'fixture_pnp', 'fixture_checkers', 'spar'];
  const defaults = defaultNames.map((name) => ({ RETAILER: name,
    scrapeByBarcode: async () => { throw new Error('Synthetic default adapter must not be used'); } }));
  const selected = adapters ?? defaults;
  const wrapped = selected.map((adapter) => ({ RETAILER: adapter.RETAILER,
    scrapeByBarcode: (barcode, options) => {
      state.calls.push({ retailer: adapter.RETAILER, barcode, options });
      return adapter.scrapeByBarcode(barcode, options);
    } }));
  function sql(strings, ...values) {
    const text = strings.join('?');
    state.queries.push({ text, values });
    if (/FROM \(SELECT \?::TEXT AS barcode\) requested/.test(text)) {
      assert.match(text, /LEFT JOIN watchlist_checks wc ON wc.barcode = requested.barcode/);
      assert.match(text, /WHERE product_id = \?/);
      assert.match(text, /ORDER BY retailer, scraped_at DESC, id DESC/);
      assert.equal(values[0], values[1], 'Synthetic query must scope observations and prices to the same barcode');
      const barcode = values[0];
      const latest = new Map();
      for (const row of state.prices.filter((item) => item.barcode === barcode).sort((a, b) => new Date(b.scraped_at) - new Date(a.scraped_at))) {
        if (!latest.has(row.retailer)) latest.set(row.retailer, row);
      }
      const observed = state.checks.get(barcode);
      return Promise.resolve((latest.size ? [...latest.values()] : [{ retailer: null }]).map((row) => ({
        barcode, ...state.products.get(barcode), ...row,
        last_checked_at: observed?.last_checked_at ?? null,
        last_check_availability: observed?.availability ?? null,
        last_check_results: observed?.results ?? null,
      })));
    }
    if (/SELECT barcode, name, brand, pack_size, image_url\s+FROM products/.test(text)) {
      return Promise.resolve(state.products.has(values[0]) ? [state.products.get(values[0])] : []);
    }
    if (/INSERT INTO products/.test(text)) {
      const [barcode, name, brand, pack_size, image_url] = values;
      state.products.set(barcode, { barcode, name, brand, pack_size, image_url });
      return Promise.resolve([]);
    }
    if (/INSERT INTO retailer_prices/.test(text)) {
      const [retailer, barcode, price, price_str, scraped_at, url, promo_flag] = values;
      state.prices.push({ ...state.products.get(barcode), retailer, price, price_str, scraped_at, url, promo_flag });
      return Promise.resolve([]);
    }
    throw new Error(`Unexpected synthetic SQL: ${text}`);
  }
  const db = { sql, isDatabaseConfigured: () => configured,
    getProductRequest: async () => request,
    recordProductRequestOutcome: async (barcode, results) => { state.productRequestWrites.push({ barcode, results }); },
    // Mirrors the current database projection: provider failures have no source
    // price/timestamp; carried cached negatives retain their original timestamp.
    recordComparisonCheck: async (barcode, comparison) => {
      const results = comparison.results.map((row) => ({ retailer: row.retailer,
        available: row.available === true && Number(row.price) > 0,
        price: row.available === true && Number(row.price) > 0 ? Number(row.price) : null,
        updated_at: row.updated_at ?? null, stale: Boolean(row.stale) || !row.updated_at,
        from_cache: Boolean(row.from_cache), url: row.url ?? null, currency: 'ZAR' }));
      state.checks.set(barcode, check(results));
      state.checkWrites.push({ barcode, comparison });
    },
    withDatabaseLock: async (namespace, barcode, callback) => {
      state.lockCalls.push({ namespace, barcode });
      return lock ? lock(namespace, barcode, callback) : { acquired: true, result: await callback() };
    },
  };
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const modules = { './db': db, './productMetadata': {
    getProductMetadata: async () => {
      if (metadata !== undefined) return metadata;
      throw new Error('Actual metadata/network is forbidden in synthetic fixtures');
    },
  } };
  ['./scrapers/woolworths', './scrapers/pnp', './scrapers/checkers', './scrapers/spar'].forEach((path, index) => {
    modules[path] = wrapped[index] ?? defaults[index];
  });
  const context = { module: { exports: {} }, process: { env: {} }, Date: FixtureDate,
    console: { error: (message) => state.logs.push(message) },
    setTimeout: (callback, delay) => { const id = nextTimer++; state.timers.set(id, callback); state.delays.push(delay); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    require: (path) => {
      if (!(path in modules)) throw new Error(`Non-fixture dependency forbidden: ${path}`);
      return modules[path];
    },
  };
  vm.runInNewContext(source, context, { filename: 'priceService.synthetic-fixture.js' });
  return { api: context.module.exports, state, options: { adapters: wrapped, productMetadata: null },
    expireTimers: () => { for (const callback of [...state.timers.values()]) callback(); } };
}
const missingAdapter = (retailer) => ({ RETAILER: retailer,
  scrapeByBarcode: async () => ({ retailer, available: false, price: null, error: 'Synthetic verified absence' }) });
const offerAdapter = (retailer, price = 24) => ({ RETAILER: retailer,
  scrapeByBarcode: async (barcode) => positive(retailer, barcode, 0, price) });
const resultFor = (comparison, retailer) => comparison.results.find((row) => row.retailer === retailer);

 test('synthetic fixture: a forced unavailable refresh cannot resurrect a recent historical offer', async () => {
  const f = fixture({ prices: [positive('fixture_woolworths')], adapters: [missingAdapter('fixture_woolworths')] });
  const forced = await f.api.forceRefreshComparison(BARCODE, f.options);
  assert.equal(forced.results[0].available, false);
  const cached = await f.api.getComparison(BARCODE, f.options);
  assert.equal(cached.results[0].available, false);
  assert.equal(cached.results[0].price, null);
  assert.equal(cached.results[0].price_str, null);
  assert.equal(cached.results[0].from_cache, true);
  assert.equal(cached.results[0].stale, false);
  assert.equal(cached.results[0].updated_at, at());
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.prices.length, 1, 'Historical factual price is preserved, not deleted or relabelled');
  assert.equal(f.state.prices[0].scraped_at, at(HOUR));
  assert.equal(f.state.checkWrites.length, 1, 'A cached read is not a new provider observation');
});

 test('synthetic fixture: latest availability is per retailer, not just the overall comparison', async () => {
  const f = fixture({ prices: [positive('fixture_woolworths'), positive('fixture_pnp', BARCODE, HOUR, 30)],
    adapters: [missingAdapter('fixture_woolworths'), offerAdapter('fixture_pnp', 31)] });
  await f.api.forceRefreshComparison(BARCODE, f.options);
  assert.equal(f.state.checks.get(BARCODE).availability, 'available');
  const cached = await f.api.getComparison(BARCODE, f.options);
  assert.equal(resultFor(cached, 'fixture_woolworths').available, false);
  assert.equal(resultFor(cached, 'fixture_woolworths').price, null);
  assert.equal(resultFor(cached, 'fixture_pnp').available, true);
  assert.equal(resultFor(cached, 'fixture_pnp').price, 31);
  assert.equal(f.state.calls.length, 2);
});

 test('synthetic fixture: negative observations work without a product or historical positive row', async () => {
  const f = fixture({ adapters: [missingAdapter('fixture_woolworths')] });
  await f.api.forceRefreshComparison(BARCODE, f.options);
  assert.equal(f.state.products.size, 0);
  const cached = await f.api.getComparison(BARCODE, { ...f.options, productHint: { name: 'Synthetic no-price label' } });
  assert.equal(cached.product.name, 'Synthetic no-price label');
  assert.equal(cached.results[0].available, false);
  assert.equal(cached.results[0].price, null);
  assert.equal(cached.results[0].from_cache, true);
  assert.equal(f.state.calls.length, 1);
});

 test('synthetic fixture: a newer genuine positive beats an older unavailable or failed check', async () => {
  for (const availability of ['unavailable', 'failed']) {
    const f = fixture({ prices: [positive('fixture_woolworths', BARCODE, HOUR, 25)],
      checks: new Map([[BARCODE, check([negative('fixture_woolworths')], { age: 2 * HOUR, availability })]]),
      adapters: [missingAdapter('fixture_woolworths')] });
    const cached = await f.api.getComparison(BARCODE, f.options);
    assert.equal(cached.results[0].available, true);
    assert.equal(cached.results[0].price, 25);
    assert.equal(cached.results[0].updated_at, at(HOUR));
    assert.equal(f.state.calls.length, 0);
  }
});

 test('synthetic fixture: a newer failed check cannot expose the historical price as currently available', async () => {
  const f = fixture({ prices: [positive('fixture_woolworths')],
    checks: new Map([[BARCODE, check([], { availability: 'failed' })]]), adapters: [missingAdapter('fixture_woolworths')] });
  const cached = await f.api.getComparison(BARCODE, f.options);
  assert.equal(cached.results[0].available, false);
  assert.equal(cached.results[0].price, null);
  assert.match(cached.results[0].error, /failed/);
  assert.equal(f.state.prices.length, 1);
  assert.equal(f.state.calls.length, 0);
});

 test('synthetic fixture: repeated stale reads and manual refresh share one whole-barcode flight and lock', async () => {
  const gate = deferred();
  const adapters = ['fixture_woolworths', 'fixture_pnp'].map((retailer) => ({ RETAILER: retailer,
    scrapeByBarcode: async () => { await gate.promise; return { price: null, error: 'Synthetic absence' }; } }));
  const f = fixture({ adapters, prices: adapters.map((row) => positive(row.RETAILER, BARCODE, 5 * HOUR)) });
  const reads = await Promise.all(Array.from({ length: 5 }, () => f.api.getComparison(BARCODE, f.options)));
  await until(() => f.state.calls.length === 2);
  for (const read of reads) for (const row of read.results) {
    assert.equal(row.available, true);
    assert.equal(row.stale, true, 'Last-known factual offer is explicitly stale while refresh runs');
    assert.equal(row.from_cache, true);
    assert.equal(row.updated_at, at(5 * HOUR));
  }
  const manual = f.api.forceRefreshComparison(BARCODE, f.options);
  assert.equal(manual, f.api.forceRefreshComparison(BARCODE, f.options));
  assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.lockCalls.length, 1);
  assert.equal(f.state.lockCalls[0].namespace, 71002);
  assert.equal(f.state.lockCalls[0].barcode, BARCODE);
  assert.equal(f.state.checkWrites.length, 0);
  gate.resolve();
  await manual;
  const later = await f.api.getComparison(BARCODE, f.options);
  assert.ok(later.results.every((row) => !row.available && row.price === null && !row.stale));
  assert.equal(f.state.checkWrites.length, 1);
  assert.equal(f.state.timers.size, 0);
});

test('synthetic fixture: a stale response stays immediate when another retailer has no observation', async () => {
  const gate = deferred();
  const f = fixture({ prices: [positive('fixture_woolworths', BARCODE, 5 * HOUR)], adapters: [
    { RETAILER: 'fixture_woolworths', scrapeByBarcode: async (barcode) => {
      await gate.promise; return positive('fixture_woolworths', barcode, 0, 26);
    } }, offerAdapter('fixture_pnp', 30),
  ] });
  const stale = await f.api.getComparison(BARCODE, f.options);
  assert.equal(resultFor(stale, 'fixture_woolworths').stale, true);
  assert.equal(resultFor(stale, 'fixture_woolworths').price, 20);
  assert.equal(resultFor(stale, 'fixture_pnp').available, false);
  assert.equal(resultFor(stale, 'fixture_pnp').price, null);
  assert.match(resultFor(stale, 'fixture_pnp').error, /refresh in progress/);
  await until(() => f.state.calls.length === 2);
  assert.equal(f.state.lockCalls.length, 1);
  assert.equal(f.state.checkWrites.length, 0);
  const shared = f.api.forceRefreshComparison(BARCODE, f.options);
  gate.resolve();
  await shared;
  const later = await f.api.getComparison(BARCODE, f.options);
  assert.equal(resultFor(later, 'fixture_woolworths').price, 26);
  assert.equal(resultFor(later, 'fixture_pnp').price, 30);
  assert.equal(f.state.calls.length, 2);
});

 test('synthetic fixture: stale readers join an already-running worker/manual refresh', async () => {
  const gate = deferred();
  const f = fixture({ prices: [positive('fixture_woolworths', BARCODE, 5 * HOUR)], adapters: [{ RETAILER: 'fixture_woolworths',
    scrapeByBarcode: async (barcode) => { await gate.promise; return positive('fixture_woolworths', barcode, 0, 27); } }] });
  const worker = f.api.forceRefreshComparison(BARCODE, f.options);
  await until(() => f.state.calls.length === 1);
  const stale = await f.api.getComparison(BARCODE, f.options);
  assert.equal(stale.results[0].stale, true);
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.lockCalls.length, 1);
  gate.resolve();
  await worker;
  assert.equal((await f.api.getComparison(BARCODE, f.options)).results[0].price, 27);
});

 test('synthetic fixture: the advisory-lock contract prevents cross-instance background/worker overlap', async () => {
  let held = false;
  const lock = async (_namespace, _barcode, callback) => {
    if (held) return { acquired: false, result: null };
    held = true;
    try { return { acquired: true, result: await callback() }; }
    finally { held = false; }
  };
  const gate = deferred();
  const worker = fixture({ lock, prices: [positive('fixture_woolworths', BARCODE, 5 * HOUR)], adapters: [{ RETAILER: 'fixture_woolworths',
    scrapeByBarcode: async (barcode) => { await gate.promise; return positive('fixture_woolworths', barcode, 0, 28); } }] });
  const browser = fixture({ lock, prices: [positive('fixture_woolworths', BARCODE, 5 * HOUR)], adapters: [offerAdapter('fixture_woolworths')] });
  const operation = worker.api.forceRefreshComparison(BARCODE, worker.options);
  await until(() => worker.state.calls.length === 1);
  const stale = await browser.api.getComparison(BARCODE, browser.options);
  assert.equal(stale.results[0].stale, true);
  await tick();
  assert.equal(browser.state.calls.length, 0);
  assert.equal(browser.state.lockCalls.length, 1);
  assert.equal(browser.state.logs.length, 0, 'Expected lock contention is not an unhandled background failure');
  await assert.rejects(browser.api.forceRefreshComparison(BARCODE, browser.options), (error) => error.code === 'REFRESH_IN_PROGRESS');
  gate.resolve();
  await operation;
});

 test('synthetic fixture: carried cached negatives retain their original age and refresh when stale', async () => {
  const gate = deferred();
  const original = at(5 * HOUR);
  const f = fixture({ prices: [positive('fixture_woolworths', BARCODE, 6 * HOUR)],
    checks: new Map([[BARCODE, check([negative('fixture_woolworths', { from_cache: true, updated_at: original })])]]),
    adapters: [{ RETAILER: 'fixture_woolworths', scrapeByBarcode: async (barcode) => {
      await gate.promise; return positive('fixture_woolworths', barcode, 0, 29);
    } }] });
  const stale = await f.api.getComparison(BARCODE, f.options);
  assert.equal(stale.results[0].available, false);
  assert.equal(stale.results[0].price, null);
  assert.equal(stale.results[0].stale, true);
  assert.equal(stale.results[0].updated_at, original);
  await until(() => f.state.calls.length === 1);
  const refresh = f.api.forceRefreshComparison(BARCODE, f.options);
  gate.resolve();
  await refresh;
  assert.equal((await f.api.getComparison(BARCODE, f.options)).results[0].price, 29);
});

 test('synthetic fixture: stale-background hints belong only to the current barcode', async () => {
  const gate = deferred();
  const checks = new Map([BARCODE, OTHER].map((barcode) => [barcode, check([negative('fixture_woolworths')], { age: 5 * HOUR })]));
  const f = fixture({ checks, adapters: [{ RETAILER: 'fixture_woolworths', scrapeByBarcode: async (barcode, options) => {
    assert.equal(options.product.barcode, barcode);
    assert.equal(options.productName, barcode === BARCODE ? 'Synthetic first label' : 'Synthetic second label');
    assert.equal(options.product.last_check_results, undefined);
    await gate.promise;
    return { price: null, error: 'Synthetic absence' };
  } }] });
  await Promise.all([f.api.getComparison(BARCODE, { ...f.options, productHint: { barcode: OTHER, name: 'Synthetic first label' } }),
    f.api.getComparison(OTHER, { ...f.options, productHint: { barcode: BARCODE, name: 'Synthetic second label' } })]);
  await until(() => f.state.calls.length === 2);
  const pending = [f.api.forceRefreshComparison(BARCODE, f.options), f.api.forceRefreshComparison(OTHER, f.options)];
  assert.equal(f.state.lockCalls.length, 2);
  gate.resolve();
  await Promise.all(pending);
  assert.equal(f.state.logs.length, 0);
});

 test('synthetic fixture: four parallel retailers retain individual 15s bounds and failure isolation', async () => {
  const f = fixture({ adapters: [offerAdapter('fixture_woolworths'),
    { RETAILER: 'fixture_pnp', scrapeByBarcode: async () => { throw new Error('Synthetic provider failure'); } },
    { RETAILER: 'fixture_checkers', scrapeByBarcode: () => new Promise(() => {}) }, missingAdapter('spar')] });
  const pending = f.api.forceRefreshComparison(BARCODE, f.options);
  await until(() => f.state.calls.length === 4 && f.state.timers.size === 1);
  assert.ok(f.state.delays.every((delay) => delay === 15000));
  assert.ok(f.state.calls.every((call) => call.options.timeoutMs === 15000));
  f.expireTimers();
  const comparison = await pending;
  assert.equal(comparison.results.length, 4);
  assert.equal(resultFor(comparison, 'fixture_woolworths').available, true);
  assert.match(resultFor(comparison, 'fixture_pnp').error, /Synthetic provider failure/);
  assert.match(resultFor(comparison, 'fixture_checkers').error, /timed out/);
  assert.equal(resultFor(comparison, 'spar').price, null);
  assert.equal(f.state.timers.size, 0);
  assert.equal(f.state.checkWrites.length, 1);
  assert.match(source, /Promise\.allSettled/);
});

 test('synthetic fixture: a mixed cache miss returns the coordinated latest results, not an old available offer', async () => {
  const f = fixture({ prices: [positive('fixture_woolworths')],
    adapters: [missingAdapter('fixture_woolworths'), offerAdapter('fixture_pnp')] });
  const comparison = await f.api.getComparison(BARCODE, f.options);
  assert.equal(resultFor(comparison, 'fixture_woolworths').available, false);
  assert.equal(resultFor(comparison, 'fixture_woolworths').price, null);
  assert.equal(resultFor(comparison, 'fixture_pnp').available, true);
  assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.lockCalls.length, 1);
  assert.equal(f.state.checkWrites.length, 1);
});

 test('synthetic fixture: concurrent ordinary cache misses share a flight and record one observation/outcome', async () => {
  const gate = deferred();
  const f = fixture({ request: { product_hint: 'Synthetic requested label' }, adapters: [{ RETAILER: 'fixture_woolworths',
    scrapeByBarcode: async (_barcode, options) => {
      assert.equal(options.productName, 'Synthetic requested label');
      await gate.promise;
      return { price: null, error: 'Synthetic absence' };
    } }] });
  const pending = Array.from({ length: 3 }, () => f.api.getComparison(BARCODE, f.options));
  await until(() => f.state.calls.length === 1);
  assert.equal(f.state.lockCalls.length, 1);
  gate.resolve();
  const comparisons = await Promise.all(pending);
  assert.ok(comparisons.every((row) => row.results[0].available === false && row.results[0].price === null));
  assert.equal(f.state.checkWrites.length, 1);
  assert.equal(f.state.productRequestWrites.length, 1);
});

 test('synthetic fixture: no-DB mode and legacy/module API remain compatible without real dependencies', async () => {
  const f = fixture({ configured: false, metadata: product(BARCODE), adapters: [offerAdapter('fixture_woolworths', 33)] });
  const cachedKeys = Object.keys(f.api).sort();
  assert.deepEqual(cachedKeys, ['forceRefresh', 'forceRefreshComparison', 'getAllTrackedBarcodes', 'getComparison', 'getPrice', 'searchProducts']);
  const legacy = await f.api.getPrice(BARCODE);
  assert.equal(legacy.price, 33);
  assert.equal(legacy.retailer, 'fixture_woolworths');
  assert.equal(legacy.stale, false);
  const refreshed = await f.api.forceRefresh(BARCODE);
  assert.equal(refreshed.price, 33);
  assert.equal(f.state.lockCalls.length, 0);
  assert.equal(f.state.queries.length, 0);
  assert.equal(f.state.checkWrites.length, 0);
});
