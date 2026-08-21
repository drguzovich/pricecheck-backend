'use strict';

const { initSchema } = require('../src/db');
const { processPriceAlerts } = require('../src/alerts');

(async () => {
  await initSchema();
  const result = await processPriceAlerts();
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exit(1); });
