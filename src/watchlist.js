'use strict';

const { randomUUID } = require('crypto');
const { rateLimit } = require('express-rate-limit');
const db = require('./db');
const { requireUser } = require('./userAuth');
const { forceRefreshComparison } = require('./priceService');
const { alertDeliveryReadiness, evaluatePriceAlerts } = require('./alerts');

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const WORKER_LOCK_NAMESPACE = 71001;
function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
function workerConfiguration() {
  return {
    workerConfigured: db.isDatabaseConfigured() && process.env.WATCHLIST_WORKER_ENABLED === 'true',
    databaseConfigured: db.isDatabaseConfigured(), scheduleHours: 6,
    batchLimit: boundedInteger(process.env.WATCHLIST_BATCH_LIMIT, 200, 1, 1000),
    maxRuntimeMs: boundedInteger(process.env.WATCHLIST_MAX_RUNTIME_MS, 1200000, 60000, 3600000),
    monitoringMessage: 'Scheduled checks require a deployed worker. Configuration alone does not prove that it has run successfully. Large watchlists rotate across runs.',
  };
}
async function watchlistReadiness() {
  return { ...workerConfiguration(), ...await db.getWatchlistRunStatus(), ...alertDeliveryReadiness() };
}
function sourceIsStale(result, now) {
  const stamp = result.updated_at ? new Date(result.updated_at).getTime() : NaN;
  return Boolean(result.stale) || !Number.isFinite(stamp) || stamp > now + 60000 || now - stamp > STALE_AFTER_MS;
}
function bestKnown(results, now) {
  const valid = db.cleanComparisonResults(results).filter((item) => item.available);
  const fresh = valid.filter((item) => !sourceIsStale(item, now));
  const sorted = (fresh.length ? fresh : valid).sort((a, b) => a.price - b.price);
  return sorted[0] ? { ...sorted[0], stale: sourceIsStale(sorted[0], now) } : null;
}
function watchlistItem(row, now = Date.now()) {
  const lastKnownBest = bestKnown(row.latest_prices, now);
  const latestBest = bestKnown(row.results, now);
  // A failed/unavailable check must not resurrect an old listing as available.
  const best = ['failed', 'unavailable'].includes(row.availability) ? null : latestBest ?? lastKnownBest;
  const availability = row.availability === 'failed' ? 'failed'
    : row.availability === 'unavailable' ? 'unavailable'
    : best ? 'available' : 'not_checked';
  return {
    barcode: row.barcode, product_name: row.display_name || row.product_name || `Barcode ${row.barcode}`,
    favourite: Boolean(row.favourite), availability,
    best, lastKnownBest, last_checked_at: row.last_checked_at ?? null,
    last_available_at: row.last_available_at ?? null,
    stale: !best || best.stale,
  };
}
function normaliseTrend(rows) {
  return rows.map((row) => ({
    checked_at: row.checked_at, best_price: row.best_price === null ? null : Number(row.best_price),
    checks: Number(row.checks), available_checks: Number(row.available_checks),
  }));
}

/** Finite work only, invoked by Render cron, never by a web-process timer.
 * Oldest attempted items rotate first even after failures. The queue reserves
 * 80% for favourites/active alerts and 20% for historical products when both
 * groups have enough items, with unused capacity available to either group.
 */
async function runWatchlistWorker({
  isConfigured = db.isDatabaseConfigured, lock = db.withDatabaseLock,
  candidates = db.getWatchlistCandidates, refresh = forceRefreshComparison,
  recordFailure = (barcode) => db.recordComparisonCheck(barcode, { results: [] }, { failed: true }),
  startRun = db.startWatchlistRun, updateRun = db.updateWatchlistRun,
  evaluate = evaluatePriceAlerts, now = Date.now, shouldStop = () => false,
  batchLimit = workerConfiguration().batchLimit, maxRuntimeMs = workerConfiguration().maxRuntimeMs,
  onProgress = (metrics) => console.log(`[watchlist] ${JSON.stringify(metrics)}`),
} = {}) {
  if (!isConfigured()) return { skipped: 'database_not_configured', checked: 0, sent: 0 };
  const outcome = await lock(WORKER_LOCK_NAMESPACE, 'six-hour-watchlist', async (ownership = { isHeld: () => true }) => {
    const runId = randomUUID();
    const began = now();
    const deadline = began + maxRuntimeMs;
    const metrics = { runId, selected: 0, watched: 0, historical: 0, checked: 0,
      available: 0, unavailable: 0, failed: 0, busy: 0, deferred: 0,
      alertsChecked: 0, sent: 0, deliveryFailed: 0, deliverySkipped: null, durationMs: 0 };
    const comparisons = new Map();
    const held = () => ownership.isHeld() && !shouldStop();
    await startRun(runId);
    try {
      const queue = await candidates(batchLimit);
      // Defense in depth in case a future query accidentally returns duplicates.
      const unique = [...new Map(queue.map((item) => [item.barcode, item])).values()];
      metrics.selected = unique.length;
      metrics.watched = unique.filter((item) => item.kind === 'watch').length;
      metrics.queueTotal = Number(unique[0]?.total_candidates ?? unique.length);
      metrics.watchedTotal = Number(unique[0]?.total_watched ?? metrics.watched);
      metrics.historical = unique.length - metrics.watched;
      onProgress({ ...metrics, phase: 'started' });
      // Leave enough budget for one full bounded comparison plus its DB writes.
      const perProductBudget = boundedInteger(process.env.RETAILER_TIMEOUT_MS, 15000, 1000, 45000) + 40000;
      for (const item of unique) {
        if (!held() || now() + perProductBudget >= deadline) break;
        try {
          const comparison = await refresh(item.barcode, {
            productHint: item.product_name ? { barcode: item.barcode, name: item.product_name } : null,
          });
          comparisons.set(item.barcode, comparison);
          metrics.checked += 1;
          if (comparison.results.some((result) => result.available && Number(result.price) > 0)) metrics.available += 1;
          else metrics.unavailable += 1;
        } catch (error) {
          if (error.code === 'REFRESH_IN_PROGRESS') metrics.busy += 1;
          else {
            metrics.failed += 1;
            // Recording failure moves the product to the back of fair rotation.
            await recordFailure(item.barcode);
          }
        }
        metrics.durationMs = now() - began;
        await updateRun(runId, metrics);
        onProgress({ ...metrics, phase: 'refreshing' });
      }
      metrics.deferred = metrics.selected - metrics.checked - metrics.failed;
      metrics.remaining = Math.max(0, metrics.queueTotal - metrics.checked - metrics.failed);
      const alerts = await evaluate(comparisons, { deadline, now, mayContinue: held });
      metrics.alertsChecked = alerts.checked;
      metrics.sent = alerts.sent;
      metrics.deliveryFailed = alerts.failed;
      metrics.deliverySkipped = alerts.skipped ?? null;
      metrics.alertsDeferred = Boolean(alerts.deferred);
      metrics.durationMs = now() - began;
      const state = metrics.failed || metrics.deferred || metrics.deliveryFailed || metrics.alertsDeferred || !held() ? 'partial' : 'complete';
      await updateRun(runId, metrics, state);
      onProgress({ ...metrics, state });
      return { ...metrics, state };
    } catch (error) {
      metrics.durationMs = now() - began;
      await updateRun(runId, metrics, 'failed').catch(() => {});
      throw error;
    }
  });
  return outcome.acquired ? outcome.result : { skipped: 'worker_already_running', checked: 0, sent: 0 };
}

