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

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: EMPTY,
  loaded: false,

  load: async () => {
    try {
      const r = await api.get<{ prefs: WatchPrefs | null }>('/me/prefs');
      set({ prefs: { ...EMPTY, ...(r.prefs || {}), home: { ...EMPTY.home, ...(r.prefs?.home || {}) } }, loaded: true });
    } catch {
      set({ prefs: EMPTY, loaded: true });
    }
  },

  // Persist (premium only server-side; 402 for free users -> revert + false).
  save: async (patch) => {
    const previous = get().prefs;
    const prefs = { ...previous, ...patch };
    set({ prefs });
    try {
      await api.put('/me/prefs', { prefs });
      return true;
    } catch {
      set({ prefs: previous }); // not premium / not logged in -> roll back
      return false;
    }
  },

  toggleHidden: (cat) => {
    const h = get().prefs.hiddenCategories;
    const hiddenCategories = h.includes(cat) ? h.filter((c) => c !== cat) : [...h, cat];
    get().save({ hiddenCategories });
  },

  togglePinned: (cat) => {
    const p = get().prefs.pinnedCategories;
    const pinnedCategories = p.includes(cat) ? p.filter((c) => c !== cat) : [...p, cat];
    get().save({ pinnedCategories });
  },

  setHome: (patch) => {
    get().save({ home: { ...get().prefs.home, ...patch } });
  },

  reset: () => set({ prefs: EMPTY, loaded: false }),
}));
