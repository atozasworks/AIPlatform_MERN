import { verifyAccessToken, COOKIE_NAMES } from '../utils/tokens.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { User } from '../models/User.js';

/**
 * Authenticates the request from the access-token cookie (primary) or a Bearer
 * header (for API clients). Loads the user and attaches it to req.user.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw AppError.unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw AppError.unauthorized('Invalid or expired session');
  }
  if (payload.type !== 'access') throw AppError.unauthorized();

  const user = await User.findOne({ _id: payload.sub, deletedAt: null });
  if (!user) throw AppError.unauthorized('Account no longer exists');

  req.user = user;
  next();
});

/** Requires the authenticated user to have one of the given roles. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    const ok = req.user.roles?.some((r) => roles.includes(r));
    if (!ok) return next(AppError.forbidden('Insufficient permissions'));
    next();
  };
}

function extractToken(req) {
  const cookieToken = req.cookies?.[COOKIE_NAMES.access];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export default requireAuth;
