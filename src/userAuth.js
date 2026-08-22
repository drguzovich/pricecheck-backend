'use strict';

const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

const scrypt = promisify(scryptCallback);
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateRegistration({ email, password, displayName }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedName = String(displayName || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 320) return { error: 'Enter a valid email address.' };
  if (normalizedName.length < 2 || normalizedName.length > 80) return { error: 'Enter a name between 2 and 80 characters.' };
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return { error: `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.` };
  return { email: normalizedEmail, displayName: normalizedName };
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
  const [algorithm, encodedSalt, encodedHash] = storedHash.split('$');
  if (algorithm !== 'scrypt' || !encodedSalt || !encodedHash) return false;
  try {
    const expected = Buffer.from(encodedHash, 'base64url');
    const derived = Buffer.from(await scrypt(password, Buffer.from(encodedSalt, 'base64url'), expected.length));
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch (_error) {
    return false;
  }
}

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

module.exports = { hashPassword, normalizeEmail, requireUser, validateRegistration, verifyPassword };
