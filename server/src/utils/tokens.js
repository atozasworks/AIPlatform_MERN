import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Access + refresh token helpers.
 * Refresh tokens embed a `ver` claim compared against the user's
 * `refreshTokenVersion` so we can invalidate all sessions on demand
 * ("log out from all devices").
 */
export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), roles: user.roles, type: 'access' },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTtl },
  );
}

export function signRefreshToken(user) {
  return jwt.sign(
    { sub: String(user._id), ver: user.refreshTokenVersion, type: 'refresh' },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshTtl },
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

function ttlToMs(ttl) {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 15 * 60 * 1000;
  const n = Number(match[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return n * unit;
}

export function cookieOptions(kind) {
  const maxAge = ttlToMs(kind === 'refresh' ? env.jwt.refreshTtl : env.jwt.accessTtl);
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    domain: env.cookie.domain,
    path: kind === 'refresh' ? '/api/v1/auth' : '/',
    maxAge,
  };
}

function hostOnlyCookieOptions(kind) {
  const { domain, ...options } = cookieOptions(kind);
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
