'use strict';

const baseUrl = (process.env.PRICECHECK_API_URL || 'https://pricecheck-backend-7tkh.onrender.com').replace(/\/$/, '');
const knownBarcode = process.env.KNOWN_BARCODE || '6001069206154';
const unknownBarcode = process.env.UNKNOWN_BARCODE || '0000000000000';
const maxFreshAgeMinutes = Number(process.env.MAX_FRESH_AGE_MINUTES || 360);
const requirePickNPay = process.env.REQUIRE_PNP_AVAILABLE === 'true';

async function request(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const health = await request('/health');
  assert(health.status === 200 && health.body?.status === 'ok', 'Health endpoint did not return status ok');

  const known = await request(`/price/${knownBarcode}`);
  const woolworths = known.body?.results?.find((result) => result.retailer === 'woolworths');
  assert(known.status === 200, `Known barcode returned HTTP ${known.status}`);
  assert(woolworths?.available && Number(woolworths.price) > 0, 'Known barcode did not return an available Woolworths price');
  assert(woolworths.currency === 'ZAR', 'Known barcode did not return ZAR currency');
  assert(woolworths.updated_at, 'Woolworths result did not include an updated_at timestamp');
  const ageMinutes = (Date.now() - new Date(woolworths.updated_at).getTime()) / 60000;
  assert(ageMinutes <= maxFreshAgeMinutes, `Woolworths price is ${ageMinutes.toFixed(1)} minutes old, above the ${maxFreshAgeMinutes}-minute threshold`);

  const pnp = known.body.results?.find((result) => result.retailer === 'pick_n_pay');
  if (requirePickNPay) assert(pnp?.available && Number(pnp.price) > 0, 'Pick n Pay is required but did not return an available price');

  const unknown = await request(`/price/${unknownBarcode}`);
  assert(unknown.status === 404, `Unknown barcode returned HTTP ${unknown.status}, expected 404`);

  const invalid = await request('/price/123');
  assert(invalid.status === 400, `Invalid barcode returned HTTP ${invalid.status}, expected 400`);

  console.log(JSON.stringify({
    ok: true,
    health: health.body,
    woolworths: { price: woolworths.price, updated_at: woolworths.updated_at, age_minutes: Number(ageMinutes.toFixed(2)) },
    pick_n_pay: { available: Boolean(pnp?.available), error: pnp?.error ?? null },
    unknown_status: unknown.status,
    invalid_status: invalid.status,
  }, null, 2));
})().catch((error) => {
  console.error(`Deployment verification failed: ${error.message}`);
  process.exit(1);
});
