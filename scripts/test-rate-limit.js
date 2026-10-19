'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('crypto');
const { createRateLimiter, priceRequestKeyGenerator } = require('../src/rateLimit');

let clock = 0;
const middleware = createRateLimiter({ windowMs: 60_000, maxRequests: 2, now: () => clock });
const request = { headers: { 'x-forwarded-for': '203.0.113.8' }, ip: '127.0.0.1' };
const state = { nextCalls: 0, status: null, body: null, headers: {} };
const response = {
  set(key, value) { state.headers[key] = value; return this; },
  status(code) { state.status = code; return this; },
  json(body) { state.body = body; return this; },
};
const next = () => { state.nextCalls += 1; };

middleware(request, response, next);
middleware(request, response, next);
middleware(request, response, next);
if (state.nextCalls !== 2 || state.status !== 429 || state.body?.error !== 'rate_limited') {
  throw new Error('Rate limiter did not allow two requests then reject the third');
}

clock = 60_001;
state.status = null;
state.body = null;
middleware(request, response, next);
if (state.nextCalls !== 3 || state.status !== null) {
  throw new Error('Rate limiter did not permit a request after the window elapsed');
}

const proxySecret = 'unit-test-shared-proxy-secret';
const client = 'a'.repeat(64);
const timestamp = String(Date.now());
const signature = createHmac('sha256', proxySecret).update(`${timestamp}:${client}`).digest('hex');
const proxyRequest = (overrides = {}) => ({
  ip: '203.0.113.8',
  headers: {
    'x-pricecheck-client': client,
    'x-pricecheck-timestamp': timestamp,
    'x-pricecheck-signature': signature,
    ...overrides,
  },
});
const beforeProxySecrets = { USER_SYNC_JWT_SECRET: process.env.USER_SYNC_JWT_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
try {
  process.env.USER_SYNC_JWT_SECRET = proxySecret;
  delete process.env.NEXTAUTH_SECRET;
  assert.equal(priceRequestKeyGenerator(proxyRequest()), `proxy:${client}`);
  assert.equal(priceRequestKeyGenerator(proxyRequest({ 'x-pricecheck-signature': '0'.repeat(64) })), '203.0.113.8');
  const expiredTimestamp = String(Date.now() - 120_001);
  const expiredSignature = createHmac('sha256', proxySecret).update(`${expiredTimestamp}:${client}`).digest('hex');
  assert.equal(priceRequestKeyGenerator(proxyRequest({
    'x-pricecheck-timestamp': expiredTimestamp,
    'x-pricecheck-signature': expiredSignature,
  })), '203.0.113.8');
  delete process.env.USER_SYNC_JWT_SECRET;
  assert.equal(priceRequestKeyGenerator(proxyRequest()), '203.0.113.8');
} finally {
  for (const [name, value] of Object.entries(beforeProxySecrets)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log('Rate limiter and signed proxy identity tests passed');
