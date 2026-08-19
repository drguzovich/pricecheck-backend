'use strict';

const { createRateLimiter } = require('../src/rateLimit');

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
console.log('Rate limiter test passed');
