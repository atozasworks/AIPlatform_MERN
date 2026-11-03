import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Access + refresh token helpers.
 * Refresh tokens embed a `ver` claim compared against the user's
 * `refreshTokenVersion` so we can invalidate all sessions on demand
 * ("log out from all devices").
 */
export function signAccessToken(user, { expiresIn = env.jwt.accessTtl } = {}) {
  return jwt.sign(
    { sub: String(user._id), roles: user.roles, type: 'access' },
    env.jwt.accessSecret,
    { expiresIn },
  );
}

export function signRefreshToken(user, { expiresIn = env.jwt.refreshTtl } = {}) {
  return jwt.sign(
    { sub: String(user._id), ver: user.refreshTokenVersion, type: 'refresh' },
    env.jwt.refreshSecret,
    { expiresIn },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

export const COOKIE_NAMES = {
  access: 'accessToken',
  refresh: 'refreshToken',
};

/** Parses jwt `expiresIn` strings like `15m` / `1h` / `30d` into milliseconds. */
export function ttlToMs(ttl) {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return n * unit;
}

/**
 * Absolute app-session lifetime (ms). Access and refresh share this window so
 * a login lasts exactly this long — refresh cannot slide the session forward.
 */
export function sessionTtlMs() {
  return Math.min(ttlToMs(env.jwt.accessTtl), ttlToMs(env.jwt.refreshTtl));
}

export function cookieOptions(kind, maxAgeMs) {
  const maxAge =
    maxAgeMs ?? ttlToMs(kind === 'refresh' ? env.jwt.refreshTtl : env.jwt.accessTtl);
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    domain: env.cookie.domain,
    path: kind === 'refresh' ? '/api/v1/auth' : '/',
    maxAge,
  };
}

function hostOnlyCookieOptions(kind, maxAgeMs) {
  const { domain, ...options } = cookieOptions(kind, maxAgeMs);
  return options;
}

/**
 * Clears pre-migration host-only cookies before re-issuing the domain-scoped
 * variants. Chromium can keep both copies and send the stale host-only value
 * first, which makes cookie-parser read the wrong session after a rollout from
 * `www.atozasai.com` host-only cookies to `.atozasai.com` cookies.
 */
export function clearLegacyHostOnlyAuthCookies(res) {
  res.clearCookie(COOKIE_NAMES.access, { ...hostOnlyCookieOptions('access'), maxAge: undefined });
  res.clearCookie(COOKIE_NAMES.refresh, { ...hostOnlyCookieOptions('refresh'), maxAge: undefined });
}

/**
 * Issues access + refresh cookies that both expire after `maxAgeMs` (absolute
 * remaining session window). Defaults to the configured session TTL.
 * @returns {number} epoch ms when the session expires
 */
export function issueSessionCookies(res, user, maxAgeMs = sessionTtlMs()) {
  const ms = Math.max(1000, Math.floor(maxAgeMs));
  const expiresIn = `${Math.ceil(ms / 1000)}s`;
  clearLegacyHostOnlyAuthCookies(res);
  res.cookie(COOKIE_NAMES.access, signAccessToken(user, { expiresIn }), cookieOptions('access', ms));
  res.cookie(COOKIE_NAMES.refresh, signRefreshToken(user, { expiresIn }), cookieOptions('refresh', ms));
  return Date.now() + ms;
}
