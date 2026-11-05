'use strict';
// No network, browser, credentials, database, installed dependencies, or app-file writes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const ROOT = process.env.TROLLEYWISE_FRONTEND_SOURCE || require('node:path').join(__dirname, '../pwa');
const targets = ['src/components/scan-queue.tsx', 'src/lib/user-api.ts'];
const report = { isolated: true, productionRequests: 0, tests: [], compiler: null };
const compiled = new Map();
function source(file) {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(`${ROOT}/${file}`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: file,
  }).outputText);
  return compiled.get(file);
}
function load(file, mocks) {
  const exports = {};
  const ctx = vm.createContext({ exports, require: (name) => {
    if (!(name in mocks)) throw new Error(`Unexpected import: ${name} from ${file}`);
    return mocks[name];
  }, TextDecoder, Uint8Array, atob, fetch: (...args) => mocks.fetch(...args), window: mocks.window, AbortController, Event, Map, Set, Date, console });
  vm.runInContext(source(file), ctx, { filename: file });
  return exports;
}
function response(body, status = 200, stale = false) {
  return { ok: status >= 200 && status < 300, status, json: async () => body,
    headers: { get: (name) => stale && name === 'X-TrolleyWise-Cache' ? 'stale' : null } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function token(id, email = `${id}@example.test`) { return `test.${Buffer.from(JSON.stringify({ account_id: id, email })).toString('base64url')}.test`; }
const A = { id: 'stable-A', email: 'shared@example.test' };
const B = { id: 'stable-B', email: 'shared@example.test' };
const CODES = ['5449000009067', '6001253010178', '6001069206154'];
const ADDED_AT = '2026-11-05T14:14:00.123Z';
const queueLib = load('src/lib/scan-queue.ts', {});
function row(barcode, patch = {}) {
  return { barcode, source: 'manual', addedAt: ADDED_AT, status: 'success', productName: `Public product ${barcode}`,
    offer: { price: 24.99, retailer: 'checkers', stale: false, fromCache: false, updatedAt: ADDED_AT },
    checkedAt: ADDED_AT, error: null, historyRecorded: false, ...patch };
}
function runtime({ user = A, status = 'authenticated', restored = [], stale = true } = {}) {
  const r = { hooks: [], cursor: 0, effects: [], dirty: true, tree: null, handle: { current: null }, session: { data: user ? { user } : null, status },
    posts: [], tokenRequests: 0, guestScans: [], priceRequests: [], confirmations: [], confirmation: true, savedGuest: [], compareDeferred: new Map() };
  const cloudSaved = new Map();
  const storage = new Map();
  if (restored.length) storage.set(queueLib.SCAN_QUEUE_KEY, JSON.stringify({ version: 1, items: restored }));
  const listeners = new Map();
  r.window = {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout, clearTimeout, confirm: (message) => { r.confirmations.push(message); return r.confirmation; },
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatchEvent: (event) => { for (const fn of listeners.get(event.type) ?? []) fn(); },
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    forwardRef: (fn) => fn,
    useRef: (initial) => { const i = r.cursor++; if (!r.hooks[i]) r.hooks[i] = { current: initial }; return r.hooks[i]; },
    useState: (initial) => { const i = r.cursor++; if (!r.hooks[i]) {
      r.hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      r.hooks[i].set = (update) => { const next = typeof update === 'function' ? update(r.hooks[i].value) : update;
        if (!Object.is(next, r.hooks[i].value)) { r.hooks[i].value = next; r.dirty = true; } };
    } return [r.hooks[i].value, r.hooks[i].set]; },
    useCallback: (fn, deps) => { const i = r.cursor++; if (!r.hooks[i] || !same(r.hooks[i].deps, deps)) r.hooks[i] = { fn, deps }; return r.hooks[i].fn; },
    useEffect: (fn, deps) => { const i = r.cursor++; if (!r.hooks[i] || !same(r.hooks[i].deps, deps)) {
      const previous = r.hooks[i]; r.hooks[i] = { deps, cleanup: previous?.cleanup };
      r.effects.push(() => { r.hooks[i].cleanup?.(); r.hooks[i].cleanup = fn(); });
    } },
  };
  react.useImperativeHandle = (ref, make, deps) => react.useEffect(() => { ref.current = make(); return () => { ref.current = null; }; }, deps);
  const backendRequest = async (path, init = {}) => {
    assert.match(path, /^\/(price\/|users\/)/, 'Only mock-local endpoints allowed');
    if (path.startsWith('/price/')) {
      const barcode = decodeURIComponent(path.slice('/price/'.length)); r.priceRequests.push(barcode);
      if (r.compareDeferred.has(barcode)) return r.compareDeferred.get(barcode).promise;
      return response({ barcode, product: { barcode, name: `Public product ${barcode}` }, results: [ { retailer: 'checkers', price: 24.99, available: true, currency: 'ZAR' } ] }, 200, stale);
    }
    if (init.method === 'POST') {
      const post = { path, body: JSON.parse(init.body), auth: init.headers.Authorization }; r.posts.push(post);
      const result = r.postHandler ? await r.postHandler(post) : response(path === '/users/scans' ? { scan: { barcode: post.body.barcode, scanned_at: post.body.scanned_at } } : { favourite: { barcode: post.body.barcode } });
      if (path === '/users/favourites' && result.ok) {
        const body = await result.json(); if (body.favourite?.barcode === post.body.barcode) cloudSaved.set(post.body.barcode, body.favourite);
      }
      return result;
    }
    assert.equal(path, '/users/favourites'); return response({ favourites: [...cloudSaved.values()] });
  };
  r.fetch = async (path) => {
    assert.equal(path, '/api/account-token', 'No external fetch allowed'); r.tokenRequests++;
    if (r.tokenHandler) return r.tokenHandler();
    return response({ token: r.session.data?.user ? token(r.session.data.user.id ?? 'email-fallback', r.session.data.user.email) : undefined });
  };
  const guests = { guestDataPayload: () => ({}), readGuestFavourites: () => r.savedGuest, isGuestFavourite: (barcode) => r.savedGuest.some((v) => v.barcode === barcode),
    toggleGuestFavourite: (value) => { r.savedGuest.push(value); return true; }, recordGuestScan: (scan) => { r.guestScans.push(scan); } };
  r.api = load('src/lib/user-api.ts', { '@/lib/guest-data': guests, '@/lib/backend-api': { backendRequest }, fetch: r.fetch });
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  r.Component = load('src/components/scan-queue.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'next/link': () => {}, 'next-auth/react': { useSession: () => r.session },
    '@/lib/backend-api': { backendRequest }, '@/lib/guest-data': guests, '@/lib/user-api': r.api,
    '@/lib/price-api': { retailerName: (value) => value }, '@/components/guest-signup-prompt': { GuestSignupPrompt: () => {} },
    '@/lib/scan-queue': queueLib, window: r.window,
  }).ScanQueue;
  r.render = () => { r.cursor = 0; r.effects = []; r.dirty = false; r.tree = r.Component({}, r.handle); for (const effect of r.effects) effect(); };
  r.flush = async () => { for (let i = 0; i < 20; i++) { if (r.dirty) r.render(); await new Promise(setImmediate); } };
  r.setSession = async (nextUser, nextStatus = nextUser ? 'authenticated' : 'unauthenticated') => { r.session = { data: nextUser ? { user: nextUser } : null, status: nextStatus }; r.dirty = true; await r.flush(); };
  r.add = async (barcode, source = 'manual') => { const outcome = r.handle.current.add(barcode, source); await r.flush(); return outcome; };
  r.nodes = () => {
    const nodes = []; function walk(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk);
      nodes.push(node); walk(node.props?.children); } walk(r.tree); return nodes;
  };
  r.text = () => { function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return `${node}`;
    if (Array.isArray(node)) return node.map(text).join(' '); return text(node.props?.children); } return text(r.tree); };
  r.buttons = (label) => r.nodes().filter((node) => node.type === 'button' && node.props.children === label);
  r.click = async (label, index = 0) => { const button = r.buttons(label)[index]; assert.ok(button, `Missing button ${label}`); assert.ok(!button.props.disabled, `Disabled button ${label}`); button.props.onClick(); await r.flush(); };
  r.rows = () => JSON.parse(storage.get(queueLib.SCAN_QUEUE_KEY) ?? '{"items":[]}').items;
  r.dispose = () => { for (const hook of r.hooks) hook?.cleanup?.(); };
  return r;
}
async function test(name, fn) {
  try { await fn(); report.tests.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { report.tests.push({ name, passed: false, error: error.stack }); throw error; }
}
async function main() {
  await test('fresh stale scans record null prices and stable addedAt; duplicates ignored', async () => {
    const r = runtime(); await r.flush();
    for (const code of CODES) assert.equal(await r.add(code), 'added');
    assert.equal(await r.add(CODES[0]), 'duplicate');
    const posts = r.posts.filter((p) => p.path === '/users/scans'); assert.equal(posts.length, 3);
    posts.forEach((post) => { assert.equal(post.body.last_price, null); assert.equal(post.body.scanned_at, r.rows().find((v) => v.barcode === post.body.barcode).addedAt); });
    assert.ok(r.rows().every((v) => v.historyRecorded)); assert.equal(r.buttons('Retry history save').length, 0);
    const links = r.nodes().filter((n) => typeof n.props.href === 'string'); assert.ok(links.every((n) => n.props.href.endsWith('&from=scan-queue')));
    r.dirty = true; await r.flush(); assert.equal(r.posts.length, 3); r.dispose();
  });
  await test('fresh current and missing prices preserve scan event semantics', async () => {
    const r = runtime({ stale: false }); await r.flush(); await r.add(CODES[0]); assert.equal(r.posts[0].body.last_price, 24.99);
    const pending = deferred(); r.compareDeferred.set(CODES[1], pending); await r.add(CODES[1]);
    pending.resolve(response({ barcode: CODES[1], product: { barcode: CODES[1], name: 'Bread' }, results: [] })); await r.flush();
    assert.equal(r.posts[1].body.last_price, null); assert.ok(r.rows().every((v) => v.historyRecorded)); r.dispose();
  });
  await test('guest fresh stale scan uses null and stable timestamp, not cloud', async () => {
    const r = runtime({ user: null, status: 'unauthenticated' }); await r.flush(); await r.add(CODES[0]);
    assert.equal(r.posts.length, 0); assert.equal(r.guestScans.length, 1); assert.equal(r.guestScans[0].lastPrice, null);
    assert.equal(r.guestScans[0].scannedAt, r.rows()[0].addedAt); assert.equal(r.rows()[0].historyRecorded, true); r.dispose();
  });
  await test('restored success and missing rows require confirmed explicit history retry', async () => {
    const r = runtime({ user: B, restored: [row(CODES[0]), row(CODES[1], { status: 'missing', offer: null })] }); await r.flush();
    assert.equal(r.posts.length, 0); assert.equal(r.buttons('Retry history save').length, 2); assert.match(r.text(), /history save is not confirmed/);
    assert.ok(r.nodes().filter((n) => n.props.href).every((n) => n.props.href.endsWith('&from=scan-queue-pending')));
    r.confirmation = false; await r.click('Retry history save'); assert.equal(r.posts.length, 0);
    r.confirmation = true; await r.click('Retry history save'); assert.equal(r.posts.length, 1);
    assert.equal(r.posts[0].body.scanned_at, ADDED_AT); assert.equal(r.posts[0].body.last_price, null); assert.ok(r.confirmations.every((s) => /earlier save may have completed/.test(s)));
    assert.equal(r.rows()[0].historyRecorded, true); assert.equal(r.rows()[1].historyRecorded, false); r.dispose();
  });
  await test('restored recorded rows and restored queued comparison do not replay history', async () => {
    const r = runtime({ restored: [row(CODES[0], { historyRecorded: true }), row(CODES[1], { status: 'queued', offer: null })] }); await r.flush();
    assert.equal(r.posts.length, 0); assert.equal(r.priceRequests.length, 1); assert.equal(r.buttons('Retry history save').length, 1);
    await r.click('Recheck price', 1); assert.equal(r.posts.length, 0); r.dispose();
  });
  await test('loading candidate binds first settled stable id, never later principal', async () => {
    const r = runtime({ user: null, status: 'loading' }); await r.flush(); const pending = deferred(); r.compareDeferred.set(CODES[0], pending);
    await r.add(CODES[0]); assert.equal(r.posts.length, 0); await r.setSession(A); await r.setSession(B);
    pending.resolve(response({ barcode: CODES[0], product: { barcode: CODES[0], name: 'Cola' }, results: [] })); await r.flush();
    assert.equal(r.posts.length, 0); assert.equal(r.buttons('Retry history save').length, 1);
    await r.setSession(A); assert.equal(r.posts.length, 0); r.dispose();
  });
  await test('loading-to-first-owner completion writes exactly once for that owner', async () => {
    const r = runtime({ user: null, status: 'loading' }); await r.flush(); await r.add(CODES[0]); assert.equal(r.posts.length, 0);
    await r.setSession(A); assert.equal(r.posts.length, 1); assert.equal(r.posts[0].auth, `Bearer ${token(A.id, A.email)}`); r.dispose();
  });
  await test('guest candidate awaiting comparison cannot move to signed-in principal', async () => {
    const r = runtime({ user: null, status: 'unauthenticated' }); await r.flush(); const pending = deferred(); r.compareDeferred.set(CODES[0], pending);
    await r.add(CODES[0]); await r.setSession(A); pending.resolve(response({ barcode: CODES[0], product: { barcode: CODES[0] }, results: [] })); await r.flush();
    assert.equal(r.posts.length, 0); assert.equal(r.guestScans.length, 0); assert.equal(r.buttons('Retry history save').length, 1); r.dispose();
  });
  await test('token expected stable id rejects switched B even when email is shared', async () => {
    const r = runtime(); await r.flush(); r.tokenHandler = async () => response({ token: token(B.id, B.email) }); await r.add(CODES[0]);
    assert.equal(r.posts.length, 0); assert.equal(r.buttons('Retry history save').length, 1); r.dispose();
  });
  await test('history token wait checks owner after token resolves and before mutation', async () => {
    const r = runtime(); await r.flush(); const pending = deferred(); r.tokenHandler = () => pending.promise;
    await r.add(CODES[0]); await r.setSession(B); pending.resolve(response({ token: token(A.id, A.email) })); await r.flush();
    assert.equal(r.posts.length, 0); assert.equal(r.rows()[0].historyRecorded, false); assert.equal(r.buttons('Retry history save').length, 1);
    r.tokenHandler = null; await r.click('Retry history save'); assert.equal(r.posts.length, 1); assert.equal(r.posts[0].auth, `Bearer ${token(B.id, B.email)}`); r.dispose();
  });
  await test('in-flight unknown history commit across switch does not mark/replay for B', async () => {
    const r = runtime(); await r.flush(); const pending = deferred(); r.postHandler = () => pending.promise;
    await r.add(CODES[0]); assert.equal(r.posts.length, 1); await r.setSession(B);
    pending.resolve(response({ scan: { barcode: CODES[0] } })); await r.flush();
    assert.equal(r.posts.length, 1); assert.equal(r.rows()[0].historyRecorded, false); assert.equal(r.buttons('Retry history save').length, 1); r.dispose();
  });
  await test('history concurrency stays at two and failed writes only retry explicitly', async () => {
    const r = runtime(); await r.flush(); const waits = []; r.postHandler = (post) => { const wait = deferred(); waits.push({ wait, post }); return wait.promise; };
    for (const code of CODES) await r.add(code); assert.equal(r.posts.length, 2);
    waits[0].wait.resolve(response({ message: 'Unknown commit' }, 503)); await r.flush(); assert.equal(r.posts.length, 3); assert.equal(r.buttons('Retry history save').length, 1);
    const retryAt = r.posts[0].body.scanned_at; r.dirty = true; await r.flush(); assert.equal(r.posts.length, 3);
    waits[1].wait.resolve(response({ scan: { barcode: waits[1].post.body.barcode } })); waits[2].wait.resolve(response({ scan: { barcode: waits[2].post.body.barcode } })); await r.flush();
    r.postHandler = null; await r.click('Retry history save'); assert.equal(r.posts.length, 4); assert.equal(r.posts[3].body.scanned_at, retryAt); assert.ok(r.rows().every((v) => v.historyRecorded)); r.dispose();
  });
  await test('remount of unconfirmed history never retries automatically', async () => {
    const r = runtime(); await r.flush(); r.postHandler = async () => response({ message: 'Unconfirmed' }, 503); await r.add(CODES[0]); const rows = r.rows(); r.dispose();
    const remount = runtime({ restored: rows }); await remount.flush(); assert.equal(remount.posts.length, 0); assert.equal(remount.buttons('Retry history save').length, 1); remount.dispose();
  });
  await test('removed and re-added barcode has independent history identity', async () => {
    const r = runtime(); await r.flush(); r.postHandler = async () => response({ message: 'Unconfirmed' }, 503); await r.add(CODES[0]); const previous = r.rows()[0].addedAt;
    await r.click('Remove'); r.postHandler = null; await new Promise((resolve) => setTimeout(resolve, 3)); await r.add(CODES[0]);
    assert.equal(r.posts.length, 2); assert.notEqual(r.posts[1].body.scanned_at, previous); assert.equal(r.rows()[0].historyRecorded, true); r.dispose();
  });
  await test('clearing queue while token pending prevents write before and after re-add', async () => {
    const r = runtime(); await r.flush(); const pending = deferred(); r.tokenHandler = () => pending.promise; await r.add(CODES[0]); await r.click('Clear queue');
    pending.resolve(response({ token: token(A.id, A.email) })); await r.flush(); assert.equal(r.posts.length, 0);
    r.tokenHandler = null; await r.add(CODES[0]); assert.equal(r.posts.length, 1); r.dispose();
  });
  await test('favourite batch token wait is owner-guarded and queued work cannot move', async () => {
    const r = runtime({ restored: CODES.map((code) => row(code, { historyRecorded: true })) }); await r.flush();
    const pending = deferred(); r.tokenHandler = () => pending.promise; await r.click('Select unsaved'); await r.click('Save selected (3)');
    await r.setSession(B); pending.resolve(response({ token: token(A.id, A.email) })); await r.flush(); assert.equal(r.posts.length, 0); r.dispose();
  });
  await test('same-owner favourite batch remains bounded and confirms all three', async () => {
    const r = runtime({ restored: CODES.map((code) => row(code, { historyRecorded: true })) }); await r.flush(); const waits = [];
    r.postHandler = (post) => { const wait = deferred(); waits.push({ post, wait }); return wait.promise; };
    await r.click('Select unsaved'); await r.click('Save selected (3)'); assert.equal(r.posts.length, 2);
    waits[0].wait.resolve(response({ favourite: { barcode: waits[0].post.body.barcode } })); await r.flush(); assert.equal(r.posts.length, 3);
    for (const value of waits.slice(1)) value.wait.resolve(response({ favourite: { barcode: value.post.body.barcode } })); await r.flush();
    assert.equal(r.buttons('Saved favourite').length, 3); assert.ok(r.posts.every((v) => v.path === '/users/favourites')); r.dispose();
  });
  await test('stable id takes precedence and email fallback is backwards compatible', async () => {
    const r = runtime({ user: { email: 'Owner@Example.Test' } }); await r.flush(); await r.add(CODES[0]); assert.equal(r.posts.length, 1); r.dispose();
    const generic = runtime(); await generic.api.recordCloudScan(CODES[0], 'Public name', 12.34); await generic.api.addCloudFavourite(CODES[0], 'Public name');
    assert.equal(generic.posts.length, 2); assert.ok(Number.isFinite(Date.parse(generic.posts[0].body.scanned_at))); assert.equal(generic.posts[0].body.last_price, 12.34);
  });
  await test('unmounted queue blocks token-delayed scan and favourite mutations', async () => {
    const r = runtime(); await r.flush(); const pending = deferred(); r.tokenHandler = () => pending.promise; await r.add(CODES[0]);
    await r.click('Save favourite'); r.dispose(); pending.resolve(response({ token: token(A.id, A.email) })); await r.flush(); assert.equal(r.posts.length, 0);
  });
  await test('generic userRequest guards reject before fetch and after token resolution', async () => {
    const r = runtime(); await assert.rejects(r.api.userRequest('/users/scans', { method: 'POST' }, { shouldProceed: () => false }), /account or scan queue changed/);
    assert.equal(r.tokenRequests, 0); assert.equal(r.posts.length, 0);
    let allowed = true; const pending = deferred(); r.tokenHandler = () => pending.promise;
    const call = r.api.recordCloudScan(CODES[0], 'Public name', null, { scannedAt: ADDED_AT, expectedIdentity: A.id, shouldProceed: () => allowed });
    allowed = false; pending.resolve(response({ token: token(A.id, A.email) })); await assert.rejects(call, /account or scan queue changed/); assert.equal(r.posts.length, 0);
  });
  // Check only the two allowed source files with the existing compiler options/declarations.
  const config = ts.readConfigFile(`${ROOT}/tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const names = targets.map((name) => `${ROOT}/${name}`);
  const declarations = parsed.fileNames.filter((name) => name.endsWith('.d.ts'));
  const program = ts.createProgram([...names, ...declarations], { ...parsed.options, incremental: false, noEmit: true });
  const diagnostics = [...program.getOptionsDiagnostics(), ...names.flatMap((name) => {
    const file = program.getSourceFile(name); assert.ok(file); return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
  })];
  report.compiler = { files: targets, passed: diagnostics.length === 0, diagnostics: diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')) };
  assert.equal(diagnostics.length, 0, JSON.stringify(report.compiler, null, 2));
  console.log(`PASS scoped compiler (${targets.join(', ')})`);
  report.passed = true;
}
main().catch((error) => { console.error(error); report.passed = false; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'trolleywise-queue-history-regression-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Completed ${report.tests.length} isolated regressions; no production requests.`);
});
