import { create } from 'zustand';
import { api, setToken, getToken, adoptToken, claims, onTokenChanged, onAuthLost, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useCatalog } from '@/store/catalogStore';
import { usePrefs } from '@/store/prefsStore';
import type { RuntimeConfig, User } from '@/types';

interface AuthState {
  user: User | null;
  config: RuntimeConfig | null;
  ready: boolean;
  /** A token is held and GET /auth/me has not answered yet (boot, or retrying). Render a spinner, not the sign-in wall. */
  authPending: boolean;
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
// /api/config gets the same backoff (WEB-10): booting during a deploy must not leave
// the app without its config (REQUIRE_AUTH gate, billing switch) until a reload.
let configTimer: ReturnType<typeof setTimeout> | null = null;
let configCount = 0;
// WEB-11: at most one "are we still signed in?" check per 10 s, however many calls 401.
let lastLostCheck = 0;

type MeResponse = { user: User; token?: string };

// Everything that belongs to the account that just left this device (WEB-23 auth part):
// the account's favorites and history, its watch preferences. playerStore (the mosaic)
// listens to `user` turning null on its own.
function clearAccountData() {
  useCatalog.getState().clearAccountData();
  usePrefs.getState().reset();
}

// Hand the account's roaming favorites to the catalog store (union with local, never overwrite).
function adoptAccount(user: User) {
  useCatalog.getState().syncFavorites(user.id, Array.isArray(user.favorites) ? user.favorites : []);
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  config: null,
  ready: false,
  authPending: false,
  error: null,

  init: async () => {
    const config = await loadConfig();
    if (config) set({ config });
    else scheduleConfigRetry((c) => set({ config: c }));
    // Resolve the account (or schedule the retry) BEFORE the app renders, so the catalog
    // is loaded once, for the right user.
    await get().refresh();
    set({ ready: true });
  },

  login: async (email, password) => {
    set({ error: null });
    try {
      const r = await api.post<{ token: string; user: User }>('/auth/login', { email, password });
      cancelRetry();
      setToken(r.token);
      set({ user: r.user, authPending: false });
      adoptAccount(r.user);
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : t('auth.loginFailed') });
      throw e;
    }
  },

  register: async (email, password, name) => {
    set({ error: null });
    try {
      const r = await api.post<{ token: string; user: User }>('/auth/register', { email, password, name });
      cancelRetry();
      setToken(r.token);
      set({ user: r.user, authPending: false });
      adoptAccount(r.user);
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : t('auth.registerFailed') });
      throw e;
    }
  },

  // Used by the QR / device-pairing flow: the TV receives a ready-made token.
  loginWithToken: (token: string, user: User) => {
    cancelRetry();
    setToken(token);
    set({ user, error: null, authPending: false });
    adoptAccount(user);
  },

  logout: () => {
    cancelRetry();
    setToken(null);
    set({ user: null, authPending: false });
    clearAccountData();
  },

  // (Re)load the account behind the stored token. Also used at init, by the retry, by
  // another tab's sign-in, and when a call shows the server no longer knows us.
  refresh: async () => {
    const sent = getToken();
    if (!sent) {
      if (get().authPending) set({ authPending: false });
      return;
    }
    if (!get().user) set({ authPending: true });
    try {
      const r = await api.get<MeResponse>('/auth/me');
      const now = getToken();
      if (!now || (now !== sent && claims(now)?.sub !== claims(sent)?.sub)) {
        // Signed out or switched account while /auth/me was in flight (another tab):
        // that change runs its own refresh, this answer is for a session that is gone.
        return;
      }
      // The body carries the renewed token when the X-Renewed-Token header did not make
      // it through (a proxy that strips unknown headers); same guard as the header path.
      adoptToken(r.token);
      cancelRetry();
      const prevId = get().user?.id;
      set({ user: r.user, authPending: false });
      if (prevId !== r.user.id) adoptAccount(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (getToken() !== sent) return; // a newer session is already in place
        cancelRetry();
        setToken(null);
        const hadUser = !!get().user;
        set({ user: null, authPending: false });
        if (hadUser) clearAccountData();
        return;
      }
      scheduleRetry(() => void get().refresh());
    }
  },

  isAdmin: () => get().user?.role === 'admin',
  isPremium: () => !!get().user?.premium,
}));

// WEB-25 (audit WEB-22): another tab signed out, signed in, or switched account. The
// token in memory already followed localStorage (api.ts); make the signed-in user follow.
onTokenChanged((next) => {
  const s = useAuth.getState();
  if (!next) {
    cancelRetry();
    if (s.user || s.authPending) {
      useAuth.setState({ user: null, authPending: false });
      clearAccountData();
    }
    return;
  }
  const sub = claims(next)?.sub;
  if (s.user && sub && sub === s.user.id) return; // same account (a renewal): nothing to do
  if (s.user) {
    // Another account now owns this browser: drop the previous one's data before loading.
    useAuth.setState({ user: null });
    clearAccountData();
  }
  cancelRetry();
  void s.refresh();
});

// WEB-11: a user route answered "authentication required" although we sent a token:
// the session was revoked or expired elsewhere. Confirm with /auth/me, which alone may
// sign this device out (on its 401).
onAuthLost(() => {
  const now = Date.now();
  if (now - lastLostCheck < 10_000) return;
  lastLostCheck = now;
  if (getToken()) void useAuth.getState().refresh();
});

async function loadConfig(): Promise<RuntimeConfig | null> {
  try {
    return await api.get<RuntimeConfig>('/config');
  } catch {
    return null; // server may be warming up: retried with backoff
  }
}

function scheduleConfigRetry(done: (c: RuntimeConfig) => void) {
  if (configTimer) return;
  const delay = RETRY_DELAYS_MS[Math.min(configCount, RETRY_DELAYS_MS.length - 1)];
  configCount++;
  configTimer = setTimeout(async () => {
    configTimer = null;
    const c = await loadConfig();
    if (c) {
      configCount = 0;
      done(c);
    } else scheduleConfigRetry(done);
  }, delay);
}

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
