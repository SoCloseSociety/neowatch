import { create } from 'zustand';

interface UIState {
  settingsOpen: boolean;
  loginOpen: boolean;
  pricingOpen: boolean;
  prefsOpen: boolean;
  accountOpen: boolean;
  installOpen: boolean;
  homeVersion: number;
  bumpHome: () => void;
  setSettings: (v: boolean) => void;
  setLogin: (v: boolean) => void;
  setPricing: (v: boolean) => void;
  setPrefs: (v: boolean) => void;
  setAccount: (v: boolean) => void;
  setInstall: (v: boolean) => void;
}

export const useUI = create<UIState>((set, get) => ({
  settingsOpen: false,
  loginOpen: false,
  pricingOpen: false,
  prefsOpen: false,
  accountOpen: false,
  installOpen: false,
  homeVersion: 0,
  bumpHome: () => set({ homeVersion: get().homeVersion + 1 }),
  setSettings: (v) => set({ settingsOpen: v }),
  setLogin: (v) => set({ loginOpen: v }),
  setPricing: (v) => set({ pricingOpen: v }),
  setPrefs: (v) => set({ prefsOpen: v }),
  setAccount: (v) => set({ accountOpen: v }),
  setInstall: (v) => set({ installOpen: v }),
}));
