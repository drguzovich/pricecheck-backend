'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const { ipKeyGenerator } = require('express-rate-limit');

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

const PROXY_IDENTITY_MAX_AGE_MS = 120 * 1000;

function singleHeader(req, name) {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value : null;
}

function signedProxyClient(req, now = Date.now()) {
  // The trusted frontend proxy and backend must share USER_SYNC_JWT_SECRET (or
  // NEXTAUTH_SECRET). Without a matching secret, direct-IP bucketing remains.
  const secret = process.env.USER_SYNC_JWT_SECRET;
  const client = singleHeader(req, 'x-pricecheck-client');
  const timestamp = singleHeader(req, 'x-pricecheck-timestamp');
  const signature = singleHeader(req, 'x-pricecheck-signature');
  if (typeof secret !== 'string' || !secret || !/^[a-f0-9]{64}$/i.test(client || '') ||
    !/^\d{13}$/.test(timestamp || '') || !/^[a-f0-9]{64}$/i.test(signature || '')) return null;

  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || Math.abs(now - issuedAt) > PROXY_IDENTITY_MAX_AGE_MS) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}:${client}`).digest('hex'), 'hex');
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected) ? client.toLowerCase() : null;
}

function priceRequestKeyGenerator(req) {
  const client = signedProxyClient(req);
  return client ? `proxy:${client}` : ipKeyGenerator(req.ip);
}

function createRateLimiter({ windowMs, maxRequests, now = () => Date.now() }) {
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    const currentTime = now();
    const key = clientKey(req);
    const earliest = currentTime - windowMs;
    const previous = buckets.get(key) || [];
    const active = previous.filter((timestamp) => timestamp > earliest);

    if (active.length >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((active[0] + windowMs - currentTime) / 1000));
      res.set?.('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many price requests. Please wait before trying again.',
        retry_after_seconds: retryAfterSeconds,
      });
    }

    active.push(currentTime);
    buckets.set(key, active);
    return next();
  };
}

module.exports = { createRateLimiter, clientKey, priceRequestKeyGenerator, signedProxyClient };
