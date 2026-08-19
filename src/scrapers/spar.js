'use strict';

const RETAILER = 'spar';

/**
 * SPAR South Africa does not publish national prices because individual stores
 * set their own pricing. Keep SPAR visible in every comparison rather than
 * presenting catalogue metadata as a price or silently omitting the retailer.
 */
async function scrapeByBarcode(barcode) {
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
    error: 'SPAR prices vary by store; no location-specific price source is configured',
  };
}

module.exports = { scrapeByBarcode, RETAILER };
