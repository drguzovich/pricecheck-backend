'use strict';

const { initSchema, isDatabaseConfigured } = require('../src/db');
const { mailEnabled, processPriceAlerts } = require('../src/alerts');

(async () => {
  if (!isDatabaseConfigured()) {
    console.log(JSON.stringify({ sent: 0, skipped: 'database_not_configured' }));
    return;
  }
  if (!mailEnabled()) {
    console.log(JSON.stringify({ sent: 0, skipped: 'mail_not_configured' }));
    return;
  }
  await initSchema();
  const result = await processPriceAlerts();
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exit(1); });
