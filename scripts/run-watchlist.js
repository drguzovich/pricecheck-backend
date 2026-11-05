'use strict';

const { initSchema, isDatabaseConfigured, closeDatabase } = require('../src/db');
const { runWatchlistWorker, workerConfiguration } = require('../src/watchlist');

async function main() {
  if (!isDatabaseConfigured()) {
    console.log(JSON.stringify({ skipped: 'database_not_configured', checked: 0, sent: 0 }));
    return 0;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // An interrupted run remains visible as running until the next worker marks
  // it interrupted. The safety stop also terminates lingering browser children.
  const safetyStop = setTimeout(() => {
    console.error('[watchlist] Runtime safety limit reached. Run did not complete.');
    process.exit(1);
  }, workerConfiguration().maxRuntimeMs + 60000);
  try {
    await initSchema();
    const result = await runWatchlistWorker({ shouldStop: () => stopping });
    console.log(JSON.stringify(result));
    return result.state === 'failed' || stopping ? 1 : 0;
  } finally {
    clearTimeout(safetyStop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await closeDatabase();
  }
}
if (require.main === module) {
  main().then((code) => process.exit(code)).catch(() => {
    console.error('[watchlist] Worker failed. Check private service logs and previous-run metrics.');
    process.exit(1);
  });
}
module.exports = { main };
