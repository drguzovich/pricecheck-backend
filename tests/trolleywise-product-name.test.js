'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/priceService'), 'utf8');
const upsert = source.slice(source.indexOf('async function upsertProduct('), source.indexOf('async function insertPrice('));
test('actual upsert preserves known metadata when a price response has only a barcode name and null metadata', async () => {
  let query; const context = { sql: async (parts) => { query = parts.join('?'); } };
  vm.createContext(context); vm.runInContext(`${upsert}\nthis.run = upsertProduct;`, context);
  await context.run({ barcode: '6001069206154', name: '6001069206154', brand: null, pack_size: null, image_url: null });
  assert.match(query, /EXCLUDED.name = EXCLUDED.barcode\s+THEN products.name/);
  for (const field of ['brand', 'pack_size', 'image_url']) assert(query.includes(`${field} = COALESCE(EXCLUDED.${field}, products.${field})`));
});
const prefixStart = source.indexOf('async function getComparison(');
const prefixEnd = source.indexOf('  const cachedObservations', prefixStart);
const selection = `${source.slice(prefixStart, prefixEnd)}\nreturn productHint;\n}`;
async function choose({ known, rows = [], hint = null, metadata = null }) {
  let calls = 0;
  const context = { RETAILERS: [], isDatabaseConfigured: () => true, getCachedComparisonRows: async () => rows, getKnownProduct: async () => known, getProductMetadata: async () => { calls++; return metadata; }, getProductRequest: async () => null };
  vm.createContext(context); vm.runInContext(`${selection}\nthis.run = getComparison;`, context);
  const result = await context.run('6001069206154', { productHint: hint });
  return { result, calls };
}
test('actual comparison prefix treats a persisted barcode as unknown so source metadata is queried', async () => {
  const { result, calls } = await choose({ known: { name: '6001069206154' }, metadata: { barcode: '6001069206154', name: 'Synthetic actual source metadata fixture' } });
  assert.equal(calls, 1); assert.equal(result.name, 'Synthetic actual source metadata fixture');
});
test('actual comparison prefix permits a sourced seed hint to replace a barcode placeholder', async () => {
  const { result, calls } = await choose({ known: { name: '6001069206154' }, hint: { name: 'Synthetic sourced catalogue fixture' } });
  assert.equal(calls, 0); assert.equal(result.name, 'Synthetic sourced catalogue fixture');
});
test('meaningful established name is retained and placeholder cached result cannot override metadata in final product', async () => {
  const { result, calls } = await choose({ known: { name: 'Synthetic established product fixture' } });
  assert.equal(calls, 0); assert.equal(result.name, 'Synthetic established product fixture');
  assert.match(source, /result\.available && result\.name && result\.name !== barcode/);
});
