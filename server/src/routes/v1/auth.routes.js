import { Router } from 'express';

// App-owned modules are imported first so the app's `User` model is registered
// before atozas-auth-kit-express resolves `mongoose.model('User')` (it reuses an
// already-registered model, keeping a single shared `users` collection).
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { bridgeKitSession } from '../../middleware/authBridge.js';
import { env } from '../../config/env.js';
import { sendOtpEmail } from '../../services/email.service.js';
import * as authController from '../../controllers/auth.controller.js';
import '../../models/User.js';

import { createAuthRouter } from 'atozas-auth-kit-express';

const router = Router();

/**
 * Hybrid authentication.
 *
 * Credential verification (Google Sign-In + email OTP) is delegated to
 * atozas-auth-kit-express. On success, `bridgeKitSession` issues the app's
 * httpOnly access/refresh cookies so the rest of the platform (SSE streaming,
 * Socket.IO, admin role checks) keeps using its existing cookie session.
 *
 * The session-lifecycle endpoints below stay app-owned and are registered
 * before the kit router, so they take precedence over the kit's own
 * `/me`, `/refresh`, and `/logout` handlers.
 */
router.get('/me', requireAuth, authController.me);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/logout-all', requireAuth, authController.logoutAll);

const kitRouter = createAuthRouter({
  googleClientId: env.auth.google.clientId,
  // Reuse the app's JWT secrets/TTLs; the kit's tokens are unused post-bridge,
  // but sharing config keeps behaviour consistent.
  jwtSecret: env.jwt.accessSecret,
  jwtRefreshSecret: env.jwt.refreshSecret,
  accessTokenExpiry: env.jwt.accessTtl,
  refreshTokenExpiry: env.jwt.refreshTtl,
  otpExpiry: env.auth.otp.ttlMinutes,
  otpLength: env.auth.otp.length,
  otpRateLimit: { maxAttempts: env.rateLimit.authMax, windowMs: env.rateLimit.windowMs },
  // Match the app's refresh-cookie path so the app's cookie (set last by the
  // bridge) overwrites the kit's rather than creating a duplicate.
  cookieOptions: {
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    domain: env.cookie.domain,
    path: '/api/v1/auth',
  },
  // Delivery is the app's existing SMTP service (dev logs the code).
  sendEmailOtp: async (to, otp) => {
    await sendOtpEmail(to, otp);
  },
});

// Handles POST /google, POST /email/send-otp, POST /email/verify-otp.
router.use(authLimiter, bridgeKitSession, kitRouter);

export default router;
