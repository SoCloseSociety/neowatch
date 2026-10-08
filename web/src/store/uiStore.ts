import { create } from 'zustand';

export interface Toast {
  id: number;
  /** One sentence, at most 8 words (spec 2.10). Already translated. */
  text: string;
  /** Mint check before the text (a confirmed state: "Premium is on."). */
  ok?: boolean;
  /** Shows an "Undo" action when the action is reversible. */
  undo?: () => void;
}

export interface ToastOptions {
  ok?: boolean;
  undo?: () => void;
  /** Visible time in ms (default 2600). */
  ms?: number;
}

export const TOAST_MS = 2600;

interface UIState {
  settingsOpen: boolean;
  loginOpen: boolean;
  pricingOpen: boolean;
  prefsOpen: boolean;
  accountOpen: boolean;
  installOpen: boolean;
  /** Avatar menu in the top bar (Lot B AvatarMenu.tsx). */
  avatarOpen: boolean;
  /** `data-key` (stream url) of the card that launched the player, for focus restore on Back. */
  lastFocusKey: string | null;
  toasts: Toast[];
  homeVersion: number;
  bumpHome: () => void;
  setSettings: (v: boolean) => void;
  setLogin: (v: boolean) => void;
  setPricing: (v: boolean) => void;
  setPrefs: (v: boolean) => void;
  setAccount: (v: boolean) => void;
  setInstall: (v: boolean) => void;
  setAvatar: (v: boolean) => void;
  setLastFocusKey: (key: string | null) => void;
  /** Show a toast; returns its id. One at a time: a new toast replaces the current one. */
  toast: (text: string, opts?: ToastOptions) => number;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useUI = create<UIState>((set, get) => ({
  settingsOpen: false,
  loginOpen: false,
  pricingOpen: false,
  prefsOpen: false,
  accountOpen: false,
  installOpen: false,
  avatarOpen: false,
  lastFocusKey: null,
  toasts: [],
  homeVersion: 0,
  bumpHome: () => set({ homeVersion: get().homeVersion + 1 }),
  setSettings: (v) => set({ settingsOpen: v }),
  setLogin: (v) => set({ loginOpen: v }),
  setPricing: (v) => set({ pricingOpen: v }),
  setPrefs: (v) => set({ prefsOpen: v }),
  setAccount: (v) => set({ accountOpen: v }),
  setInstall: (v) => set({ installOpen: v }),
  setAvatar: (v) => set({ avatarOpen: v }),
  setLastFocusKey: (key) => set({ lastFocusKey: key }),
  toast: (text, opts = {}) => {
    const id = ++toastSeq;
    for (const t of toastTimers.values()) clearTimeout(t);
    toastTimers.clear();
    set({ toasts: [{ id, text, ok: opts.ok, undo: opts.undo }] });
    toastTimers.set(id, setTimeout(() => get().dismissToast(id), opts.ms ?? TOAST_MS));
    return id;
  },
  dismissToast: (id) => {
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Non-hook shortcut for stores and event handlers: `toast(t('toast.addedList'), { undo })`. */
export function toast(text: string, opts?: ToastOptions): number {
  return useUI.getState().toast(text, opts);
}
