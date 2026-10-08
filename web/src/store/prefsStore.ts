import { create } from 'zustand';
import { api } from '@/lib/api';

export interface WatchPrefs {
  hiddenCategories: string[];
  pinnedCategories: string[];
  home: { category: string | null; country: string | null; language: string | null; foot: boolean };
}

const EMPTY: WatchPrefs = {
  hiddenCategories: [],
  pinnedCategories: [],
  home: { category: null, country: null, language: null, foot: false },
};

interface PrefsState {
  prefs: WatchPrefs;
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<WatchPrefs>) => Promise<boolean>;
  toggleHidden: (cat: string) => void;
  togglePinned: (cat: string) => void;
  setHome: (patch: Partial<WatchPrefs['home']>) => void;
  reset: () => void;
}

// WEB-21: saves are serialized. Every toggle applies at once (optimistic) and joins
// the next PUT, which always carries the latest full prefs; only one PUT is in flight.
// On failure the store reloads the server's copy instead of restoring a snapshot, so a
// late failure never erases a later toggle that the server did accept.
let inFlight = false;
let waiters: ((ok: boolean) => void)[] = [];

const normalize = (p: Partial<WatchPrefs> | null | undefined): WatchPrefs => ({
  ...EMPTY,
  ...(p || {}),
  home: { ...EMPTY.home, ...(p?.home || {}) },
});

export const usePrefs = create<PrefsState>((set, get) => {
  const flush = () => {
    if (inFlight || !waiters.length) return;
    inFlight = true;
    const batch = waiters;
    waiters = [];
    api
      .put('/me/prefs', { prefs: get().prefs })
      .then(() => true, () => false)
      .then(async (ok) => {
        // A newer save is already queued: it sends the latest prefs, its outcome decides.
        if (!ok && !waiters.length) await get().load();
        inFlight = false;
        batch.forEach((r) => r(ok));
        flush();
      });
  };

  return {
    prefs: EMPTY,
    loaded: false,

    load: async () => {
      try {
        const r = await api.get<{ prefs: WatchPrefs | null }>('/me/prefs');
        set({ prefs: normalize(r.prefs), loaded: true });
      } catch {
        set({ prefs: EMPTY, loaded: true });
      }
    },

    // Persist (premium only server-side: a 402 for free users resolves false and the
    // server's copy comes back).
    save: (patch) => {
      set({ prefs: { ...get().prefs, ...patch } });
      return new Promise<boolean>((resolve) => {
        waiters.push(resolve);
        flush();
      });
    },

    toggleHidden: (cat) => {
      const h = get().prefs.hiddenCategories;
      const hiddenCategories = h.includes(cat) ? h.filter((c) => c !== cat) : [...h, cat];
      void get().save({ hiddenCategories });
    },

    togglePinned: (cat) => {
      const p = get().prefs.pinnedCategories;
      const pinnedCategories = p.includes(cat) ? p.filter((c) => c !== cat) : [...p, cat];
      void get().save({ pinnedCategories });
    },

    setHome: (patch) => {
      void get().save({ home: { ...get().prefs.home, ...patch } });
    },

    reset: () => set({ prefs: EMPTY, loaded: false }),
  };
});
