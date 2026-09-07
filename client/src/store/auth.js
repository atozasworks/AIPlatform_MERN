import { create } from 'zustand';
import { api } from '../lib/api.js';

/**
 * Authentication state. The source of truth is the HTTP-only cookie on the
 * server; this store caches the current user for the UI and exposes actions.
 */
export const useAuth = create((set) => ({
  user: null,
  status: 'loading', // 'loading' | 'authenticated' | 'anonymous'

  async bootstrap() {
    try {
      const { user } = await api.get('/auth/me');
      set({ user, status: 'authenticated' });
      return;
    } catch {
      // App JWT session absent/expired — fall through to an ATOZAS SSO restore.
    }
    // If an ATOZAS SSO session exists, this re-mints the app's JWT cookies and
    // returns the user. Returns 401 (or 404 when SSO is disabled) otherwise, so
    // existing non-SSO deployments simply land as anonymous.
    try {
      const res = await fetch('/auth/atozas/me', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const user = body?.data?.user;
        if (user) {
          set({ user, status: 'authenticated' });
          return;
        }
      }
    } catch {
      /* ignore — treat as anonymous */
    }
    set({ user: null, status: 'anonymous' });
  },

  /** Request a one-time login code by email. */
  async requestOtp(email) {
    return api.post('/auth/otp/request', { email });
  },

  /** Verify an emailed code and establish a session. */
  async verifyOtp(email, code) {
    const { user } = await api.post('/auth/otp/verify', { email, code });
    set({ user, status: 'authenticated' });
    return user;
  },

  /** Exchange a Google ID token (credential) for a session. */
  async loginWithGoogle(credential) {
    const { user } = await api.post('/auth/google', { credential });
    set({ user, status: 'authenticated' });
    return user;
  },

  async logout() {
    // Clear the app's JWT cookie session (existing behaviour).
    await api.post('/auth/logout').catch(() => {});
    // Also tear down any ATOZAS SSO session so /auth/atozas/me can't restore it.
    // No-op for non-SSO deployments (endpoint clears cookies unconditionally).
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).catch(() => {});
    set({ user: null, status: 'anonymous' });
  },
}));

export default useAuth;
