import { create } from 'zustand';
import { api, setToken, getToken, adoptToken, ApiError } from '@/lib/api';
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

// GET /auth/me is the call every app start makes (web, TV). Only a 401 means "this
// session is over" (expired, revoked, account disabled or gone). Anything else -- the
// server restarting behind nginx (502), the TV booting before its Wi-Fi is up, a timeout --
// is a bad moment, not a bad token: keep the token and try again a little later, with a
// growing delay, so a TV never has to be re-paired because it was switched on during a deploy.
const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

type MeResponse = { user: User; token?: string };

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
    // Resolve the account (or schedule the retry) BEFORE the app renders, so the catalog
    // is loaded once, for the right user.
    await get().refresh();
    set({ config, ready: true });
  },

  login: async (email, password) => {
    set({ error: null });
    try {
      const r = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
      cancelRetry();
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
      cancelRetry();
      setToken(r.token);
      set({ user: r.user });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Inscription impossible' });
      throw e;
    }
  },

  // Used by the QR / device-pairing flow: the TV receives a ready-made token.
  loginWithToken: (token: string, user: User) => {
    cancelRetry();
    setToken(token);
    set({ user, error: null });
  },

  logout: () => {
    cancelRetry();
    setToken(null);
    set({ user: null });
  },

  // (Re)load the account behind the stored token. Also used at init and by the retry.
  refresh: async () => {
    if (!getToken()) return;
    try {
      const r = await api.get<MeResponse>('/auth/me');
      // The body carries the renewed token when the X-Renewed-Token header did not make
      // it through (a proxy that strips unknown headers); same guard as the header path.
      adoptToken(r.token);
      cancelRetry();
      set({ user: r.user });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        cancelRetry();
        setToken(null);
        set({ user: null });
        return;
      }
      scheduleRetry(() => void get().refresh());
    }
  },

  isAdmin: () => get().user?.role === 'admin',
  isPremium: () => !!get().user?.premium,
}));

function scheduleRetry(fn: () => void) {
  if (retryTimer) return;
  const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  retryCount++;
  retryTimer = setTimeout(() => { retryTimer = null; fn(); }, delay);
}
function cancelRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryCount = 0;
}
