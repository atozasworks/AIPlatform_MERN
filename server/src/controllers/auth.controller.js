import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../utils/AppError.js';
import { revokeAllSessions } from '../services/auth.service.js';
import { User } from '../models/User.js';
import {
  verifyRefreshToken,
  cookieOptions,
  clearLegacyHostOnlyAuthCookies,
  issueSessionCookies,
  COOKIE_NAMES,
} from '../utils/tokens.js';

function issueSession(res, user, maxAgeMs) {
  return issueSessionCookies(res, user, maxAgeMs);
}

function clearSession(res) {
  clearLegacyHostOnlyAuthCookies(res);
  res.clearCookie(COOKIE_NAMES.access, { ...cookieOptions('access'), maxAge: undefined });
  res.clearCookie(COOKIE_NAMES.refresh, { ...cookieOptions('refresh'), maxAge: undefined });
}

export const me = asyncHandler(async (req, res) => {
  const sessionExpiresAt = req.authExp ? req.authExp * 1000 : undefined;
  return sendSuccess(res, { user: req.user.toJSON(), sessionExpiresAt });
});

/**
 * Rotates tokens using the refresh cookie, validating the version claim.
 * Remaining lifetime is taken from the refresh token's `exp` so refresh cannot
 * slide the absolute session past the original login window.
 */
export const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.[COOKIE_NAMES.refresh];
  if (!token) throw AppError.unauthorized('No refresh token');

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    clearSession(res);
    throw AppError.unauthorized('Invalid refresh token');
  }
  if (payload.type !== 'refresh') throw AppError.unauthorized();

  const remainingMs = (payload.exp || 0) * 1000 - Date.now();
  if (remainingMs <= 0) {
    clearSession(res);
    throw AppError.unauthorized('Session expired, please log in again');
  }

  const user = await User.findOne({ _id: payload.sub, deletedAt: null });
  if (!user || user.refreshTokenVersion !== payload.ver) {
    clearSession(res);
    throw AppError.unauthorized('Session expired, please log in again');
  }

  const sessionExpiresAt = issueSession(res, user, remainingMs);
  return sendSuccess(res, { user: user.toJSON(), sessionExpiresAt });
});

export const logout = asyncHandler(async (_req, res) => {
  clearSession(res);
  return sendSuccess(res, { ok: true });
});

/** Logs out everywhere by invalidating all refresh tokens. */
export const logoutAll = asyncHandler(async (req, res) => {
  await revokeAllSessions(req.user._id);
  clearSession(res);
  return sendSuccess(res, { ok: true });
});
