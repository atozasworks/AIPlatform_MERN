import { User } from '../models/User.js';
import { logger } from '../config/logger.js';
import {
  signAccessToken,
  signRefreshToken,
  cookieOptions,
  clearLegacyHostOnlyAuthCookies,
  COOKIE_NAMES,
} from '../utils/tokens.js';

/**
 * Bridges `atozas-auth-kit-express` logins into the app's own httpOnly-cookie
 * session (hybrid auth).
 *
 * The kit verifies the Google credential / email OTP and responds with
 * `{ success, accessToken, user }`, setting only its own bearer/refresh scheme.
 * The rest of this app authenticates from the `accessToken` cookie — SSE
 * streaming, Socket.IO, and role checks all read it — so we intercept the kit's
 * success response, load the app `User` it just found/created (shared `users`
 * collection), and issue the app's access + refresh cookies. The kit's own
 * refresh cookie (same name, same path via config) is overwritten here.
 *
 * The response body is left intact so the React kit's `login()` still works.
 */
export function bridgeKitSession(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const email = body?.success && body?.user?.email ? String(body.user.email).toLowerCase() : null;

    // Only bridge successful logins (they carry a token); pass everything else
    // (send-otp, logout, errors) straight through untouched.
    if (!email || !body.accessToken || res.statusCode >= 400) {
      return originalJson(body);
    }

    User.findOne({ email, deletedAt: null })
      .then((user) => {
        if (!user) return originalJson(body);
        user.lastLoginAt = new Date();
        return user.save().then(() => {
          clearLegacyHostOnlyAuthCookies(res);
          res.cookie(COOKIE_NAMES.access, signAccessToken(user), cookieOptions('access'));
          res.cookie(COOKIE_NAMES.refresh, signRefreshToken(user), cookieOptions('refresh'));
          // Return the app's user shape so /auth/me and this response agree.
          return originalJson({ ...body, user: user.toJSON() });
        });
      })
      .catch((err) => {
        logger.error({ err, email }, 'Failed to bridge auth-kit login into cookie session');
        return originalJson(body);
      });

    return res;
  };

  next();
}

export default bridgeKitSession;
