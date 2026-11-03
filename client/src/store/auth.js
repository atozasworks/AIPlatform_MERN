import { create } from 'zustand';
import { api } from '../lib/api.js';

/**
 * Authentication state. The source of truth is the HTTP-only cookie on the
 * server; this store caches the current user for the UI and exposes actions.
 *
 * Absolute session: the server issues access+refresh cookies that share one
 * fixed expiry (default 1h). This store arms a timer from `sessionExpiresAt`
 * so the UI logs out at that moment — never earlier.
 */
let sessionTimer = null;

function clearSessionTimer() {
  if (sessionTimer != null) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }
}

/** Fallback when the server omits sessionExpiresAt (older responses). */
const DEFAULT_SESSION_MS = 60 * 60 * 1000;

function armSessionTimer(sessionExpiresAt, logout) {
  clearSessionTimer();
  const endsAt = Number(sessionExpiresAt) || Date.now() + DEFAULT_SESSION_MS;
  const delay = Math.max(0, endsAt - Date.now());
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    logout();
  }, delay);
}

export const useAuth = create((set, get) => ({
  user: null,
  status: 'loading', // 'loading' | 'authenticated' | 'anonymous'
  sessionExpiresAt: null,

  _becomeAuthenticated(user, sessionExpiresAt) {
    const endsAt = Number(sessionExpiresAt) || Date.now() + DEFAULT_SESSION_MS;
    set({ user, status: 'authenticated', sessionExpiresAt: endsAt });
    armSessionTimer(endsAt, () => get().logout());
  },

  async bootstrap() {
    try {
      const { user, sessionExpiresAt } = await api.get('/auth/me');
      get()._becomeAuthenticated(user, sessionExpiresAt);
      return;
    } catch {
      // App JWT session absent/expired — fall through to an ATOZAS SSO restore.
    }
    // If an ATOZAS SSO session exists, this re-mints the app's JWT cookies for
    // the *remaining* absolute window only. Returns 401 once that window ends.
    try {
      const res = await fetch('/auth/atozas/me', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const user = body?.data?.user;
        if (user) {
          get()._becomeAuthenticated(user, body?.data?.sessionExpiresAt);
          return;
        }
      }
    } catch {
      /* ignore — treat as anonymous */
    }
    clearSessionTimer();
    set({ user: null, status: 'anonymous', sessionExpiresAt: null });
  },

  /** Request a one-time login code by email. */
  async requestOtp(email) {
    return api.post('/auth/otp/request', { email });
  },

  /** Verify an emailed code and establish a session. */
  async verifyOtp(email, code) {
    const data = await api.post('/auth/otp/verify', { email, code });
    get()._becomeAuthenticated(data.user, data.sessionExpiresAt);
    return data.user;
  },

  /** Exchange a Google ID token (credential) for a session. */
  async loginWithGoogle(credential) {
    const data = await api.post('/auth/google', { credential });
    get()._becomeAuthenticated(data.user, data.sessionExpiresAt);
    return data.user;
  },

  async logout() {
    clearSessionTimer();
    // Clear the app's JWT cookie session (existing behaviour).
    await api.post('/auth/logout').catch(() => {});
    // Also tear down any ATOZAS SSO session so /auth/atozas/me can't restore it.
    // No-op for non-SSO deployments (endpoint clears cookies unconditionally).
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).catch(() => {});
    set({ user: null, status: 'anonymous', sessionExpiresAt: null });
    if (typeof window !== 'undefined') {
      window.location.assign('/login');
    }
  },
}));

export default useAuth;
