'use strict';
const ts = require('typescript');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.TROLLEYWISE_FRONTEND_SOURCE || '/home/ubuntu/pricecheck';
function fixture(entries = []) {
  const store = new Map(entries), events = [], modules = {};
  const window = { localStorage: { getItem: (key) => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) }, dispatchEvent: (event) => events.push(event.type) };
  function load(relative) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: (name) => modules[name], window, Event: class { constructor(type) { this.type = type; } }, globalThis: { crypto: require('node:crypto').webcrypto }, Date, Math });
    return exports;
  }
  modules['@/lib/brand-storage'] = load('src/lib/brand-storage.ts');
  return { guest: load('src/lib/guest-data.ts'), store, events };
}
const legacy = fixture([
  ['pricecheck-guest-history', JSON.stringify([{ barcode: '6001069206154', productName: 'Synthetic old history fixture', lastPrice: null, scannedAt: '2026-01-01T00:00:00Z' }])],
  ['pricecheck-guest-favourites', JSON.stringify([{ barcode: '6001069206154', productName: 'Synthetic old favourite fixture', addedAt: '2026-01-01T00:00:00Z' }])],
  ['pricecheck-guest-scan-count', '4'], ['pricecheck-guest-client-id', 'isolated-client'],
]);
assert.equal(legacy.guest.readGuestHistory().length, 1);
assert.equal(legacy.guest.readGuestFavourites().length, 1);
assert.equal(legacy.guest.readGuestScanCount(), 4);
assert.equal(legacy.guest.guestDataPayload().clientId, 'isolated-client');
legacy.guest.clearGuestData();
assert.equal(legacy.guest.readGuestHistory().length, 0);
assert.equal(legacy.guest.readGuestFavourites().length, 0);
assert.equal(legacy.guest.readGuestScanCount(), 0);
assert(legacy.store.has('pricecheck-guest-history'), 'copy must not delete original data');
assert(legacy.events.includes('trolleywise-guest-data'));
const empty = fixture();
for (let count = 1; count <= 3; count += 1) {
  empty.guest.recordGuestScan({ barcode: String(6000000000000 + count), productName: 'Synthetic count fixture', lastPrice: null, scannedAt: new Date().toISOString() });
  assert.equal(empty.guest.readGuestScanCount(), count);
}
console.log('PASS actual guest helper source: idempotent brand migration, canonical empty tombstones, stable identity and first/second/third scan counts. Synthetic in-memory storage only.');
