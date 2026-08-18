'use strict';

/**
 * Pick n Pay adapter.
 *
 * PriceCheck only calls a product endpoint that the operator has approved and
 * supplied through PNP_PRODUCT_LOOKUP_URL. The value must include `{barcode}`
 * where the EAN should be substituted, for example:
 * https://approved-provider.example/products?barcode={barcode}
 *
 * This avoids guessing or bypassing private website endpoints. Until an
 * approved provider URL is configured, the retailer is reported as unavailable
 * and does not block the other retailer lookups.
 */

const RETAILER = 'pick_n_pay';

function unavailable(barcode, error) {
  return {
    barcode,
    name: null,
    brand: null,
    pack_size: null,
    image_url: null,
    price: null,
    price_str: null,
    url: null,
    promo_flag: false,
    scraped_at: new Date().toISOString(),
    retailer: RETAILER,
    error,
  };
}

function findCandidate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const collections = [
    payload.results,
    payload.products,
    payload.items,
    payload.data?.results,
    payload.data?.products,
    payload.data?.items,
  ];
  for (const collection of collections) {
    if (Array.isArray(collection) && collection.length > 0) return collection[0];
  }
  return payload.product || payload.data?.product || null;
}

function extractPrice(candidate) {
  const raw = candidate?.price ?? candidate?.sellingPrice ?? candidate?.price?.value;
  const numeric = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

async function scrapeByBarcode(barcode, { timeoutMs = 12000 } = {}) {
  const template = process.env.PNP_PRODUCT_LOOKUP_URL;
  if (!template) {
    return unavailable(barcode, 'Pick n Pay data source is not configured');
  }

  const url = template.replace('{barcode}', encodeURIComponent(barcode));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) return unavailable(barcode, 'Product not found at Pick n Pay');
    if (!response.ok) return unavailable(barcode, `Pick n Pay source returned HTTP ${response.status}`);

    const candidate = findCandidate(await response.json());
    const price = extractPrice(candidate);
    if (!candidate || !price) return unavailable(barcode, 'Pick n Pay product did not contain a usable price');

    const name = candidate.name ?? candidate.displayName ?? candidate.productName ?? null;
    return {
      barcode,
      name,
      brand: candidate.brand?.name ?? candidate.brand ?? null,
      pack_size: candidate.packSize ?? candidate.size ?? null,
      image_url: candidate.image ?? candidate.imageUrl ?? candidate.images?.[0]?.url ?? null,
      price,
      price_str: `R ${price.toFixed(2)}`,
      url: candidate.url ?? candidate.productUrl ?? null,
      promo_flag: Boolean(candidate.promo ?? candidate.onPromotion ?? candidate.special),
      scraped_at: new Date().toISOString(),
      retailer: RETAILER,
      error: null,
    };
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Pick n Pay request timed out' : `Pick n Pay request failed: ${error.message}`;
    return unavailable(barcode, message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scrapeByBarcode, RETAILER };
