'use strict';

const jwt = require('jsonwebtoken');

function userSecret() {
  return process.env.USER_SYNC_JWT_SECRET || process.env.NEXTAUTH_SECRET || null;
}

function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const secret = userSecret();
  if (!token || !secret) return res.status(401).json({ error: 'unauthorized', message: 'Sign in is required for this action.' });

  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload !== 'object' || !payload.google_id || !payload.email) {
      return res.status(401).json({ error: 'unauthorized', message: 'Your sign-in session is invalid.' });
    }
    req.user = {
      googleId: String(payload.google_id),
      email: String(payload.email),
      displayName: typeof payload.display_name === 'string' ? payload.display_name : null,
    };
    return next();
  } catch (_error) {
    return res.status(401).json({ error: 'unauthorized', message: 'Your sign-in session has expired. Please sign in again.' });
  }
}

module.exports = { requireUser };
