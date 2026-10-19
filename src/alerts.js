'use strict';

const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { getActiveAlerts, isDatabaseConfigured, recordAlertSent } = require('./db');
const { forceRefreshComparison } = require('./priceService');

function resendEnabled() {
  return Boolean(process.env.RESEND_API_KEY && (process.env.ALERT_FROM_EMAIL || process.env.EMAIL_FROM));
}

function smtpEnabled() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && (process.env.ALERT_FROM_EMAIL || process.env.EMAIL_FROM));
}

function mailEnabled() {
  return resendEnabled() || smtpEnabled();
}

function alertDeliveryReadiness() {
  if (mailEnabled()) return { deliveryEnabled: true };
  return {
    deliveryEnabled: false,
    deliveryMessage: 'Price alert saved, but email delivery is not configured. Add RESEND_API_KEY and ALERT_FROM_EMAIL, or SMTP settings, to enable email alerts.',
  };
}

function alertFromEmail() {
  return process.env.ALERT_FROM_EMAIL || process.env.EMAIL_FROM;
}

function mailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendAlertEmail(message, transport = null) {
  if (resendEnabled()) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({ from: alertFromEmail(), ...message });
    if (result?.error) throw new Error(result.error.message || 'Resend rejected the alert email');
    return result;
  }
  return (transport || mailTransport()).sendMail({ from: alertFromEmail(), ...message });
}

function lowestAvailable(results) {
  return results.filter((result) => result.available && Number.isFinite(result.price)).sort((a, b) => a.price - b.price)[0] ?? null;
}

async function processPriceAlerts() {
  if (!isDatabaseConfigured()) return { sent: 0, skipped: 'database_not_configured' };
  if (!mailEnabled()) return { sent: 0, skipped: 'mail_not_configured' };
  const transport = resendEnabled() ? null : mailTransport();
  const alerts = await getActiveAlerts();
  let sent = 0;
  for (const alert of alerts) {
    try {
      const comparison = await forceRefreshComparison(alert.barcode);
      const best = lowestAvailable(comparison.results);
      // The product language is "drops below" the target, not at-or-below.
      if (!best || Number(best.price) >= Number(alert.target_price)) continue;
      const recentlySentSamePrice = alert.last_sent_at && alert.last_sent_price !== null
        && Number(alert.last_sent_price) === Number(best.price)
        && Date.now() - new Date(alert.last_sent_at).getTime() < 24 * 60 * 60 * 1000;
      if (recentlySentSamePrice) continue;
      const productName = comparison.product?.name || `Barcode ${alert.barcode}`;
      const url = `${process.env.PRICECHECK_WEB_URL || 'https://pricecheck.app'}/result?barcode=${encodeURIComponent(alert.barcode)}`;
      await sendAlertEmail({
        to: alert.email,
        subject: `PriceCheck alert: ${productName} is R${Number(best.price).toFixed(2)}`,
        text: `${productName} is now available at ${best.retailer} for R${Number(best.price).toFixed(2)}. Your target was R${Number(alert.target_price).toFixed(2)}. View the comparison: ${url}`,
      }, transport);
      await recordAlertSent(alert.id, Number(best.price));
      sent += 1;
    } catch (error) {
      console.error(`[alerts] Alert ${alert.id} failed: ${error.message}`);
    }
  }
  return { sent, checked: alerts.length, delivery: resendEnabled() ? 'resend' : 'smtp' };
}

module.exports = { alertDeliveryReadiness, alertFromEmail, mailEnabled, processPriceAlerts, resendEnabled, sendAlertEmail, smtpEnabled };
