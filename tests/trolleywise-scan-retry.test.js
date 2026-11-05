'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/db'), 'utf8');
const functionSource = source.slice(source.indexOf('async function recordScan('), source.indexOf('async function listFavourites('));
function fixture() {
  const rows = new Map(); const queries = [];
  const sql = async (parts, ...params) => {
    const query = parts.join('?'); queries.push(query);
    const [userId, barcode, productName, lastPrice, scannedAt, eventKey] = params;
    assert.match(query, /ON CONFLICT \(user_id, migration_key\) WHERE migration_key IS NOT NULL/);
    assert.match(query, /DO UPDATE SET migration_key = EXCLUDED\.migration_key/);
    const key = `${userId}:${eventKey}`;
    if (!rows.has(key)) rows.set(key, { id: rows.size + 1, barcode, product_name: productName, last_price: lastPrice, scanned_at: scannedAt });
    return [rows.get(key)];
  };
  const context = { sql, Date }; vm.createContext(context); vm.runInContext(`${functionSource}\nthis.record = recordScan;`, context);
  return { record: context.record, rows, queries };
}
test('same owner/barcode/timestamp retry returns the same event without relabelling its price', async () => {
  const f = fixture(); const scan = { barcode: '6001069206154', productName: 'Synthetic retry fixture', lastPrice: null, scannedAt: '2026-11-05T01:00:00.000Z' };
  const first = await f.record(123, scan); const retry = await f.record(123, { ...scan, lastPrice: 99 });
  assert.equal(first.id, retry.id); assert.equal(retry.last_price, null); assert.equal(f.rows.size, 1);
});
test('different owner or genuinely different scan timestamp remains a separate event', async () => {
  const f = fixture(); const scan = { barcode: '6001069206154', productName: 'Synthetic retry fixture', scannedAt: '2026-11-05T01:00:00.000Z' };
  await f.record(123, scan); await f.record(456, scan); await f.record(123, { ...scan, scannedAt: '2026-11-05T01:01:00.000Z' });
  assert.equal(f.rows.size, 3);
});
test('canonical equivalent timezone timestamps deduplicate; invalid timestamp never reaches SQL', async () => {
  const f = fixture(); const scan = { barcode: '6001069206154', productName: 'Synthetic retry fixture', scannedAt: '2026-11-05T03:00:00+02:00' };
  const first = await f.record(123, scan); const same = await f.record(123, { ...scan, scannedAt: '2026-11-05T01:00:00Z' });
  assert.equal(first.id, same.id); await assert.rejects(f.record(123, { ...scan, scannedAt: 'not a date' })); assert.equal(f.queries.length, 2);
});
