'use strict';

const OPEN_FOOD_FACTS_BASE = 'https://world.openfoodfacts.org/api/v2/product';
const METADATA_TIMEOUT_MS = Number(process.env.METADATA_TIMEOUT_MS || 7000);

async function getProductMetadata(barcode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPEN_FOOD_FACTS_BASE}/${encodeURIComponent(barcode)}.json`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PriceCheck/1.0 (+https://github.com/drguzovich/pricecheck-backend)',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const product = payload?.status === 1 ? payload.product : null;
    if (!product?.product_name) return null;

    const brand = product.brands?.split(',')[0]?.trim() || null;
    const productName = product.product_name.trim();
    const name = brand && !productName.toLowerCase().includes(brand.toLowerCase())
      ? `${brand} ${productName}`
      : productName;
    return {
      barcode,
      name,
      brand,
      pack_size: product.quantity?.trim() || null,
      image_url: product.image_front_url || product.image_url || null,
    };
  } catch (error) {
    if (error.name !== 'AbortError') console.warn(`[metadata] Lookup failed for ${barcode}: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getProductMetadata };
