'use strict';

const RETAILER = 'checkers';
const PROVIDER_URL = 'https://api.parse.bot/scraper/39122869-152e-40fc-908a-8756aa0ff69b/search_products';

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

function exactBarcodeMatch(candidate, barcode) {
  const barcodes = [candidate?.barcode, ...(candidate?.barcodes || [])].filter(Boolean).map(String);
  return barcodes.includes(barcode);
}

function extractPrice(candidate) {
  const raw = candidate?.price ?? (Number.isFinite(candidate?.priceWithoutDecimal) ? candidate.priceWithoutDecimal / 100 : null);
  const price = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function scrapeByBarcode(barcode, { timeoutMs = 20000, product = null } = {}) {
  const apiKey = process.env.PARSE_API_KEY;
  if (!apiKey) return unavailable(barcode, 'Checkers provider is not configured');

  const query = product?.name || barcode;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(PROVIDER_URL);
    url.search = new URLSearchParams({ page: '0', query, page_size: '20' });
    const response = await fetch(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return unavailable(barcode, `Checkers provider returned HTTP ${response.status}`);

    const payload = await response.json();
    const products = payload?.data?.products ?? payload?.products ?? [];
    const candidate = products.find((item) => exactBarcodeMatch(item, barcode));
    const price = extractPrice(candidate);
    if (!candidate || !price) return unavailable(barcode, 'Checkers provider did not return an exact barcode match with a usable price');

    return {
      barcode,
      name: candidate.name ?? candidate.displayName ?? null,
      brand: null,
      pack_size: candidate.pack_size ?? candidate.size ?? null,
      image_url: candidate.imageURL ?? candidate.image_url ?? candidate.images?.[0] ?? null,
      price,
      price_str: `R${price.toFixed(2)}`,
      url: candidate.slug ? `https://products.checkers.co.za/product/${candidate.slug}` : null,
      promo_flag: Boolean(candidate.isOnPromotion),
      scraped_at: new Date().toISOString(),
      retailer: RETAILER,
      error: null,
    };
  } catch (error) {
    return unavailable(barcode, error.name === 'AbortError' ? 'Checkers provider request timed out' : `Checkers provider request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scrapeByBarcode, RETAILER };
