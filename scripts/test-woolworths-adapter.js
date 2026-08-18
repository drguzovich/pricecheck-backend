'use strict';

const { scrapeByBarcode } = require('../src/scrapers/woolworths');

(async () => {
  const barcode = process.argv[2] || '6001069206154';
  const timeoutMs = Number(process.argv[3] || 12000);
  const result = await scrapeByBarcode(barcode, { timeoutMs });
  const required = ['barcode', 'retailer', 'price', 'price_str', 'scraped_at', 'error'];
  const missing = required.filter((key) => !(key in result));
  if (missing.length > 0) throw new Error(`Woolworths scraper omitted required keys: ${missing.join(', ')}`);
  if (result.retailer !== 'woolworths') throw new Error(`Unexpected retailer identifier: ${result.retailer}`);
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
