'use strict';

const { randomUUID } = require('crypto');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { getActiveAlerts, claimAlertDelivery, completeAlertDelivery } = require('./db');

const EMAIL_TIMEOUT_MS = 20000;
const EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function resendEnabled() {
  return Boolean(process.env.RESEND_API_KEY && (process.env.ALERT_FROM_EMAIL || process.env.EMAIL_FROM));
}
function smtpEnabled() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && (process.env.ALERT_FROM_EMAIL || process.env.EMAIL_FROM));
}
function mailEnabled() { return resendEnabled() || smtpEnabled(); }
function alertDeliveryReadiness() {
  return mailEnabled()
    ? { deliveryEnabled: true, deliveryStatus: 'configured_unverified', deliveryMessage: 'Email settings are configured. Delivery has not been verified by saving this alert.' }
    : { deliveryEnabled: false, deliveryStatus: 'unconfigured', deliveryMessage: 'Price alert saved, but email delivery is not configured. Price checks do not depend on email settings.' };
}
function alertFromEmail() { return process.env.ALERT_FROM_EMAIL || process.env.EMAIL_FROM; }
function mailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: EMAIL_TIMEOUT_MS,
  });
}
async function sendAlertEmail(message, transport = null, { idempotencyKey } = {}) {
  if (resendEnabled()) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({ from: alertFromEmail(), ...message }, {
      idempotencyKey, signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
    if (result?.error) throw new Error(result.error.message || 'Email provider rejected the alert email');
    return result;
  }
  return (transport || mailTransport()).sendMail({ from: alertFromEmail(), ...message });
}
function lowestAvailable(results) {
  return (Array.isArray(results) ? results : [])
    .filter((result) => result.available === true && !result.stale && result.price !== null
      && Number.isFinite(Number(result.price)) && Number(result.price) > 0
      && isRecentSource(result))
    .sort((a, b) => Number(a.price) - Number(b.price))[0] ?? null;
}
function isRecentSource(result) {
  const stamp = result.updated_at ?? result.updatedAt ?? result.scraped_at;
  const time = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isFinite(time) && time <= Date.now() + 60000 && Date.now() - time <= 6 * 60 * 60 * 1000;
}
function shouldNotify(alert, best, now = Date.now()) {
  if (!alert.active || !best || !best.available || best.stale || !isRecentSource(best)
    || !Number.isFinite(Number(best.price)) || Number(best.price) <= 0
    || Number(best.price) >= Number(alert.target_price)) return false;
  if (!Number.isFinite(Number(alert.target_price)) || Number(alert.target_price) <= 0) return false;
  const samePrice = alert.last_sent_price !== null && alert.last_sent_price !== undefined
    && Number(alert.last_sent_price) === Number(best.price);
  const sentTime = alert.last_sent_at ? new Date(alert.last_sent_at).getTime() : NaN;
  return !(samePrice && Number.isFinite(sentTime) && now - sentTime < EMAIL_COOLDOWN_MS);
}
function comparisonUrl(barcode) {
  const configured = process.env.TROLLEYWISE_WEB_URL || process.env.PRICECHECK_WEB_URL;
  try {
    const base = new URL(configured);
    if (!['http:', 'https:'].includes(base.protocol)) return null;
    return new URL(`/result?barcode=${encodeURIComponent(barcode)}`, base).href;
  } catch (_error) { return null; }
}

/** No scraper calls here: the worker supplies exactly one comparison per EAN.
 * Keyset pagination traverses beyond 500 recipients without OFFSET starvation.
 * Dependency injection makes the complete flow testable with no network or DB.
 */
async function evaluatePriceAlerts(comparisons, {
  loadPage = getActiveAlerts, claim = claimAlertDelivery, complete = completeAlertDelivery,
  send = sendAlertEmail, enabled = mailEnabled(), deadline = Infinity, now = Date.now,
  mayContinue = () => true, pageSize = 250,
} = {}) {
  const metrics = { checked: 0, sent: 0, suppressed: 0, failed: 0, deferred: false };
  if (!enabled) return { ...metrics, skipped: 'mail_not_configured' };
  const barcodes = [...comparisons.keys()];
  if (!barcodes.length) return metrics;
  let afterId = 0;
  while (mayContinue() && now() < deadline) {
    const page = await loadPage({ afterId, limit: pageSize, barcodes });
    if (!page.length) break;
    for (const alert of page) {
      if (!mayContinue() || now() + EMAIL_TIMEOUT_MS >= deadline) { metrics.deferred = true; return metrics; }
      afterId = Math.max(afterId, Number(alert.id));
      metrics.checked += 1;
      const comparison = comparisons.get(alert.barcode);
      const best = lowestAvailable(comparison?.results);
      if (!shouldNotify(alert, best, now())) continue;
      const token = randomUUID();
      try {
        const ownedClaim = await claim(alert, Number(best.price), token);
        if (!ownedClaim) { metrics.suppressed += 1; continue; }
        if (!mayContinue()) { metrics.deferred = true; return metrics; }
        const name = comparison.product?.name || `Barcode ${alert.barcode}`;
        const url = comparisonUrl(alert.barcode);
        let timer;
        try {
          await Promise.race([
            send({
              to: alert.email, subject: `TrolleyWise alert: ${name} is R${Number(best.price).toFixed(2)}`,
              text: `${name} was checked at ${best.retailer} for R${Number(best.price).toFixed(2)}, below your R${Number(alert.target_price).toFixed(2)} target. Prices can change.${url ? ` View the comparison: ${url}` : ''}`,
            }, null, { idempotencyKey: `watchlist-${token}` }),
            new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Email attempt timed out')), EMAIL_TIMEOUT_MS); }),
          ]);
        } finally { clearTimeout(timer); }
        await complete(alert, Number(best.price), token, true);
        metrics.sent += 1;
      } catch (_error) {
        // A timed-out provider may have accepted the email. Preserve the claim
        // as uncertain rather than retrying and potentially sending twice.
        await complete(alert, Number(best.price), token, false).catch(() => {});
        metrics.failed += 1;
        console.error(`[alerts] Delivery attempt failed for alert ${alert.id}`);
      }
    }
    if (page.length < pageSize) break;
  }
  if (!mayContinue() || now() >= deadline) metrics.deferred = true;
  return metrics;
}

// Compatibility entry point now shares the independent worker and its DB lock.
// The old web-server cron must be removed instead of scheduling this as well.
async function processPriceAlerts(options) {
  const { runWatchlistWorker } = require('./watchlist');
  return runWatchlistWorker(options);
}
module.exports = {
  alertDeliveryReadiness, alertFromEmail, mailEnabled, processPriceAlerts,
  resendEnabled, sendAlertEmail, smtpEnabled, lowestAvailable, shouldNotify, evaluatePriceAlerts,
};
