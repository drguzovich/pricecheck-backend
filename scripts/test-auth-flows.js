'use strict';

// All users, storage, HTTP handlers and email sinks below are isolated test fixtures.
// No application server, production database or provider is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const ts = require('typescript');
const { verifyPassword, hashPassword } = require('../src/userAuth');
const {
  PURPOSES, GENERIC_REQUEST_MESSAGE, tokenDigest, fixedPublicOrigin,
  authEmailReadiness, createSqlAuthFlowStore, createAuthFlowService, integrateAuthFlows,
} = require('../src/authFlows');

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions += 1; }
const env = { AUTH_PUBLIC_ORIGIN: 'https://accounts.example.test', RESEND_API_KEY: 'isolated-test-placeholder', AUTH_FROM_EMAIL: 'test@example.test' };
function memoryStore() {
  let now = Date.now();
  const user = { id: 1, email: 'fixture@example.test', email_verified_at: null, auth_version: 0, password_hash: null };
  const tokens = [];
  let lookups = 0;
  return {
    user, tokens,
    setNow(value) { now = value; },
    get lookups() { return lookups; },
    async findPasswordUser(email) { lookups += 1; return email === user.email ? { ...user } : null; },
    async issue(principal, purpose, digest, ttl) {
      if (principal.id !== user.id || principal.email !== user.email || (purpose === 'verification' && user.email_verified_at)) return false;
      tokens.filter((entry) => entry.purpose === purpose).forEach((entry) => { entry.used = true; });
      tokens.push({ digest, purpose, expires: now + ttl * 1000, used: false, version: user.auth_version, email: user.email });
      return true;
    },
    async revoke(digest) { const row = tokens.find((entry) => entry.digest === digest); if (row) row.used = true; },
    async consume(digest, purpose, passwordHash) {
      const row = tokens.find((entry) => entry.digest === digest && entry.purpose === purpose);
      if (!row || row.used || row.expires <= now || row.version !== user.auth_version || row.email !== user.email) return false;
      row.used = true;
      if (purpose === 'verification') user.email_verified_at = new Date(now);
      else { user.password_hash = passwordHash; user.auth_version += 1; tokens.forEach((entry) => { entry.used = true; }); }
      return true;
    },
    async verificationStatus(principal) {
      return principal.accountId === `password:${user.email}` && principal.email === user.email
        ? { provider: 'password', emailVerified: Boolean(user.email_verified_at), authVersion: user.auth_version } : null;
    },
  };
}
function emailToken(message) { return new URL(message.text.match(/https:\/\/[^\s]+/)[0]).hash.slice('#token='.length); }

