import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Accent presets — RGB triplets applied to the --accent CSS variable.
export const ACCENTS: Record<string, [number, number, number]> = {
  cyan: [34, 211, 238],
  blue: [59, 130, 246],
  violet: [139, 92, 246],
  emerald: [16, 185, 129],
  amber: [245, 158, 11],
  rose: [244, 63, 94],
  red: [239, 68, 68],
  lime: [132, 204, 22],
};

// Background themes — surface/panel/ink triplets.
export const THEMES: Record<string, { surface: [number, number, number]; panel: [number, number, number]; ink: [number, number, number] }> = {
  midnight: { surface: [10, 14, 20], panel: [17, 23, 33], ink: [226, 232, 240] },
  black: { surface: [0, 0, 0], panel: [14, 14, 16], ink: [228, 228, 231] },
  slate: { surface: [15, 23, 42], panel: [23, 33, 54], ink: [226, 232, 240] },
  carbon: { surface: [12, 12, 14], panel: [22, 22, 26], ink: [229, 229, 234] },
};

export type Density = 'comfortable' | 'compact' | 'cozy';

interface SettingsState {
  accent: keyof typeof ACCENTS;
  theme: keyof typeof THEMES;
  density: Density;
  defaultMuted: boolean;
  autoplay: boolean;
  reduceMotion: boolean;
  preferProxy: boolean; // force proxy for all playback (helps on locked networks)
  showOffline: boolean; // still render channels probed as offline
  set: (patch: Partial<SettingsState>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      accent: 'cyan',
      theme: 'midnight',
      density: 'comfortable',
      defaultMuted: true,
      autoplay: true,
      reduceMotion: false,
      preferProxy: false,
      showOffline: true,
      set: (patch) => set(patch),
    }),
    { name: 'neowatch.settings' }
  )
);

export function applyTheme() {
  const { accent, theme, reduceMotion, density } = useSettings.getState();
  const root = document.documentElement;
  const a = ACCENTS[accent] || ACCENTS.cyan;
  const t = THEMES[theme] || THEMES.midnight;
  root.style.setProperty('--accent', a.join(' '));
  root.style.setProperty('--surface', t.surface.join(' '));
  root.style.setProperty('--panel', t.panel.join(' '));
  root.style.setProperty('--ink', t.ink.join(' '));
  root.dataset.density = density;
  root.dataset.motion = reduceMotion ? 'reduce' : 'full';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', `rgb(${t.surface.join(',')})`);
}

// Re-apply whenever the relevant settings change.
useSettings.subscribe(applyTheme);
