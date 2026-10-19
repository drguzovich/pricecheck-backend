'use strict';
const fs = require('node:fs/promises');
const base = process.env.PRICECHECK_VERIFY_URL || 'https://pricecheck-backend-7tkh.onrender.com';
const expected = process.env.RENDER_EXPECTED_REVISION;
const output = process.env.RELEASE_VERIFY_OUTPUT || '/tmp/pricecheck-live-release.json';
const deadline = Date.now() + Number(process.env.RELEASE_VERIFY_TIMEOUT_MS || 600000);

async function read(path, timeout = 30000) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { nonJsonResponse: true }; }
  return { status: response.status, body };
}
async function main() {
  if (!expected) throw new Error('RENDER_EXPECTED_REVISION must identify the pushed release');
  let health = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      health = await read('/health');
      if (health.status === 200 && health.body.status === 'ok' && health.body.revision === expected) break;
      console.log(`[release] check ${attempt}: HTTP ${health.status}, status=${health.body.status || 'not JSON'}, revision=${health.body.revision || 'old release'}`);
    } catch (error) { console.log(`[release] check ${attempt}: ${error.name}`); }
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
  const verified = health?.status === 200 && health.body.status === 'ok' && health.body.revision === expected;
  const record = { observedAt: new Date().toISOString(), base, expectedRevision: expected, releaseVerified: verified, health };
  if (verified) {
    record.comparison = await read('/price/6001069206154', 45000);
    record.benchmarkHealth = await read('/product/6001069206154/health');
    record.scoredProductHealth = await read('/product/5449000009067/health');
    record.coverage = await read('/coverage');
  }
  await fs.writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
  if (!verified) process.exitCode = 2;
}
main().catch((error) => { console.error(error.name, error.message); process.exitCode = 1; });
