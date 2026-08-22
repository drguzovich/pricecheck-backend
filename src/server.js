'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const Sentry = require('@sentry/node');
const next = require('next');
const { createRateLimiter } = require('./rateLimit');

const {
  initSchema, checkDatabase, recordProductRequest, listProductRequests, getCoverageStats,
  upsertUser, createPasswordUser, getPasswordUser, listScanHistory, recordScan, listFavourites, addFavourite, removeFavourite,
  listAlerts, createAlert, deactivateAlert, getUserSummary, migrateGuestData,
} = require('./db');
const { hashPassword, normalizeEmail, requireUser, validateRegistration, verifyPassword } = require('./userAuth');
const { processPriceAlerts } = require('./alerts');
const { runSeed } = require('../scripts/seed-catalogue');
const {
  getComparison,
  forceRefreshComparison,
  searchProducts,
  getAllTrackedBarcodes,
} = require('./priceService');

const app = express();
const PORT = process.env.PORT || 3001;
const pwaDirectory = path.join(__dirname, '..', 'pwa');
const servePwa = process.env.NODE_ENV === 'production' && fs.existsSync(pwaDirectory);
const publicWebUrl = process.env.PRICECHECK_WEB_URL || 'https://pricecheck-backend-7tkh.onrender.com';
if (!process.env.NEXTAUTH_URL) process.env.NEXTAUTH_URL = publicWebUrl;
const nextApp = servePwa ? next({ dev: false, dir: pwaDirectory }) : null;
let nextRequestHandler = null;

Sentry.init({ dsn: process.env.SENTRY_DSN || undefined, environment: process.env.NODE_ENV || 'development', enabled: Boolean(process.env.SENTRY_DSN) });

