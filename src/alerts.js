'use strict';

const nodemailer = require('nodemailer');
const { getActiveAlerts, recordAlertSent } = require('./db');
const { forceRefreshComparison } = require('./priceService');

function mailEnabled() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_FROM);
}

function mailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function lowestAvailable(results) {
  return results.filter((result) => result.available && Number.isFinite(result.price)).sort((a, b) => a.price - b.price)[0] ?? null;
}

async function processPriceAlerts() {
  if (!mailEnabled()) return { sent: 0, skipped: 'mail_not_configured' };
  const transport = mailTransport();
  const alerts = await getActiveAlerts();
  let sent = 0;
  for (const alert of alerts) {
    try {
      const comparison = await forceRefreshComparison(alert.barcode);
      const best = lowestAvailable(comparison.results);
      if (!best || Number(best.price) > Number(alert.target_price)) continue;
      const recentlySentSamePrice = alert.last_sent_at && alert.last_sent_price !== null
        && Number(alert.last_sent_price) === Number(best.price)
        && Date.now() - new Date(alert.last_sent_at).getTime() < 24 * 60 * 60 * 1000;
      if (recentlySentSamePrice) continue;
      const productName = comparison.product?.name || `Barcode ${alert.barcode}`;
      const url = `${process.env.PRICECHECK_WEB_URL || 'https://pricecheck.app'}/result?barcode=${encodeURIComponent(alert.barcode)}`;
      await transport.sendMail({
        from: process.env.EMAIL_FROM,
        to: alert.email,
        subject: `PriceCheck alert: ${productName} is R${Number(best.price).toFixed(2)}`,
        text: `${productName} is now available at ${best.retailer} for R${Number(best.price).toFixed(2)}. Your target was R${Number(alert.target_price).toFixed(2)}. View the comparison: ${url}`,
      });
      await recordAlertSent(alert.id, Number(best.price));
      sent += 1;
    } catch (error) {
      console.error(`[alerts] Alert ${alert.id} failed: ${error.message}`);
    }
  }
  return { sent, checked: alerts.length };
}

module.exports = { processPriceAlerts, mailEnabled };
