import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

import { User } from '../models/User.js';
import { EmailOtp } from '../models/EmailOtp.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sendOtpEmail } from './email.service.js';

/**
 * Passwordless auth: email OTP and Google Sign-In. Both find-or-create the user
 * account, so a first-time visitor is onboarded on their first successful login.
 *
 * Session issuance (cookies) stays in the controller; this module owns the
 * business rules — code generation, verification limits, and identity linking.
 */

const googleClient = env.auth.google.enabled ? new OAuth2Client(env.auth.google.clientId) : null;

/** Derives a display name from an email local-part when none is provided. */
function nameFromEmail(email) {
  const local = String(email).split('@')[0] || 'user';
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1) || 'User';
}

/** Salted, peppered hash of an OTP code — the plaintext is never stored. */
function hashCode(email, code) {
  return crypto
    .createHmac('sha256', env.jwt.accessSecret)
    .update(`${String(email).toLowerCase()}:${code}`)
    .digest('hex');
}

function generateCode(length) {
  const max = 10 ** length;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, '0');
}

/**
 * Issues a fresh login code for `email` and emails it. Always resolves without
 * revealing whether the account exists; the account is created on verification.
 */
export async function requestEmailOtp(email) {
  const { length, ttlMinutes, resendCooldownSeconds } = env.auth.otp;

  // Per-email cooldown on top of the IP rate limiter.
  const recent = await EmailOtp.findOne({ email, consumedAt: null }).sort({ createdAt: -1 });
  if (recent && Date.now() - recent.lastSentAt.getTime() < resendCooldownSeconds * 1000) {
    const waitMs = resendCooldownSeconds * 1000 - (Date.now() - recent.lastSentAt.getTime());
    throw new AppError(429, `Please wait ${Math.ceil(waitMs / 1000)}s before requesting a new code.`, {
      code: 'OTP_COOLDOWN',
      details: { retryAfterSeconds: Math.ceil(waitMs / 1000) },
    });
  }

  const code = generateCode(length);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  // Invalidate any prior unconsumed codes so only the newest is valid.
  await EmailOtp.updateMany(
    { email, consumedAt: null },
    { $set: { consumedAt: new Date() } },
  );

  await EmailOtp.create({
    email,
    codeHash: hashCode(email, code),
    expiresAt,
    lastSentAt: new Date(),
  });

  try {
    await sendOtpEmail(email, code);
  } catch (err) {
    logger.error({ err, email }, 'Failed to send OTP email');
    throw new AppError(502, 'Could not send the verification email. Please try again shortly.', {
      code: 'EMAIL_SEND_FAILED',
    });
  }

  return { ok: true };
}

/**
 * Verifies a code and returns the (find-or-created) user. Enforces expiry and a
 * per-code attempt ceiling to make guessing a delivered code impractical.
 */
export async function verifyEmailOtp(email, code) {
  const invalid = () => AppError.unauthorized('Invalid or expired code');

  const record = await EmailOtp.findOne({ email, consumedAt: null }).sort({ createdAt: -1 });
  if (!record) throw invalid();

  if (record.expiresAt.getTime() < Date.now()) {
    await EmailOtp.updateOne({ _id: record._id }, { $set: { consumedAt: new Date() } });
    throw invalid();
  }

  if (record.attempts >= env.auth.otp.maxAttempts) {
    await EmailOtp.updateOne({ _id: record._id }, { $set: { consumedAt: new Date() } });
    throw AppError.tooMany('Too many incorrect attempts. Request a new code.');
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(record.codeHash, 'hex'),
    Buffer.from(hashCode(email, code), 'hex'),
  );

  if (!matches) {
    await EmailOtp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
    throw invalid();
  }

  await EmailOtp.updateOne({ _id: record._id }, { $set: { consumedAt: new Date() } });

  const user = await findOrCreateByEmail(email, { emailVerified: true });
  return user;
}

/**
 * Verifies a Google ID token and returns the linked (find-or-created) user.
 */
export async function loginWithGoogle(idToken) {
  if (!googleClient) {
    throw new AppError(503, 'Google Sign-In is not configured on this server.', {
      code: 'GOOGLE_NOT_CONFIGURED',
    });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.auth.google.clientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw AppError.unauthorized('Google sign-in failed. Please try again.');
  }

  if (!payload?.email || !payload.email_verified) {
    throw AppError.unauthorized('Your Google account email is not verified.');
  }

  const email = payload.email.toLowerCase();
  const googleId = payload.sub;

  // Prefer linking by googleId; fall back to email so an existing account is reused.
  let user = await User.findOne({ googleId, deletedAt: null });
  if (!user) {
    user = await User.findOne({ email, deletedAt: null });
  }

  if (!user) {
    user = new User({
      email,
      name: payload.name || nameFromEmail(email),
      avatarUrl: payload.picture || '',
      googleId,
      emailVerified: true,
    });
    await user.save();
  } else {
    // Backfill link/profile on an existing account without clobbering a set name.
    if (!user.googleId) user.googleId = googleId;
    if (!user.avatarUrl && payload.picture) user.avatarUrl = payload.picture;
    if (!user.emailVerified) user.emailVerified = true;
    user.lastLoginAt = new Date();
    await user.save();
  }

  return user;
}

async function findOrCreateByEmail(email, { emailVerified = false } = {}) {
  let user = await User.findOne({ email, deletedAt: null });
  if (!user) {
    user = new User({ email, name: nameFromEmail(email), emailVerified });
    await user.save();
    return user;
  }
  user.lastLoginAt = new Date();
  if (emailVerified && !user.emailVerified) user.emailVerified = true;
  await user.save();
  return user;
}

/** Bumps the refresh token version, invalidating all existing refresh tokens. */
export async function revokeAllSessions(userId) {
  await User.updateOne({ _id: userId }, { $inc: { refreshTokenVersion: 1 } });
}
