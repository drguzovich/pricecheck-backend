'use strict';

const { getProductMetadata } = require('../src/productMetadata');

(async () => {
  const barcode = process.argv[2] || '6001069600754';
  const product = await getProductMetadata(barcode);
  if (!product?.name) throw new Error(`No usable public product metadata returned for ${barcode}`);
  if (product.barcode !== barcode) throw new Error(`Metadata barcode mismatch: expected ${barcode}`);
  console.log(JSON.stringify(product, null, 2));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
