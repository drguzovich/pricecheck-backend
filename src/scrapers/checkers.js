'use strict';

/**
 * Checkers adapter placeholder.
 *
 * Checkers does not currently have an approved product-data endpoint configured
 * for this project. The API exposes this explicit unavailable result rather than
 * attempting to bypass site protections or hide the retailer from comparisons.
 */

const RETAILER = 'checkers';

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
    error: 'Checkers data source is not configured',
  };
}

module.exports = { scrapeByBarcode, RETAILER };
