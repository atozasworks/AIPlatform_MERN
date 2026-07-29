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

  async login(email, password) {
    const { user } = await api.post('/auth/login', { email, password });
    set({ user, status: 'authenticated' });
    return user;
  },

  async register(name, email, password) {
    const { user } = await api.post('/auth/register', { name, email, password });
    set({ user, status: 'authenticated' });
    return user;
  },

  async logout() {
    await api.post('/auth/logout').catch(() => {});
    set({ user: null, status: 'anonymous' });
  },
}));

export default useAuth;
