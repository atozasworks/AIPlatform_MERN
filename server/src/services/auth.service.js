import { User } from '../models/User.js';
import { AppError } from '../utils/AppError.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/**
 * Auth business logic: registration, credential verification with brute-force
 * lockout, and session invalidation. Controllers stay thin and handle only
 * HTTP concerns (cookies, status codes).
 */
export async function registerUser({ name, email, password }) {
  const existing = await User.findOne({ email });
  if (existing) throw AppError.conflict('An account with that email already exists');

  const user = new User({ name, email });
  await user.setPassword(password);
  await user.save();
  return user;
}

export async function verifyCredentials({ email, password }) {
  const user = await User.findOne({ email, deletedAt: null }).select('+passwordHash');
  // Uniform error avoids leaking which accounts exist (§16, §21).
  const invalid = () => AppError.unauthorized('Invalid email or password');

  if (!user) throw invalid();
  if (user.isLocked()) {
    throw AppError.tooMany('Account temporarily locked due to failed logins. Try again later.');
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    user.failedLoginCount = (user.failedLoginCount || 0) + 1;
    if (user.failedLoginCount >= MAX_FAILED) {
      user.lockUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.failedLoginCount = 0;
    }
    await user.save();
    throw invalid();
  }

  user.failedLoginCount = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();
  return user;
}

/** Bumps the refresh token version, invalidating all existing refresh tokens. */
export async function revokeAllSessions(userId) {
  await User.updateOne({ _id: userId }, { $inc: { refreshTokenVersion: 1 } });
}
