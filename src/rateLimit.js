'use strict';

function clientKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
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

module.exports = { createRateLimiter, clientKey };
