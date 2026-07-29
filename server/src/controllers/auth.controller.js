import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { AppError } from '../utils/AppError.js';
import { registerUser, verifyCredentials, revokeAllSessions } from '../services/auth.service.js';
import { User } from '../models/User.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  cookieOptions,
  COOKIE_NAMES,
} from '../utils/tokens.js';

function issueSession(res, user) {
  res.cookie(COOKIE_NAMES.access, signAccessToken(user), cookieOptions('access'));
  res.cookie(COOKIE_NAMES.refresh, signRefreshToken(user), cookieOptions('refresh'));
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAMES.access, { ...cookieOptions('access'), maxAge: undefined });
  res.clearCookie(COOKIE_NAMES.refresh, { ...cookieOptions('refresh'), maxAge: undefined });
}

export const register = asyncHandler(async (req, res) => {
  const user = await registerUser(req.body);
  issueSession(res, user);
  return sendSuccess(res, { user: user.toJSON() }, { status: 201 });
});

export const login = asyncHandler(async (req, res) => {
  const user = await verifyCredentials(req.body);
  issueSession(res, user);
  return sendSuccess(res, { user: user.toJSON() });
});

export const me = asyncHandler(async (req, res) => {
  return sendSuccess(res, { user: req.user.toJSON() });
});

/** Rotates tokens using the refresh cookie, validating the version claim. */
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

  const user = await User.findOne({ _id: payload.sub, deletedAt: null });
  if (!user || user.refreshTokenVersion !== payload.ver) {
    clearSession(res);
    throw AppError.unauthorized('Session expired, please log in again');
  }

  issueSession(res, user);
  return sendSuccess(res, { user: user.toJSON() });
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
