import { Router } from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/AppError.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { User } from '../models/User.js';
import { OidcFlow } from '../models/OidcFlow.js';
import { loginWithAtozas } from '../services/auth.service.js';
import {
  signAccessToken,
  signRefreshToken,
  cookieOptions,
  clearLegacyHostOnlyAuthCookies,
  COOKIE_NAMES,
} from '../utils/tokens.js';
import * as oidc from '../services/atozasOidc.js';

/**
 * ATOZAS Cross-Domain SSO — OIDC relying-party routes, mounted at `/auth`
 * (root, not `/api/v1`) so they own the provider redirect URI
 * `/auth/atozas/callback` and sit before the SPA catch-all.
 *
 * Existing Email-OTP / Google / password / JWT auth is untouched: when
 * `ATOZAS_SSO_ENABLED=false` only the harmless `/auth/atozas/status` probe and
 * the app-cookie `/auth/logout` are mounted; every OIDC endpoint 404s.
 *
 * Server-only secrets — client_secret, the authorization code, the PKCE
 * verifier and provider tokens — never reach the browser and are never logged.
 *
 * OIDC `state` / PKCE verifier are stored in Mongo (`OidcFlow`) keyed by
 * `state`, not only in the express-session cookie. Chromium often drops the
 * session cookie across the cross-site IdP redirect; looking up by `state`
 * keeps Chrome/Edge/Firefox on the same successful path.
 */
const cfg = env.atozas;
const router = Router();

const SESSION_MAX_AGE_MS = Math.max(1, cfg.session.maxAgeDays) * 24 * 60 * 60 * 1000;
/** Abandoned authorize→callback flows expire quickly (Mongo TTL also cleans them). */
const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;

/** Issues the app's normal JWT cookie session for `user` (same as password/OTP/Google). */
function issueAppSession(res, user) {
  clearLegacyHostOnlyAuthCookies(res);
  res.cookie(COOKIE_NAMES.access, signAccessToken(user), cookieOptions('access'));
  res.cookie(COOKIE_NAMES.refresh, signRefreshToken(user), cookieOptions('refresh'));
}

function clearAppSession(res) {
  clearLegacyHostOnlyAuthCookies(res);
  res.clearCookie(COOKIE_NAMES.access, { ...cookieOptions('access'), maxAge: undefined });
  res.clearCookie(COOKIE_NAMES.refresh, { ...cookieOptions('refresh'), maxAge: undefined });
}

/**
 * Whitelists `returnTo` to a same-site absolute path, defeating open-redirects.
 * Rejects protocol-relative (`//host`), scheme (`https:`), backslash and
 * non-path values, and never lets the user bounce back into the SSO entrypoint.
 */
function safeReturnTo(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) return '/';
  if (raw.startsWith('/auth/')) return '/';
  return raw;
}

// When SSO is enabled, attach the MongoDB-backed session to EVERY /auth route
// (registered first so `/logout`, `/atozas/*` and the callback all see it).
// Reuses the app's MONGO_URI — no duplicate database configuration.
if (cfg.enabled) {
  const sessionMiddleware = session({
    name: cfg.session.cookieName,
    secret: cfg.session.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: MongoStore.create({
      mongoUrl: env.mongoUri,
      collectionName: cfg.session.collection,
      ttl: Math.floor(SESSION_MAX_AGE_MS / 1000),
    }),
    cookie: {
      httpOnly: true,
      secure: cfg.session.cookieSecure,
      sameSite: cfg.session.cookieSameSite,
      domain: env.cookie.domain,
      maxAge: SESSION_MAX_AGE_MS,
      // Wider than `/auth` so restore + logout still see the cookie even if a
      // proxy rewrites paths; callback is under `/auth` either way.
      path: '/',
    },
  });
  router.use(sessionMiddleware);
}

// ── Public status probe (always mounted; exposes no secrets) ──────────────────
router.get('/atozas/status', (_req, res) => {
  res.json({ success: true, data: { enabled: cfg.enabled, autoRedirect: cfg.autoRedirect } });
});

/**
 * Root logout. Always clears the app's JWT cookies; additionally tears down the
 * ATOZAS SSO session (and best-effort revokes the provider token) when present.
 * Works even while SSO is disabled so a stale session can still be cleared.
 */
router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    clearAppSession(res);

    const sess = req.session;
    if (sess) {
      const providerToken = sess.atozas?.accessToken;
      if (providerToken) oidc.revokeToken(providerToken).catch(() => {}); // fire-and-forget
      await new Promise((resolve) => sess.destroy(() => resolve()));
      res.clearCookie(cfg.session.cookieName, {
        path: '/',
        domain: env.cookie.domain,
      });
      // Also clear pre-migration Path=/auth copies if any remain.
      res.clearCookie(cfg.session.cookieName, {
        path: '/auth',
        domain: env.cookie.domain,
      });
      res.clearCookie(cfg.session.cookieName, { path: '/auth' });
      res.clearCookie(cfg.session.cookieName, { path: '/' });
    }

    res.json({ success: true, data: { ok: true } });
  }),
);