const configuredOrigins = String(process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
const allowOrigin = (origin, callback) => {
  if (!origin || !configuredOrigins.length || configuredOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by PriceCheck API policy'));
};

// The PWA is served by Next.js from this same process. Next emits inline
// bootstrap scripts, so its own response headers remain authoritative.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowOrigin, methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-refresh-token'] }));
app.use(express.json());

const rateLimitWindowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitMaxRequests = Number(process.env.API_RATE_LIMIT_MAX_REQUESTS || 30);
const priceRequestLimiter = createRateLimiter({
  windowMs: rateLimitWindowMs,
  maxRequests: rateLimitMaxRequests,
});
const authRequestLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10 });
const apiPrefix = (pathName) => ['/price', '/search', '/api/search', '/auth', '/product-requests', '/users', '/coverage', '/admin']
  .some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`));
app.use((req, res, nextMiddleware) => {
  // Application documents and Next assets must not consume the bounded API
  // quota. Comparison and account paths retain their existing protection.
  if (req.path === '/health' || !apiPrefix(req.path)) return nextMiddleware();
  return priceRequestLimiter(req, res, nextMiddleware);
});
app.use('/auth', authRequestLimiter);

function validBarcode(barcode) {
  return /^\d{8,14}$/.test(barcode);
}

function adminRefreshAllowed(req) {
  const requiredToken = process.env.ADMIN_REFRESH_TOKEN;
  return Boolean(requiredToken && req.get('x-admin-refresh-token') === requiredToken);
}

function comparisonResponse(comparison, legacy) {
  return {
    ...comparison,
    // Legacy fields keep the existing Expo client functional while the PWA
    // reads the canonical `results` array.
    retailer: legacy?.retailer ?? null,
    price: legacy?.price ?? null,
    price_str: legacy?.price_str ?? null,
    scraped_at: legacy?.scraped_at ?? null,
    url: legacy?.url ?? null,
    promo_flag: legacy?.promo_flag ?? false,
    from_cache: legacy?.from_cache ?? false,
    stale: legacy?.stale ?? false,
  };
}

function woolworthsLegacy(comparison) {
  const result = comparison.results.find((item) => item.retailer === 'woolworths');
  if (!result?.available) return null;
  return {
    retailer: result.retailer,
    price: result.price,
    price_str: result.price_str,
    scraped_at: result.updated_at,
    url: result.url,
    promo_flag: result.promo_flag,
    from_cache: result.from_cache,
    stale: result.stale,
  };
}

const startedAt = Date.now();
let seedStatus = { state: 'idle', updatedAt: null, progress: null, error: null };

app.get('/health', async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ status: 'ok', db: 'connected', uptime: Math.floor((Date.now() - startedAt) / 1000), timestamp: new Date().toISOString() });
  } catch (_error) {
    res.status(503).json({ status: 'unavailable', db: 'disconnected', uptime: Math.floor((Date.now() - startedAt) / 1000) });
  }
});

app.get('/coverage', async (_req, res) => {
  try {
    return res.json({ checked_at: new Date().toISOString(), ...(await getCoverageStats()) });
  } catch (error) {
    console.error('[server] Coverage status error:', error);
    return res.status(503).json({ error: 'coverage_unavailable', message: 'Coverage status is temporarily unavailable' });
  }
});

app.get('/admin/seed-catalogue', (req, res) => {
  if (!adminRefreshAllowed(req)) return res.status(404).json({ error: 'not_found' });
  return res.json(seedStatus);
});

app.post('/admin/seed-catalogue', (req, res) => {
  if (!adminRefreshAllowed(req)) return res.status(404).json({ error: 'not_found' });
  if (seedStatus.state === 'running') return res.status(409).json({ error: 'seed_running', message: 'A seed run is already in progress.', seed: seedStatus });
  seedStatus = { state: 'running', updatedAt: new Date().toISOString(), progress: null, error: null };
  runSeed({ onProgress: (progress) => { seedStatus = { state: 'running', updatedAt: new Date().toISOString(), progress, error: null }; } })
    .then((result) => { seedStatus = { state: 'complete', updatedAt: new Date().toISOString(), progress: result, error: null }; })
    .catch((error) => { Sentry.captureException(error); seedStatus = { state: 'failed', updatedAt: new Date().toISOString(), progress: null, error: error.message }; });
  return res.status(202).json({ message: 'Verified catalogue seed started.', seed: seedStatus });
});

app.get('/price/:barcode', async (req, res) => {
  const { barcode } = req.params;
  if (!validBarcode(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }

  try {
    const comparison = await getComparison(barcode);
    const legacy = woolworthsLegacy(comparison);
    const hasAvailableResult = comparison.results.some((result) => result.available);
    if (!hasAvailableResult) {
      return res.status(404).json({
        error: 'not_found',
        message: `No retailer listing found for barcode ${barcode}`,
        ...comparisonResponse(comparison, legacy),
      });
    }
    return res.json(comparisonResponse(comparison, legacy));
  } catch (error) {
    console.error(`[server] Comparison error for ${barcode}:`, error);
    return res.status(503).json({ error: 'comparison_unavailable', message: 'Price comparison is temporarily unavailable' });
  }
});

app.post('/price/:barcode/refresh', async (req, res) => {
  const { barcode } = req.params;
  if (!validBarcode(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }

  try {
    const comparison = await forceRefreshComparison(barcode);
    const legacy = woolworthsLegacy(comparison);
    const hasAvailableResult = comparison.results.some((result) => result.available);
    if (!hasAvailableResult) {
      return res.status(404).json({ error: 'not_found', message: `No fresh retailer listing found for barcode ${barcode}`, ...comparisonResponse(comparison, legacy) });
    }
    return res.json(comparisonResponse(comparison, legacy));
  } catch (error) {
    console.error(`[server] Refresh error for ${barcode}:`, error);
    return res.status(503).json({ error: 'comparison_unavailable', message: 'Unable to refresh prices right now' });
  }
});

async function handleSearch(req, res) {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.status(400).json({ error: 'invalid_query', message: 'Search query must contain at least 2 characters' });
  try {
    return res.json({ query, results: await searchProducts(query) });
  } catch (error) {
    console.error('[server] Search error:', error);
    return res.status(503).json({ error: 'search_unavailable', message: 'Search is temporarily unavailable' });
  }
}

// `/search` is a PWA document route. Preserve the original JSON endpoint for
// API callers while allowing standard browser navigation to fall through to
// Next.js, which renders the Search screen.
app.get('/api/search', handleSearch);
app.get('/search', (req, res, nextMiddleware) => {
  const accept = req.get('accept') || '';
  if (accept.includes('text/html') || accept.includes('application/xhtml+xml')) return nextMiddleware();
  return handleSearch(req, res);
});

app.post('/product-requests', async (req, res) => {
  const barcode = String(req.body?.barcode || '').replace(/\D/g, '');
  const productHint = typeof req.body?.product_hint === 'string' ? req.body.product_hint.trim() : '';
  if (!validBarcode(barcode)) {
    return res.status(400).json({ error: 'invalid_barcode', message: 'Barcode must be 8–14 digits' });
  }
  if (productHint.length > 140) {
    return res.status(400).json({ error: 'invalid_product_hint', message: 'Product hint must be 140 characters or fewer' });
  }

  try {
    const request = await recordProductRequest(barcode, productHint);
    return res.status(201).json({
      message: 'Product request saved for coverage review',
      request,
    });
  } catch (error) {
    console.error(`[server] Unable to save product request for ${barcode}:`, error);
    return res.status(503).json({ error: 'request_unavailable', message: 'Unable to save the product request right now' });
  }
});

function validPrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100000;
}

function publicAccount(user) {
  return {
    accountId: user.account_id,
    email: user.email,
    displayName: user.display_name ?? null,
  };
}

app.post('/auth/register', async (req, res) => {
  const validated = validateRegistration(req.body || {});
  if (validated.error) return res.status(400).json({ error: 'invalid_registration', message: validated.error });
  try {
    const created = await createPasswordUser({
      email: validated.email,
      displayName: validated.displayName,
      passwordHash: await hashPassword(req.body.password),
    });
    if (created.duplicate) return res.status(409).json({ error: 'account_exists', message: 'An account already exists for this email. Sign in instead.' });
    return res.status(201).json({ user: publicAccount(created.user) });
  } catch (error) {
    console.error('[server] Direct account registration error:', error.message);
    return res.status(503).json({ error: 'registration_unavailable', message: 'Unable to create an account right now. Please try again.' });
  }
});

app.post('/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'invalid_credentials', message: 'Enter your email and password.' });
  try {
    const user = await getPasswordUser(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    }
    return res.json({ user: publicAccount(user) });
  } catch (error) {
    console.error('[server] Direct account login error:', error.message);
    return res.status(503).json({ error: 'login_unavailable', message: 'Unable to sign in right now. Please try again.' });
  }
});

app.post('/users/migrate', requireUser, async (req, res) => {
  try {
    const user = await upsertUser(req.user);
    const summary = await migrateGuestData(user.id, req.body || {});
    return res.json({ user, summary });
  } catch (error) {
    console.error('[server] Guest migration error:', error);
    return res.status(503).json({ error: 'migration_unavailable', message: 'Unable to sync guest data right now.' });
  }
});

app.get('/users/me', requireUser, async (req, res) => {
  try {
    const user = await upsertUser(req.user);
    return res.json({ user, summary: await getUserSummary(user.id) });
  } catch (_error) {
    return res.status(503).json({ error: 'account_unavailable', message: 'Unable to load account details.' });
  }
});

app.route('/users/scans')
  .get(requireUser, async (req, res) => {
    try {
      const user = await upsertUser(req.user);
      return res.json({ scans: await listScanHistory(user.id) });
    } catch (_error) { return res.status(503).json({ error: 'history_unavailable', message: 'Unable to load scan history.' }); }
  })
  .post(requireUser, async (req, res) => {
    const barcode = String(req.body?.barcode || '').replace(/\D/g, '');
    const productName = String(req.body?.product_name || '').trim();
    if (!validBarcode(barcode) || !productName || productName.length > 240) return res.status(400).json({ error: 'invalid_scan', message: 'A valid barcode and product name are required.' });
    try {
      const user = await upsertUser(req.user);
      const lastPrice = validPrice(req.body?.last_price) ? Number(req.body.last_price) : null;
      return res.status(201).json({ scan: await recordScan(user.id, { barcode, productName, lastPrice, scannedAt: req.body?.scanned_at }) });
    } catch (_error) { return res.status(503).json({ error: 'history_unavailable', message: 'Unable to save this scan.' }); }
  });

app.route('/users/favourites')
  .get(requireUser, async (req, res) => {
    try { const user = await upsertUser(req.user); return res.json({ favourites: await listFavourites(user.id) }); }
    catch (_error) { return res.status(503).json({ error: 'favourites_unavailable', message: 'Unable to load favourites.' }); }
  })
  .post(requireUser, async (req, res) => {
    const barcode = String(req.body?.barcode || '').replace(/\D/g, '');
    const productName = String(req.body?.product_name || '').trim();
    if (!validBarcode(barcode) || !productName || productName.length > 240) return res.status(400).json({ error: 'invalid_favourite', message: 'A valid product is required.' });
    try { const user = await upsertUser(req.user); return res.status(201).json({ favourite: await addFavourite(user.id, { barcode, productName }) }); }
    catch (_error) { return res.status(503).json({ error: 'favourites_unavailable', message: 'Unable to save favourite.' }); }
  })
  .delete(requireUser, async (req, res) => {
    const barcode = String(req.query.barcode || '').replace(/\D/g, '');
    if (!validBarcode(barcode)) return res.status(400).json({ error: 'invalid_barcode', message: 'A valid barcode is required.' });
    try { const user = await upsertUser(req.user); return res.json({ removed: await removeFavourite(user.id, barcode) }); }
    catch (_error) { return res.status(503).json({ error: 'favourites_unavailable', message: 'Unable to remove favourite.' }); }
  });

app.route('/users/alerts')
  .get(requireUser, async (req, res) => {
    try { const user = await upsertUser(req.user); return res.json({ alerts: await listAlerts(user.id) }); }
    catch (_error) { return res.status(503).json({ error: 'alerts_unavailable', message: 'Unable to load price alerts.' }); }
  })
  .post(requireUser, async (req, res) => {
    const barcode = String(req.body?.barcode || '').replace(/\D/g, '');
    if (!validBarcode(barcode) || !validPrice(req.body?.target_price)) return res.status(400).json({ error: 'invalid_alert', message: 'A valid barcode and target price are required.' });
    try {
      const user = await upsertUser(req.user);
      return res.status(201).json({ alert: await createAlert(user.id, { barcode, targetPrice: Number(req.body.target_price), email: user.email }) });
    } catch (_error) { return res.status(503).json({ error: 'alerts_unavailable', message: 'Unable to create price alert.' }); }
  })
  .delete(requireUser, async (req, res) => {
    const alertId = Number(req.query.id);
    if (!Number.isInteger(alertId) || alertId < 1) return res.status(400).json({ error: 'invalid_alert', message: 'A valid alert is required.' });
    try { const user = await upsertUser(req.user); return res.json({ removed: await deactivateAlert(user.id, alertId) }); }
    catch (_error) { return res.status(503).json({ error: 'alerts_unavailable', message: 'Unable to remove price alert.' }); }
  });

app.get('/admin/product-requests', async (req, res) => {
  const requiredToken = process.env.ADMIN_REFRESH_TOKEN;
  const providedToken = req.get('x-admin-refresh-token');
  if (!requiredToken || providedToken !== requiredToken) {
    return res.status(404).json({ error: 'not_found' });
  }

  const requestedLimit = Number(req.query.limit || 50);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  try {
    const requests = await listProductRequests(limit);
    return res.json({ requests });
  } catch (error) {
    console.error('[server] Unable to list product requests:', error);
    return res.status(503).json({ error: 'request_queue_unavailable', message: 'Unable to load the coverage queue right now' });
  }
});

app.post('/admin/refresh-all', async (_req, res) => {
  const requiredToken = process.env.ADMIN_REFRESH_TOKEN;
  const providedToken = _req.get('x-admin-refresh-token');
  if (!requiredToken || providedToken !== requiredToken) {
    return res.status(404).json({ error: 'not_found' });
  }
  const barcodes = await getAllTrackedBarcodes();
  (async () => {
    for (const barcode of barcodes) {
      try { await forceRefreshComparison(barcode); }
      catch (error) { console.error(`[admin] Refresh failed for ${barcode}: ${error.message}`); }
    }
  })();
  return res.status(202).json({ message: `Refresh triggered for ${barcodes.length} barcode(s)`, barcodes });
});

cron.schedule('0 */6 * * *', async () => {
  const barcodes = await getAllTrackedBarcodes();
  for (const barcode of barcodes) {
    try { await forceRefreshComparison(barcode); }
    catch (error) { console.error(`[cron] Refresh failed for ${barcode}: ${error.message}`); }
  }
  try {
    const result = await processPriceAlerts();
    console.log(`[cron] Price alerts processed: ${JSON.stringify(result)}`);
  } catch (error) {
    Sentry.captureException(error);
    console.error(`[cron] Price alert processing failed: ${error.message}`);
  }
});

if (nextApp) {
  app.use((req, res, nextMiddleware) => {
    if (!nextRequestHandler) return nextMiddleware();
    return Promise.resolve(nextRequestHandler(req, res)).catch(nextMiddleware);
  });
}

app.use((error, _req, res, _next) => {
  Sentry.captureException(error);
  if (error.message?.includes('Origin is not allowed')) return res.status(403).json({ error: 'origin_not_allowed', message: 'This website is not authorised to call the PriceCheck API.' });
  return res.status(500).json({ error: 'internal_error', message: 'PriceCheck encountered an unexpected error.' });
});

(async () => {
  try {
    await initSchema();
    if (nextApp) {
      await nextApp.prepare();
      nextRequestHandler = nextApp.getRequestHandler();
      console.log('[server] PriceCheck PWA is ready on the same public origin as the comparison API');
    }
    app.listen(PORT, () => console.log(`[server] PriceCheck backend listening on ${PORT}`));
  } catch (error) {
    console.error('[server] Failed to initialise database schema:', error);
    process.exit(1);
  }
})();

module.exports = app;
