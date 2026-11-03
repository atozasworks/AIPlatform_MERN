import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const GUEST_COOKIE = 'guest_sid';

const GUEST_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function guestCookieOptions() {
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    domain: env.cookie.domain,
    path: '/',
    maxAge: GUEST_TTL_MS,
  };
}

/**
 * Ensures every visitor has a stable anonymous id in an httpOnly cookie.
 * Ownership of guest chat sessions is keyed on this id — not IP.
 */
export function ensureGuestId(req, res, next) {
  let guestId = req.cookies?.[GUEST_COOKIE];
  if (!guestId || !/^[a-f0-9-]{36}$/i.test(guestId)) {
    guestId = crypto.randomUUID();
    res.cookie(GUEST_COOKIE, guestId, guestCookieOptions());
  }
  req.guestId = guestId;
  next();
}

export default ensureGuestId;
