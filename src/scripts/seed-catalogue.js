'use strict';

// Stable source-level entry point requested by the deployment checklist. The
// implementation remains in scripts/ so existing admin callers keep working.
const { runSeed } = require('../../scripts/seed-catalogue');

if (require.main === module) {
  runSeed()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error('[seed] Failed:', error); process.exitCode = 1; });
}

module.exports = { runSeed };
