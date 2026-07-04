import { create } from 'zustand';
import { api, setToken, getToken, ApiError } from '@/lib/api';
import type { RuntimeConfig, User } from '@/types';

interface AuthState {
  user: User | null;
  config: RuntimeConfig | null;
  ready: boolean;
  error: string | null;
  init: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  loginWithToken: (token: string, user: User) => void;
  logout: () => void;
  refresh: () => Promise<void>;
  isAdmin: () => boolean;
  isPremium: () => boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  config: null,
  ready: false,
  error: null,

  init: async () => {
    let config: RuntimeConfig | null = null;
    try {
      config = await api.get<RuntimeConfig>('/config');
    } catch {
      /* server may be warming up */
    }
    let user: User | null = null;
    if (getToken()) {
      try {
        const r = await api.get<{ user: User }>('/auth/me');
        user = r.user;
      } catch {
        setToken(null);
      }
    }
    set({ config, user, ready: true });
  },

  login: async (email, password) => {
    set({ error: null });
    try {
      const r = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
      setToken(r.token);
      set({ user: r.user });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Connexion impossible' });
      throw e;
    }
  },

  register: async (email, password, name) => {
    set({ error: null });
    try {
      const r = await api.post<{ token: string; user: User }>('/auth/register', { email, password, name });
      setToken(r.token);
      set({ user: r.user });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Inscription impossible' });
      throw e;
    }
  },

  // Used by the QR / device-pairing flow: the TV receives a ready-made token.
  loginWithToken: (token: string, user: User) => {
    setToken(token);
    set({ user, error: null });
  },

  logout: () => {
    setToken(null);
    set({ user: null });
  },

  refresh: async () => {
    if (!getToken()) return;
    try {
      const r = await api.get<{ user: User }>('/auth/me');
      set({ user: r.user });
    } catch {
      /* keep current */
    }
  },

  isAdmin: () => get().user?.role === 'admin',
  isPremium: () => !!get().user?.premium,
}));
