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
