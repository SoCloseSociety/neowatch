import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isTV, prefersReducedMotion } from '@/lib/device';

// Two styles, both from Sentinel TV OS (charte.css): Lunaire (dark, the default)
// and Doux (light). The tokens live in index.css under `:root` and
// `:root[data-theme="doux"]`; this store only flips `data-theme`. TV is always
// Lunaire. There is no accent picker any more: the primary and the focus ring
// are bone white, mint means "OK" and red means "live", so a user colour could
// only break that meaning.
export type ThemeName = 'lunaire' | 'doux';

// `surface` is a swatch preview (RGB of --e-fond), kept so the Settings panel
// can draw a sample until Lot C redraws it.
export const THEMES: Record<ThemeName, { surface: [number, number, number]; themeColor: string }> = {
  lunaire: { surface: [5, 7, 10], themeColor: '#05070a' },
  doux: { surface: [243, 236, 223], themeColor: '#f3ecdf' },
};

/**
 * @deprecated The accent picker is gone (spec 1.4). Kept empty so the current
 * Settings panel still compiles and renders no swatch. Lot C removes the use.
 */
export const ACCENTS: Record<string, [number, number, number]> = {};

export type Density = 'comfortable' | 'compact' | 'cozy';

interface SettingsState {
  theme: ThemeName;
  /** @deprecated Ignored and never persisted (spec 1.4). Lot C removes the picker. */
  accent?: string;
  density: Density;
  defaultMuted: boolean;
  autoplay: boolean;
  reduceMotion: boolean;
  preferProxy: boolean; // force proxy for all playback (helps on locked networks)
  showOffline: boolean; // still render channels probed as offline
  set: (patch: Partial<SettingsState>) => void;
}

type Persisted = Omit<SettingsState, 'set' | 'accent'>;

function normalizeTheme(v: unknown): ThemeName {
  return v === 'doux' ? 'doux' : 'lunaire';
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'lunaire',
      density: 'comfortable',
      defaultMuted: true,
      autoplay: true,
      // First run follows the OS preference; the user's choice is persisted after.
      reduceMotion: prefersReducedMotion(),
      preferProxy: false,
      showOffline: true,
      set: (patch) => {
        const rest = { ...patch };
        delete rest.accent;
        if ('theme' in rest) rest.theme = normalizeTheme(rest.theme);
        set(rest);
      },
    }),
    {
      name: 'neowatch.settings',
      version: 2,
      // v0/v1 stored { accent, theme: midnight|black|slate|carbon, ... }.
      // Every old dark theme becomes Lunaire, the accent is dropped.
      migrate: (persisted) => {
        const s = { ...((persisted as Record<string, unknown>) || {}) };
        delete s.accent;
        s.theme = normalizeTheme(s.theme);
        // v1 defaulted reduceMotion to false without asking the OS: honour it now.
        if (!s.reduceMotion && prefersReducedMotion()) s.reduceMotion = true;
        return s as unknown as SettingsState;
      },
      // A stored value that slipped past migrate (hand-edited storage) still
      // cannot inject an unknown theme.
      merge: (persisted, current) => {
        const p = { ...((persisted as Record<string, unknown>) || {}) };
        delete p.accent;
        return { ...current, ...(p as Partial<SettingsState>), theme: normalizeTheme(p.theme ?? current.theme) };
      },
      partialize: (s): Persisted => ({
        theme: s.theme,
        density: s.density,
        defaultMuted: s.defaultMuted,
        autoplay: s.autoplay,
        reduceMotion: s.reduceMotion,
        preferProxy: s.preferProxy,
        showOffline: s.showOffline,
      }),
    }
  )
);

/** The theme actually shown: TV is always Lunaire. */
export function effectiveTheme(): ThemeName {
  return isTV() ? 'lunaire' : normalizeTheme(useSettings.getState().theme);
}

// Writes data attributes only. It must never set inline --tokens on <html>:
// an inline style would beat the token sheet (index.css) and the Doux block.
export function applyTheme() {
  if (typeof document === 'undefined') return;
  const { reduceMotion, density } = useSettings.getState();
  const theme = effectiveTheme();
  const root = document.documentElement;
  // Clean up the inline tokens a previous version of the app wrote.
  for (const p of ['--accent', '--surface', '--panel', '--ink']) root.style.removeProperty(p);
  root.dataset.theme = theme;
  root.dataset.density = density;
  root.dataset.motion = reduceMotion ? 'reduce' : 'full';
  root.classList.toggle('dark', theme === 'lunaire');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEMES[theme].themeColor);
}

// Re-apply whenever the relevant settings change.
useSettings.subscribe(applyTheme);
