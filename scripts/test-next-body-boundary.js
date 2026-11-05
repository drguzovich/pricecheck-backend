'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { NodeNextRequest } = require('next/dist/server/base-http/node');
const { NextRequestAdapter } = require('next/dist/server/web/spec-extension/adapters/next-request');
(async () => {
  const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  const match = source.match(/const parseJson = express\.json\([\s\S]*?\n\}\);/);
  assert(match, 'actual server parser middleware must exist');
  const app = express();
  vm.runInNewContext(match[0], { app, express });
  app.post(['/api/auth-config', '/api/backend/users/migrate'], async (req, res) => {
    try {
      assert.equal(req.body, undefined, 'Express must not consume a Next-owned body');
      const nextRequest = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(req), new AbortController().signal);
      res.json({ parsed: await nextRequest.json() });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.post(['/auth/register', '/api/catalogue/seed'], (req, res) => res.json({ parsed: req.body }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const path of ['/api/auth-config', '/api/backend/users/migrate', '/auth/register', '/api/catalogue/seed']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixture: 'Synthetic loopback body', action: 'requestPasswordReset' }) });
      assert.equal(response.status, 200, path);
      assert.equal((await response.json()).parsed.fixture, 'Synthetic loopback body');
    }
    console.log('PASS actual server parser: raw Next auth/proxy JSON and parsed bounded Express auth/seed JSON. Loopback only, no DB/email/network provider.');
  } finally { await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error.stack); process.exit(1); });
