'use strict';

const { scrapeByBarcode } = require('../src/scrapers/checkers');

(async () => {
  const barcode = process.argv[2] || '6001069206154';
  const productName = process.argv[3] || 'Ouma Buttermilk Rusks';
  const result = await scrapeByBarcode(barcode, { timeoutMs: 20000, product: { name: productName } });
  const required = ['barcode', 'retailer', 'price', 'price_str', 'scraped_at', 'error'];
  const missing = required.filter((key) => !(key in result));
  if (missing.length) throw new Error(`Checkers adapter omitted keys: ${missing.join(', ')}`);
  if (result.retailer !== 'checkers') throw new Error(`Unexpected retailer identifier: ${result.retailer}`);
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
