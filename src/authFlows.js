'use strict';

const { createHash, randomBytes } = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { sql, isDatabaseConfigured } = require('./db');
const { hashPassword, normalizeEmail, requireUser } = require('./userAuth');
const { priceRequestKeyGenerator } = require('./rateLimit');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const PURPOSES = Object.freeze({ verification: 24 * 60 * 60, password_reset: 30 * 60 });
const GENERIC_REQUEST_MESSAGE = 'If an eligible account exists and email delivery succeeds, a link will arrive shortly. Check your spam folder too.';
const INVALID_LINK_MESSAGE = 'This link is invalid, expired or already used. Request a new link.';
let schemaReady = false;

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}
function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
function validEmail(email) {
  return typeof email === 'string' && email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function fixedPublicOrigin(env = process.env) {
  const configured = env.AUTH_PUBLIC_ORIGIN || env.TROLLEYWISE_WEB_URL || env.PRICECHECK_WEB_URL || env.NEXTAUTH_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    const local = env.AUTH_TRUST_LOCAL_HTTP === 'true' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) return null;
    return url.origin;
  } catch (_error) {
    return null;
  }
}
function mailConfiguration(env = process.env) {
  const from = env.AUTH_FROM_EMAIL || env.ALERT_FROM_EMAIL || env.EMAIL_FROM;
  const port = Number(env.SMTP_PORT || 587);
  const resend = Boolean(env.RESEND_API_KEY && from);
  const smtp = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && from && Number.isInteger(port) && port > 0 && port <= 65535);
  return { from, resend, smtp, configured: resend || smtp };
}
function authEmailReadiness(env = process.env, databaseReady = schemaReady && isDatabaseConfigured()) {
  const mail = mailConfiguration(env);
  const origin = fixedPublicOrigin(env);
  const enabled = Boolean(databaseReady && mail.configured && origin);
  return {
    emailFlowsEnabled: enabled,
    emailProviderConfigured: mail.configured,
    emailDeliveryVerified: false,
    emailMessage: enabled
      ? 'Email recovery is configured. Delivery still depends on the email provider and has not been verified by this status check.'
      : !databaseReady ? 'Email verification and password reset are unavailable while the account database is not ready.'
        : !origin ? 'Email verification and password reset need a configured HTTPS account-link origin.'
          : 'Email verification and password reset are unavailable until an email provider and sender are configured.',
  };
}
async function sendAuthEmail(message, env = process.env) {
  const config = mailConfiguration(env);
  if (!config.configured) throw new Error('auth_mail_unconfigured');
  if (config.resend) {
    const result = await new Resend(env.RESEND_API_KEY).emails.send({ from: config.from, ...message });
    if (result?.error) throw new Error('auth_mail_rejected');
    return result;
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    requireTLS: env.SMTP_SECURE !== 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const result = await transport.sendMail({ from: config.from, ...message });
  if (!result.accepted?.length) throw new Error('auth_mail_rejected');
  return result;
}

function createSqlAuthFlowStore(client = sql) {
  return {
    async initialize() {
      await client`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`;
      // Main can use this version to revoke existing sessions after a reset.
      await client`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0`;
      await client`
        CREATE TABLE IF NOT EXISTS account_action_tokens (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
          purpose TEXT NOT NULL CHECK (purpose IN ('verification', 'password_reset')),
          email TEXT NOT NULL,
          credential_version INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ
        )
      `;
      await client`CREATE INDEX IF NOT EXISTS idx_account_action_tokens_user ON account_action_tokens (user_id, purpose)`;
      await client`CREATE INDEX IF NOT EXISTS idx_account_action_tokens_expiry ON account_action_tokens (expires_at)`;
    },
    async findPasswordUser(email) {
      const [user] = await client`
        SELECT id, email, email_verified_at FROM users
        WHERE google_id = ${`password:${email}`} AND auth_provider = 'password' AND password_hash IS NOT NULL LIMIT 1
      `;
      return user || null;
    },
    async issue(user, purpose, digest, ttlSeconds) {
      return client.begin(async (tx) => {
        // A consistent user-first lock order serializes requests and consumption.
        const [current] = await tx`SELECT id, email, email_verified_at, auth_version FROM users WHERE id = ${user.id} AND auth_provider = 'password' FOR UPDATE`;
        if (!current || current.email !== user.email || (purpose === 'verification' && current.email_verified_at)) return false;
        await tx`UPDATE account_action_tokens SET used_at = NOW() WHERE user_id = ${user.id} AND purpose = ${purpose} AND used_at IS NULL`;
        await tx`
          INSERT INTO account_action_tokens (user_id, token_hash, purpose, email, credential_version, expires_at)
          VALUES (${user.id}, ${digest}, ${purpose}, ${current.email}, ${current.auth_version}, NOW() + (${ttlSeconds} * INTERVAL '1 second'))
        `;
        return true;
      });
    },
    async revoke(digest) {
      await client`UPDATE account_action_tokens SET used_at = NOW() WHERE token_hash = ${digest} AND used_at IS NULL`;
    },
    async consume(digest, purpose, newPasswordHash = null) {
      return client.begin(async (tx) => {
        const [candidate] = await tx`SELECT user_id FROM account_action_tokens WHERE token_hash = ${digest} AND purpose = ${purpose} LIMIT 1`;
        if (!candidate) return false;
        const [user] = await tx`SELECT id, email, auth_version FROM users WHERE id = ${candidate.user_id} AND auth_provider = 'password' FOR UPDATE`;
        if (!user) return false;
        const [token] = await tx`
          UPDATE account_action_tokens SET used_at = NOW()
          WHERE token_hash = ${digest} AND purpose = ${purpose} AND user_id = ${user.id}
            AND email = ${user.email} AND credential_version = ${user.auth_version}
            AND used_at IS NULL AND expires_at > NOW()
          RETURNING id
        `;
        if (!token) return false;
        if (purpose === 'verification') {
          await tx`UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = ${user.id}`;
        } else {
          await tx`UPDATE users SET password_hash = ${newPasswordHash}, auth_version = auth_version + 1, updated_at = NOW() WHERE id = ${user.id}`;
          // A reset invalidates all outstanding account action links.
          await tx`UPDATE account_action_tokens SET used_at = NOW() WHERE user_id = ${user.id} AND used_at IS NULL`;
        }
        return true;
      });
    },
    async verificationStatus(principal) {
      const [user] = await client`
        SELECT auth_provider, email_verified_at, auth_version FROM users
        WHERE google_id = ${principal.accountId} AND email = ${principal.email} LIMIT 1
      `;
      return user ? { provider: user.auth_provider, emailVerified: Boolean(user.email_verified_at), authVersion: user.auth_version } : null;
    },
    async cleanup() {
      // Optional maintenance hook. Retain expired/used rows for seven days.
      await client`DELETE FROM account_action_tokens WHERE expires_at < NOW() - INTERVAL '7 days'`;
    },
  };
}
const defaultStore = createSqlAuthFlowStore();
async function initAuthFlowsSchema() {
  schemaReady = false;
  await defaultStore.initialize();
  schemaReady = true;
}

function createAuthFlowService({ store = defaultStore, env = process.env, databaseReady = () => schemaReady && isDatabaseConfigured(), mailer = (message) => sendAuthEmail(message, env), onEvent = () => {} } = {}) {
  function report(code) {
    // Never provide tokens, email addresses, passwords or provider errors to logs.
    try { onEvent(code); } catch (_error) { /* Diagnostics must not break auth. */ }
  }
  return {
    readiness: () => authEmailReadiness(env, databaseReady()),
    async requestLink(purpose, suppliedEmail) {
      const email = normalizeEmail(typeof suppliedEmail === 'string' ? suppliedEmail : '');
      if (!Object.hasOwn(PURPOSES, purpose) || !validEmail(email) || !authEmailReadiness(env, databaseReady()).emailFlowsEnabled) return;
      let digest;
      try {
        const user = await store.findPasswordUser(email);
        if (!user || (purpose === 'verification' && user.email_verified_at)) return;
        const token = randomBytes(32).toString('base64url');
        digest = tokenDigest(token);
        if (!await store.issue(user, purpose, digest, PURPOSES[purpose])) return;
        const page = purpose === 'verification' ? '/account/verify-email' : '/account/reset-password';
        // The token stays in the fragment, not request URLs, referrers or logs.
        const link = `${fixedPublicOrigin(env)}${page}#token=${encodeURIComponent(token)}`;
        const verification = purpose === 'verification';
        await mailer({
          to: user.email,
          subject: verification ? 'Verify your TrolleyWise email' : 'Reset your TrolleyWise password',
          text: `${verification ? 'Confirm your email address' : 'Choose a new password'} using this single-use link: ${link}\n\nThis link expires in ${verification ? '24 hours' : '30 minutes'}. If you did not request this, ignore this email. No password changes happen until you confirm them.`,
        });
        report('auth_mail_provider_accepted');
      } catch (_error) {
        if (digest) await store.revoke(digest).catch(() => {});
        report('auth_link_delivery_failed');
      }
    },
    async confirm(purpose, token, password) {
      if (!Object.hasOwn(PURPOSES, purpose) || !validToken(token)) return { status: 400, body: { error: 'invalid_link', message: INVALID_LINK_MESSAGE } };
      if (purpose === 'password_reset' && (typeof password !== 'string' || password.length < 10 || password.length > 128)) {
        return { status: 400, body: { error: 'invalid_password', message: 'Use a password between 10 and 128 characters.' } };
      }
      if (!databaseReady()) return { status: 503, body: { error: 'auth_flows_unavailable', message: 'Account recovery is temporarily unavailable. Please try again later.' } };
      try {
        const passwordHash = purpose === 'password_reset' ? await hashPassword(password) : null;
        if (!await store.consume(tokenDigest(token), purpose, passwordHash)) return { status: 400, body: { error: 'invalid_link', message: INVALID_LINK_MESSAGE } };
        return { status: 200, body: { ok: true, message: purpose === 'verification' ? 'Your email address is verified.' : 'Your password has been changed. Sign in with your new password.' } };
      } catch (_error) {
        report('auth_link_confirmation_failed');
        return { status: 503, body: { error: 'auth_flows_unavailable', message: 'Account recovery is temporarily unavailable. Please try again later.' } };
      }
    },
    async verificationStatus(principal) {
      if (!databaseReady()) throw new Error('auth_flows_unavailable');
      return store.verificationStatus(principal);
    },
  };
}

function createAuthRateLimiters({ ipStore, emailStore, requestStore } = {}) {
  const shared = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many account requests. Please wait before trying again.' } };
  const emailKey = (req) => tokenDigest(normalizeEmail(typeof req.body?.email === 'string' ? req.body.email.slice(0, 320) : ''));
  return {
    ip: rateLimit({ ...shared, limit: 40, keyGenerator: priceRequestKeyGenerator, ...(ipStore ? { store: ipStore } : {}) }),
    email: rateLimit({ ...shared, limit: 10, keyGenerator: emailKey, ...(emailStore ? { store: emailStore } : {}) }),
    request: rateLimit({ ...shared, limit: 5, keyGenerator: emailKey, ...(requestStore ? { store: requestStore } : {}) }),
  };
}
function enforceCredentialVersion(service) {
  return async (req, res, next) => {
    if (!req.user.accountId.startsWith('password:')) return next();
    try {
      const secret = process.env.USER_SYNC_JWT_SECRET;
      if (!secret) return res.status(503).json({ error: 'account_sync_unconfigured', message: 'Account sync is temporarily unavailable.' });
      const header = req.get('authorization') || '';
      const payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] });
      const current = await service.verificationStatus(req.user);
      const version = payload.auth_version ?? 0;
      if (!current || !Number.isInteger(version) || version !== current.authVersion) {
        return res.status(401).json({ error: 'session_revoked', message: 'Your password has changed. Sign in again to use your account.' });
      }
      return next();
    } catch (_error) {
      return res.status(503).json({ error: 'account_sync_unavailable', message: 'Account sync is temporarily unavailable.' });
    }
  };
}
function integrateAuthFlows(app, { service = createAuthFlowService(), limiters = createAuthRateLimiters(), enqueue = (task) => setImmediate(task) } = {}) {
  // Mount before existing register/login routes so they receive these hooks too.
  app.use('/users', requireUser, enforceCredentialVersion(service));
  app.use('/auth', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return next();
    return limiters.ip(req, res, next);
  });
  app.use(['/auth/login', '/auth/register'], limiters.email);
  app.get('/auth/readiness', (_req, res) => res.json(service.readiness()));
  const requestRoute = (purpose) => (req, res) => {
    const readiness = service.readiness();
    if (!readiness.emailFlowsEnabled) return res.status(503).json({ error: 'auth_email_unavailable', message: readiness.emailMessage });
    const email = typeof req.body?.email === 'string' && req.body.email.length <= 320 ? req.body.email : '';
    // Always respond before database lookup or provider work, including misses.
    enqueue(() => { void service.requestLink(purpose, email).catch(() => {}); });
    return res.status(202).json({ message: GENERIC_REQUEST_MESSAGE });
  };
  const confirmRoute = (purpose) => async (req, res) => {
    const result = await service.confirm(purpose, req.body?.token, req.body?.password);
    return res.status(result.status).json(result.body);
  };
  app.post('/auth/verification/request', limiters.request, requestRoute('verification'));
  app.post('/auth/password-reset/request', limiters.request, requestRoute('password_reset'));
  app.post('/auth/verification/confirm', confirmRoute('verification'));
  app.post('/auth/password-reset/confirm', confirmRoute('password_reset'));
  app.get('/auth/verification/status', requireUser, async (req, res) => {
    try {
      const status = await service.verificationStatus(req.user);
      return status ? res.json(status) : res.status(404).json({ error: 'account_unavailable', message: 'Account details are unavailable.' });
    } catch (_error) {
      return res.status(503).json({ error: 'auth_flows_unavailable', message: 'Email verification status is temporarily unavailable.' });
    }
  });
  return service;
}

module.exports = { PURPOSES, GENERIC_REQUEST_MESSAGE, INVALID_LINK_MESSAGE, tokenDigest, validToken, fixedPublicOrigin, authEmailReadiness, sendAuthEmail, createSqlAuthFlowStore, initAuthFlowsSchema, createAuthFlowService, createAuthRateLimiters, enforceCredentialVersion, integrateAuthFlows };
