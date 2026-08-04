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
    } catch {
      set({ user: null, status: 'anonymous' });
    }
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
    await api.post('/auth/logout').catch(() => {});
    set({ user: null, status: 'anonymous' });
  },
}));

export default useAuth;