// ── OIDC endpoints — only when SSO is enabled ─────────────────────────────────
if (cfg.enabled) {
  // GET /auth/atozas — begin Authorization Code + PKCE (S256).
  router.get(
    '/atozas',
    authLimiter,
    asyncHandler(async (req, res) => {
      const state = oidc.createState();
      const nonce = oidc.createNonce();
      const { verifier, challenge } = oidc.createPkce();
      const returnTo = safeReturnTo(req.query.returnTo);
      const createdAt = Date.now();

      // Durable flow record: callback looks this up by `state` even when the
      // browser drops the SSO session cookie (Chrome/Edge cross-site quirk).
      await OidcFlow.findOneAndUpdate(
        { state },
        {
          state,
          nonce,
          verifier,
          returnTo,
          expiresAt: new Date(createdAt + OIDC_FLOW_TTL_MS),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      // Best-effort mirror into the session for same-browser restores / logout.
      if (req.session) {
        req.session.oidc = { state, nonce, verifier, returnTo, createdAt };
      }

      const authorizeUrl = await oidc.buildAuthorizeUrl({ state, codeChallenge: challenge, nonce });

      const redirect = () => res.redirect(authorizeUrl);
      if (req.session) {
        req.session.save((err) => {
          if (err) {
            logger.error({ err: err?.message }, 'ATOZAS: failed to persist login session');
            // Flow is already in Mongo; still proceed to the IdP.
          }
          return redirect();
        });
        return;
      }
      return redirect();
    }),
  );

  // GET /auth/atozas/callback — validate state, exchange code, find/create user.
  router.get(
    '/atozas/callback',
    asyncHandler(async (req, res) => {
      const { code, state, error: providerError } = req.query;

      if (providerError) {
        logger.warn({ error: String(providerError) }, 'ATOZAS returned an authorization error');
        return res.redirect('/login?sso_error=denied');
      }
      if (!state || !code) return res.redirect('/login?sso_error=code');

      // Prefer the durable Mongo flow (Chrome-safe). Fall back to session for
      // any in-flight sessions created before this deploy.
      let flow = null;
      const stored = await OidcFlow.findOneAndDelete({ state: String(state) });
      if (stored) {
        if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
          return res.redirect('/login?sso_error=state');
        }
        flow = {
          state: stored.state,
          nonce: stored.nonce,
          verifier: stored.verifier,
          returnTo: stored.returnTo,
        };
      } else {
        const sessionFlow = req.session?.oidc;
        if (sessionFlow && String(state) === sessionFlow.state) {
          flow = sessionFlow;
          delete req.session.oidc;
        }
      }

      if (!flow || String(state) !== flow.state) {
        return res.redirect('/login?sso_error=state');
      }

      const returnTo = safeReturnTo(flow.returnTo);

      let user;
      let tokenSet;
      try {
        tokenSet = await oidc.exchangeCode({ code: String(code), codeVerifier: flow.verifier });
        const userinfo = await oidc.fetchUserInfo(tokenSet.access_token);
        user = await loginWithAtozas(userinfo);
      } catch (err) {
        logger.warn({ err: err?.message, code: err?.code }, 'ATOZAS callback failed');
        return res.redirect('/login?sso_error=exchange');
      }

      // Issue the app's normal JWT session and remember the SSO binding so
      // /auth/atozas/me can restore the session later. Provider tokens stay in
      // the server-side session store only (never sent to the client).
      issueAppSession(res, user);
      if (req.session) {
        req.session.userId = String(user._id);
        req.session.email = user.email;
        req.session.atozas = { accessToken: tokenSet.access_token, at: Date.now() };
        delete req.session.oidc;
      }

      // 200 HTML + same-origin JS hop (not a 302). Mobile Safari/Chrome ITP
      // treats a cross-site 302 as bounce-tracking and drops Set-Cookie;
      // a document response on this origin keeps the session cookies.
      const finish = () => {
        res.set('Cache-Control', 'no-store');
        res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="same-origin">
  <meta http-equiv="refresh" content="0;url=${returnTo}">
  <title>Signing you in…</title>
</head>
<body>
  <p>Signing you in…</p>
  <script>location.replace(${JSON.stringify(returnTo)});</script>
  <p><a href="${returnTo}">Continue</a></p>
</body>
</html>`);
      };
      if (req.session) {
        req.session.save((err) => {
          if (err) logger.error({ err: err?.message }, 'ATOZAS: failed to persist session post-login');
          return finish();
        });
        return;
      }
      return finish();
    }),
  );

  // GET /auth/atozas/me — restore the app JWT session from an existing ATOZAS session.
  router.get(
    '/atozas/me',
    asyncHandler(async (req, res) => {
      const userId = req.session?.userId;
      if (!userId) throw AppError.unauthorized('No ATOZAS session');

      const user = await User.findOne({ _id: userId, deletedAt: null });
      if (!user) {
        // The account vanished; drop the stale SSO session.
        await new Promise((resolve) => req.session.destroy(() => resolve()));
        throw AppError.unauthorized('Account no longer exists');
      }

      // Re-mint fresh app cookies so a signed-in ATOZAS user stays logged in
      // even after the short-lived access cookie expires.
      issueAppSession(res, user);
      res.json({ success: true, data: { user: user.toJSON() } });
    }),
  );
}

export default router;