function integrateWatchlist(app) {
  app.use('/users/watchlist', requireUser, (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  const refreshLimiter = rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (req) => String(req.user.accountId),
    message: { error: 'rate_limited', message: 'Too many watchlist refreshes. Please wait a minute.' },
  });
  const fail = (res, code = 503) => res.status(code).json({ error: 'watchlist_unavailable', message: 'Your watchlist is temporarily unavailable. Please try again.' });
  const ownedItem = async (req) => {
    const user = await db.upsertUser(req.user);
    const [item] = await db.getWatchlistItems(user.id, req.params.barcode);
    return { user, item };
  };
  const validBarcode = (req, res, next) => /^\d{8,14}$/.test(req.params.barcode)
    ? next() : res.status(400).json({ error: 'invalid_barcode', message: 'A barcode of 8 to 14 digits is required.' });
  app.get('/users/watchlist', async (req, res) => {
    try {
      const user = await db.upsertUser(req.user);
      return res.json({ items: (await db.getWatchlistItems(user.id)).map((row) => watchlistItem(row)), monitoring: await watchlistReadiness() });
    } catch (_error) { return fail(res); }
  });
  app.get('/users/watchlist/:barcode/trend', validBarcode, async (req, res) => {
    try {
      const { user, item } = await ownedItem(req);
      if (!item) return res.status(404).json({ error: 'not_found', message: 'Save this product to your favourites or alerts first.' });
      const days = boundedInteger(req.query.days, 30, 7, 90);
      return res.json({ barcode: item.barcode, days, points: normaliseTrend(await db.getWatchlistTrend(user.id, item.barcode, days)),
        description: 'Daily lowest price observed during completed checks. Gaps mean no available price was recorded.' });
    } catch (_error) { return fail(res); }
  });
  app.post('/users/watchlist/:barcode/refresh', validBarcode, refreshLimiter, async (req, res) => {
    try {
      const { user, item } = await ownedItem(req);
      if (!item) return res.status(404).json({ error: 'not_found', message: 'Save this product to your favourites or alerts first.' });
      if (item.last_checked_at && Date.now() - new Date(item.last_checked_at).getTime() < 60000) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'recently_checked', message: 'This product was checked less than a minute ago. Please wait before checking again.' });
      }
      await forceRefreshComparison(item.barcode, { productHint: { barcode: item.barcode, name: item.display_name || item.product_name } });
      const [updated] = await db.getWatchlistItems(user.id, item.barcode);
      return res.json({ item: watchlistItem(updated), monitoring: await watchlistReadiness() });
    } catch (error) {
      if (error.code === 'REFRESH_IN_PROGRESS') return res.status(409).json({ error: 'refresh_in_progress', message: error.message });
      return fail(res);
    }
  });
  // No current retailer price is required to set a target on a named favourite.
  app.post('/users/watchlist/:barcode/alert', validBarcode, async (req, res) => {
    const target = Number(req.body?.target_price);
    if (!Number.isFinite(target) || target <= 0 || target > 100000) return res.status(400).json({ error: 'invalid_target', message: 'Enter a target price between R0.01 and R100000.' });
    try {
      const { user, item } = await ownedItem(req);
      if (!item) return res.status(404).json({ error: 'not_found', message: 'Save this product to your favourites first.' });
      const alert = await db.createAlert(user.id, { barcode: item.barcode, targetPrice: target, email: user.email });
      return res.status(201).json({ alert, ...alertDeliveryReadiness(), monitoring: await watchlistReadiness() });
    } catch (_error) { return fail(res); }
  });
}
module.exports = { integrateWatchlist, runWatchlistWorker, workerConfiguration, watchlistReadiness,
  watchlistItem, normaliseTrend, boundedInteger, sourceIsStale, WORKER_LOCK_NAMESPACE };
