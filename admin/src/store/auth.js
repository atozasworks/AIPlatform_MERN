import { create } from 'zustand';
import { api } from '../api.js';

/**
 * Admin authentication state. The source of truth is the httpOnly session
 * cookie; this store caches the current admin for the UI.
 */
export const useAuth = create((set) => ({
  user: null,
  status: 'loading', // 'loading' | 'authenticated' | 'anonymous'

  async bootstrap() {
    try {
      const { user } = await api.get('/admin/me');
      set({ user, status: 'authenticated' });
    } catch {
      set({ user: null, status: 'anonymous' });
    }
  },

  async login(email, password) {
    const { user } = await api.post('/admin/login', { email, password });
    set({ user, status: 'authenticated' });
    return user;
  },

  async logout() {
    await api.post('/admin/logout').catch(() => {});
    set({ user: null, status: 'anonymous' });
  },
}));

export default useAuth;
