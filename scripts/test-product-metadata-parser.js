'use strict';

const assert = require('node:assert/strict');
const { normaliseOpenFoodFactsProduct } = require('../src/productMetadata');

const product = normaliseOpenFoodFactsProduct('6000000000001', {
  status: 1,
  product: { product_name: 'Full Cream Milk', brands: 'Example Foods, Other', quantity: '1 L', image_front_url: 'https://example.test/milk.png' },
});

assert.deepEqual(product, {
  barcode: '6000000000001',
  name: 'Example Foods Full Cream Milk',
  brand: 'Example Foods',
  pack_size: '1 L',
  image_url: 'https://example.test/milk.png',
});
assert.equal(normaliseOpenFoodFactsProduct('6000000000001', { status: 0 }), null);
console.log('Product metadata parser test passed');
