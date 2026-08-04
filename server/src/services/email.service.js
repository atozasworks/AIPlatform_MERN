import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Transactional email via SMTP (Gmail by default).
 *
 * The transport is created lazily and reused. When email is disabled or SMTP
 * credentials are missing, sends become no-ops and callers rely on the
 * development console fallback — the API never fails a login just because a
 * mailbox is misconfigured in a dev environment.
 */
let transporter = null;

function isConfigured() {
  return Boolean(env.email.enabled && env.email.user && env.email.pass);
}

function getTransport() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.secure,
      auth: { user: env.email.user, pass: env.email.pass },
    });
  }
  return transporter;
}

/**
 * Sends a login OTP code. Returns `{ delivered }` — false means the code was
 * only logged (dev fallback), true means it was handed to the SMTP server.
 */
export async function sendOtpEmail(to, code) {
  const transport = getTransport();

  if (!transport) {
    // Development / unconfigured fallback: surface the code in logs only.
    if (env.isProd) {
      logger.error(
        { to },
        'OTP requested but email is not configured (EMAIL_ENABLED + SMTP_USER/SMTP_PASS). Code not delivered.',
      );
    } else {
      logger.info({ to, code }, `[DEV] OTP email disabled — login code for ${to}: ${code}`);
    }
    return { delivered: false };
  }

  const ttl = env.auth.otp.ttlMinutes;
  await transport.sendMail({
    from: env.email.from,
    to,
    subject: `Your ATOZAS AI login code: ${code}`,
    text: `Your ATOZAS AI verification code is ${code}. It expires in ${ttl} minutes.\n\nIf you did not request this, you can safely ignore this email.`,
    html: otpHtml(code, ttl),
  });

  return { delivered: true };
}

/**
 * Emails the unique reference code generated when a user marks a message
 * private. Returns `{ delivered }` — false means it was only logged (dev
 * fallback). This is a receipt, not a secret gate, so a delivery failure never
 * blocks the request that triggered it.
 */
export async function sendPrivateCodeEmail(to, { code, conversationId, messageId, preview } = {}) {
  const transport = getTransport();

  if (!transport) {
    if (env.isProd) {
      logger.error({ to }, 'Private message code generated but email is not configured. Code not delivered.');
    } else {
      logger.info({ to, code }, `[DEV] Private message code for ${to}: ${code}`);
    }
    return { delivered: false };
  }

  await transport.sendMail({
    from: env.email.from,
    to,
    subject: `Your ATOZAS AI private message code: ${code}`,
    text:
      `You marked a message as private on ATOZAS AI.\n\n` +
      `Reference code: ${code}\n` +
      (conversationId ? `Conversation: ${conversationId}\n` : '') +
      (messageId ? `Message: ${messageId}\n` : '') +
      (preview ? `\nMessage preview:\n"${preview}"\n` : '') +
      `\nKeep this code for your records.`,
    html: privateCodeHtml({ code, preview }),
  });

  return { delivered: true };
}

function privateCodeHtml({ code, preview }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 8px;font-size:20px">Your private message code</h2>
    <p style="margin:0 0 20px;color:#475569">You marked a message as private on ATOZAS AI. Keep this reference code for your records.</p>
    <div style="font-size:28px;font-weight:700;letter-spacing:4px;background:#f1f5f9;border-radius:12px;padding:16px 0;text-align:center">${code}</div>
    ${preview ? `<p style="margin:20px 0 0;color:#64748b;font-size:13px">Message preview: “${preview}”</p>` : ''}
  </div>`;
}

function otpHtml(code, ttlMinutes) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 8px;font-size:20px">Sign in to ATOZAS AI</h2>
    <p style="margin:0 0 20px;color:#475569">Use this verification code to finish signing in.</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px 0;text-align:center">${code}</div>
    <p style="margin:20px 0 0;color:#64748b;font-size:13px">This code expires in ${ttlMinutes} minutes. If you didn't request it, you can ignore this email.</p>
  </div>`;
}

export default { sendOtpEmail, sendPrivateCodeEmail };
