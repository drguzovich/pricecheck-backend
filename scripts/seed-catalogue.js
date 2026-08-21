'use strict';

const fs = require('fs');
const path = require('path');
const { initSchema, sql } = require('../src/db');
const { forceRefreshComparison } = require('../src/priceService');

const candidates = require('../data/seed-candidates.json');
const progressFile = path.join(__dirname, '..', 'data', 'seed-progress.json');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function parsePackSize(name) { return name.match(/(\d+(?:\.\d+)?\s*(?:g|kg|ml|l|L))\b/i)?.[1] || null; }

function readProgress() {
  try { return JSON.parse(fs.readFileSync(progressFile, 'utf8')); }
  catch { return { completed: [], results: [] }; }
}
function saveProgress(progress) { fs.writeFileSync(progressFile, `${JSON.stringify(progress, null, 2)}\n`); }

async function ensureProduct(candidate) {
  await sql`
    INSERT INTO products (barcode, name, brand, pack_size, image_url, updated_at)
    VALUES (${candidate.barcode}, ${candidate.name}, NULL, ${parsePackSize(candidate.name)}, NULL, NOW())
    ON CONFLICT (barcode) DO UPDATE SET
      name = EXCLUDED.name,
      pack_size = COALESCE(EXCLUDED.pack_size, products.pack_size),
      updated_at = NOW()
  `;
}

async function runSeed({ delayMs = Math.max(3000, Number(process.env.SEED_DELAY_MS || 3000)), onProgress = null } = {}) {
  if (candidates.length !== 100) throw new Error(`Seed catalogue must contain exactly 100 candidates, found ${candidates.length}.`);
  await initSchema();
  const progress = readProgress();
  const completed = new Set(progress.completed || []);
  console.log(`[seed] Starting verified catalogue seed. ${completed.size}/100 items already completed.`);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (completed.has(candidate.barcode)) continue;
    await ensureProduct(candidate);
    let availableRetailers = [];
    let error = null;
    try {
      const comparison = await forceRefreshComparison(candidate.barcode);
      availableRetailers = comparison.results.filter((result) => result.available).map((result) => result.retailer);
    } catch (seedError) {
      error = seedError.message;
    }
    progress.completed.push(candidate.barcode);
    progress.results.push({
      barcode: candidate.barcode,
      name: candidate.name,
      sourceUrl: candidate.sourceUrl,
      availableRetailers,
      error,
      processedAt: new Date().toISOString(),
    });
    saveProgress(progress);
    console.log(`[seed] ${index + 1}/100 ${candidate.barcode}: ${availableRetailers.join(', ') || 'metadata only'}`);
    onProgress?.({ index: index + 1, candidate, availableRetailers, error });
    if (index < candidates.length - 1) await sleep(delayMs);
  }
  const withPrices = progress.results.filter((item) => item.availableRetailers.length > 0).length;
  return { status: 'complete', products: 100, productsWithRetailerPrices: withPrices, progressFile };
}

if (require.main === module) {
  runSeed().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error('[seed] Failed:', error); process.exit(1); });
}

module.exports = { runSeed };