async function testService() {
  check(fixedPublicOrigin(env) === 'https://accounts.example.test', 'Fixed configured origin accepted');
  for (const invalid of ['https://accounts.example.test/path', 'https://user:password@accounts.example.test', 'https://accounts.example.test/?redirect=evil', 'https://accounts.example.test/#fragment', 'http://accounts.example.test', '//accounts.example.test']) {
    check(fixedPublicOrigin({ AUTH_PUBLIC_ORIGIN: invalid }) === null, 'Unsafe origin rejected');
  }
  check(fixedPublicOrigin({ AUTH_PUBLIC_ORIGIN: 'http://localhost:8081', AUTH_TRUST_LOCAL_HTTP: 'true' }) === 'http://localhost:8081', 'Explicit localhost exception accepted');
  check(!authEmailReadiness({}, true).emailFlowsEnabled, 'Missing mail is honestly disabled');
  check(!authEmailReadiness(env, false).emailFlowsEnabled, 'Missing schema/database is honestly disabled');
  check(authEmailReadiness(env, true).emailDeliveryVerified === false, 'Configured mail does not claim delivery proof');
  check(!authEmailReadiness({ ...env, RESEND_API_KEY: '', SMTP_HOST: 'localhost', SMTP_USER: 'fixture', SMTP_PASS: 'fixture', SMTP_PORT: 'invalid' }, true).emailFlowsEnabled, 'Invalid SMTP port rejected');
  const store = memoryStore();
  const messages = [];
  const events = [];
  const service = createAuthFlowService({ store, env, databaseReady: () => true, mailer: async (mail) => { messages.push(mail); }, onEvent: (code) => events.push(code) });
  await service.requestLink('verification', '  FIXTURE@example.test  ');
  check(messages.length === 1, 'Eligible password fixture receives verification email');
  const verification = emailToken(messages[0]);
  check(/^[A-Za-z0-9_-]{43}$/.test(verification), '256-bit opaque token format');
  check(store.tokens[0].digest === tokenDigest(verification) && !JSON.stringify(store.tokens).includes(verification), 'Only digest stored');
  check(messages[0].text.includes('https://accounts.example.test/account/verify-email#token='), 'Fixed origin and fragment link used');
  check(store.tokens[0].expires - Date.now() <= PURPOSES.verification * 1000, '24-hour expiry assigned');
  check((await service.confirm('password_reset', verification, 'new-fixture-password')).status === 400, 'Purpose confusion rejected');
  check((await service.confirm('verification', 'invalid')).status === 400, 'Malformed token rejected');
  check((await service.confirm('verification', verification)).status === 200, 'Real confirmation consumes eligible token');
  check(Boolean(store.user.email_verified_at), 'Verification timestamp set only after confirmation');
  check((await service.confirm('verification', verification)).status === 400, 'Verification reuse rejected');
  await service.requestLink('verification', store.user.email);
  await service.requestLink('verification', 'missing@example.test');
  check(messages.length === 1, 'Already-verified and missing accounts do not send links');
  await service.requestLink('password_reset', store.user.email);
  const reset = emailToken(messages.at(-1));
  check((await service.confirm('password_reset', reset, 'short')).status === 400, 'Weak password rejected without consuming token');
  const results = await Promise.all([service.confirm('password_reset', reset, 'new-fixture-password'), service.confirm('password_reset', reset, 'new-fixture-password')]);
  check(results.filter((result) => result.status === 200).length === 1, 'Concurrent reset consumes once');
  check(await verifyPassword('new-fixture-password', store.user.password_hash), 'Reset uses existing real scrypt format');
  check(!await verifyPassword('wrong-fixture-password', store.user.password_hash), 'Wrong password fails after reset');
  check(store.user.auth_version === 1, 'Reset advances credential version');
  await service.requestLink('password_reset', store.user.email);
  const oldReset = emailToken(messages.at(-1));
  await service.requestLink('password_reset', store.user.email);
  const newestReset = emailToken(messages.at(-1));
  check(oldReset !== newestReset, 'Each link uses fresh randomness');
  check((await service.confirm('password_reset', oldReset, 'new-fixture-password')).status === 400, 'Resend invalidates prior link');
  store.setNow(Date.now() + PURPOSES.password_reset * 1000 + 1000);
  check((await service.confirm('password_reset', newestReset, 'new-fixture-password')).status === 400, 'Expired reset rejected');
  store.setNow(Date.now());
  const failing = createAuthFlowService({ store, env, databaseReady: () => true, mailer: async () => { throw new Error('private provider message'); }, onEvent: (code) => events.push(code) });
  await failing.requestLink('password_reset', store.user.email);
  check(store.tokens.at(-1).used, 'Provider-rejected link revoked');
  check(events.every((event) => /^auth_[a-z_]+$/.test(event)), 'Diagnostics contain only safe event codes');
  const noMail = createAuthFlowService({ store, env: {}, databaseReady: () => true, mailer: async () => { throw new Error('must not send'); } });
  const lookups = store.lookups;
  await noMail.requestLink('password_reset', store.user.email);
  check(store.lookups === lookups, 'Unconfigured mail skips lookup and delivery');
  return { service, store };
}
async function testSqlContract() {
  const statements = [];
  let inTransaction = false;
  const client = async (strings, ...values) => {
    const text = strings.join('?');
    statements.push({ text, values, inTransaction });
    if (text.includes('SELECT user_id FROM')) return [{ user_id: 1 }];
    if (text.includes('SELECT id, email, auth_version')) return [{ id: 1, email: 'fixture@example.test', auth_version: 0 }];
    if (text.includes('RETURNING id')) return [{ id: 1 }];
    return [];
  };
  client.begin = async (work) => { check(!inTransaction, 'No nested transaction'); inTransaction = true; try { return await work(client); } finally { inTransaction = false; } };
  const store = createSqlAuthFlowStore(client);
  await store.initialize();
  check(statements.filter((entry) => entry.text.includes('ADD COLUMN IF NOT EXISTS')).length === 2, 'Idempotent user migrations supplied');
  check(statements.some((entry) => entry.text.includes('REFERENCES users(id) ON DELETE CASCADE')), 'Token foreign key deletes with user');
  statements.length = 0;
  await store.consume('a'.repeat(64), 'password_reset', await hashPassword('fixture-only-password'));
  check(statements.every((entry) => entry.inTransaction), 'Consume and password update share a Postgres transaction');
  check(statements.some((entry) => entry.text.includes('FOR UPDATE')), 'User-first locking serializes consumption');
  const consume = statements.find((entry) => entry.text.includes('RETURNING id'));
  check(consume.text.includes('used_at IS NULL AND expires_at > NOW()'), 'Atomic consume checks expiry and single use in SQL');
  check(consume.text.includes('credential_version =') && consume.text.includes('email ='), 'Token bound to current credential version and email');
  check(statements.some((entry) => entry.text.includes('auth_version = auth_version + 1')), 'SQL reset advances revocation version');
}
async function withApp(service, work) {
  const queued = [];
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  integrateAuthFlows(app, { service, enqueue: (task) => queued.push(task) });
  app.post('/auth/login', (_req, res) => res.json({ fixtureHandlerReached: true }));
  app.post('/auth/register', (_req, res) => res.json({ fixtureHandlerReached: true }));
  app.get('/users/me', (_req, res) => res.json({ fixtureHandlerReached: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await work(base, queued); } finally { await new Promise((resolve) => server.close(resolve)); }
}
async function post(base, route, body, headers = {}) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function testRoutes(service, store) {
  await withApp(service, async (base, queued) => {
    const before = store.lookups;
    const exists = await post(base, '/auth/password-reset/request', { email: store.user.email, origin: 'https://evil.example.test' });
    const missing = await post(base, '/auth/password-reset/request', { email: 'missing@example.test' });
    const invalid = await post(base, '/auth/password-reset/request', { email: 'invalid' });
    check(exists.status === 202 && missing.status === 202 && invalid.status === 202, 'All eligible-service requests use same status');
    check(JSON.stringify(exists.body) === JSON.stringify(missing.body) && JSON.stringify(missing.body) === JSON.stringify(invalid.body), 'No user enumeration in response body');
    check(exists.body.message === GENERIC_REQUEST_MESSAGE, 'No claim that email was sent');
    check(store.lookups === before && queued.length === 3, 'Response precedes all account/provider work');
    check(exists.headers.get('cache-control') === 'private, no-store', 'Recovery response not cached');
    for (let index = 0; index < 4; index += 1) await post(base, '/auth/password-reset/request', { email: 'missing@example.test' });
    const limited = await post(base, '/auth/password-reset/request', { email: 'missing@example.test' });
    check(limited.status === 429 && Number(limited.headers.get('retry-after')) > 0, 'Per-email recovery limit and Retry-After');
    for (let index = 0; index < 10; index += 1) check((await post(base, '/auth/login', { email: 'login-fixture@example.test' })).status === 200, 'Existing login handler remains reachable');
    check((await post(base, '/auth/login', { email: 'login-fixture@example.test' })).status === 429, 'Limiter wraps existing login handler');
  });
  await withApp(service, async (base) => {
    for (let index = 0; index < 40; index += 1) await post(base, '/auth/verification/confirm', { token: 'bad' }, { 'X-PriceCheck-Client': randomBytes(32).toString('hex'), 'X-PriceCheck-Timestamp': String(Date.now()), 'X-PriceCheck-Signature': '0'.repeat(64) });
    check((await post(base, '/auth/verification/confirm', { token: 'bad' })).status === 429, 'Forged proxy headers cannot evade per-IP auth budget');
  });
  await withApp(createAuthFlowService({ env: {}, databaseReady: () => false }), async (base) => {
    const one = await post(base, '/auth/password-reset/request', { email: 'one@example.test' });
    const two = await post(base, '/auth/password-reset/request', { email: 'two@example.test' });
    check(one.status === 503 && JSON.stringify(one.body) === JSON.stringify(two.body), 'Unconfigured email response is honest and generic');
  });
  const original = process.env.USER_SYNC_JWT_SECRET;
  process.env.USER_SYNC_JWT_SECRET = randomBytes(32).toString('hex');
  try {
    await withApp(service, async (base) => {
      const token = (version) => jwt.sign({ account_id: `password:${store.user.email}`, email: store.user.email, auth_version: version }, process.env.USER_SYNC_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1m' });
      const revoked = await fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${token(store.user.auth_version - 1)}` } });
      const current = await fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${token(store.user.auth_version)}` } });
      check(revoked.status === 401, 'Password reset revokes already-issued account-sync JWT');
      check(current.status === 200, 'Current credential version remains authenticated');
      const forged = await fetch(`${base}/users/me`, { headers: { Authorization: 'Bearer not-a-token' } });
      check(forged.status === 401, 'Invalid sessions never reach user handler');
    });
  } finally { if (original === undefined) delete process.env.USER_SYNC_JWT_SECRET; else process.env.USER_SYNC_JWT_SECRET = original; }
}
function loadTs(file, globals = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, ...globals }, { filename: file });
  return exports;
}
function testDemoAndFrontend() {
  const frontend = path.resolve(__dirname, '../../pricecheck');
  const demo = loadTs(path.join(frontend, 'src/lib/demo-data.ts'));
  const data = new Map([['pricecheck-history', 'untouched history'], ['trolleywise-favourites', 'untouched favourites'], ['next-auth.session-token', 'untouched session']]);
  const touched = [];
  const storage = { getItem(key) { touched.push(key); return data.get(key) || null; }, setItem(key, value) { touched.push(key); data.set(key, value); }, removeItem(key) { touched.push(key); data.delete(key); } };
  let state = demo.loadDemoState(storage);
  state = demo.toggleDemoFavourite(state, 'fixture-cupboard');
  state = demo.addDemoScan(state, 'fixture-pantry');
  state = demo.addDemoScan(state, 'fixture-pantry');
  check(state.scanned.length === 1 && state.favourites.length === 3, 'Demo deduplicates and saves multiple fixture items');
  check(demo.saveDemoState(storage, state), 'Demo can persist fixture state');
  check(demo.loadDemoState(storage).favourites.length === 3, 'Fixture storage roundtrip');
  demo.resetDemoState(storage);
  check(touched.every((key) => key === demo.DEMO_STORAGE_KEY), 'Demo accesses only isolated key');
  check(data.get('pricecheck-history') === 'untouched history' && data.get('trolleywise-favourites') === 'untouched favourites' && data.get('next-auth.session-token') === 'untouched session', 'Reset never changes real guest/account/session data');
  data.set(demo.DEMO_STORAGE_KEY, JSON.stringify({ version: 1, favourites: ['fixture-pantry', 'real-barcode', 'fixture-pantry'], scanned: ['real-user-id'] }));
  check(demo.loadDemoState(storage).favourites.length === 1 && demo.loadDemoState(storage).scanned.length === 0, 'Untrusted fixture state sanitized');
  data.set(demo.DEMO_STORAGE_KEY, '{bad json');
  check(demo.loadDemoState(storage).version === 1, 'Corrupt demo state degrades safely');
  check(!demo.saveDemoState({ setItem() { throw new Error('blocked'); } }, state), 'Storage failures are honest');
  const page = fs.readFileSync(path.join(frontend, 'src/app/demo/page.tsx'), 'utf8');
  check(!/next-auth|user-api|guest-data|backendRequest|\bfetch\s*\(/.test(page), 'Demo page has no authentication or cloud API operations');
  check(!JSON.stringify(demo.DEMO_PRODUCTS).match(/"(?:price|score|nutrition|barcode|accountId)"/), 'Fixtures contain no invented prices, health data or user identity');
  const flowFile = path.join(frontend, 'src/lib/auth-flows.ts');
  const fragmentToken = randomBytes(32).toString('base64url');
  let cleared = '';
  const flows = loadTs(flowFile, { window: { location: { hash: `#token=${fragmentToken}`, pathname: '/account/reset-password' }, history: { state: null, replaceState(_state, _title, target) { cleared = target; } } }, URLSearchParams });
  check(flows.takeLinkToken() === fragmentToken && cleared === '/account/reset-password', 'Fragment token removed before explicit confirmation');
  for (let index = 0; index < 40; index += 1) check(flows.consumeAuthBudget('fixture-ip', 1000).allowed, 'Frontend auth budget allows bounded requests');
  check(!flows.consumeAuthBudget('fixture-ip', 1000).allowed && flows.consumeAuthBudget('fixture-ip', 901001).allowed, 'Frontend budget enforces and expires');
  const authSource = fs.readFileSync(path.join(frontend, 'src/lib/auth-options.ts'), 'utf8');
  check(authSource.includes('process.env.NEXTAUTH_SECRET || process.env.APP_SESSION_SECRET'), 'APP_SESSION_SECRET fallback provided');
  check(!authSource.includes('NEXTAUTH_SECRET || process.env.USER_SYNC_JWT_SECRET'), 'Session secret never falls back to sync secret');
  check(authSource.includes('useSecureCookies ? "none" : "lax"') && authSource.includes('secure: useSecureCookies'), 'External HTTPS keeps SameSite=None; Secure');
  const tokenSource = fs.readFileSync(path.join(frontend, 'src/app/api/account-token/route.ts'), 'utf8');
  check(!tokenSource.includes('process.env.NEXTAUTH_SECRET') && tokenSource.includes('auth_version:'), 'Account signatures use only independent sync key and version');
  for (const file of ['src/app/account/page.tsx', 'src/app/demo/page.tsx', 'src/app/account/forgot-password/page.tsx', 'src/app/account/reset-password/page.tsx', 'src/app/account/verify-email/page.tsx']) {
    check(!fs.readFileSync(path.join(frontend, file), 'utf8').includes('—'), 'Owned customer-facing pages contain no em dash');
  }
}
(async () => {
  const { service, store } = await testService();
  await testSqlContract();
  await testRoutes(service, store);
  testDemoAndFrontend();
  console.log(`PASS: ${assertions} isolated auth-flow, limiter, SQL-contract, session-revocation and demo safety assertions.`);
  console.log('No live database, email provider, production writes, fake account session or retailer/health data used.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
