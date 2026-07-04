import { create } from 'zustand';
import type { Channel } from '@/types';
import { api, getToken } from '@/lib/api';

const MAX_TILES = 9;
const LS_MULTI = 'neowatch.multi';
const LS_AUDIO = 'neowatch.multi.audio';

// Persist the mosaic so it survives reloads and deploys (like favorites/recents).
function loadMulti(): Channel[] {
  try { const raw = localStorage.getItem(LS_MULTI); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.slice(0, MAX_TILES) : []; }
  catch { return []; }
}
function saveMulti(multi: Channel[], activeAudio: string | null) {
  try { localStorage.setItem(LS_MULTI, JSON.stringify(multi)); localStorage.setItem(LS_AUDIO, activeAudio || ''); } catch { /* quota */ }
}

// When signed in, mirror the mosaic config to the account (debounced) so it roams
// across devices: set it up on a computer, pick it up on the TV after signing in.
let pushTimer: ReturnType<typeof setTimeout> | null = null;
function pushMulti(multi: Channel[]) {
  if (!getToken()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { api.put('/auth/multi', { multi }).catch(() => { /* offline */ }); }, 800);
}

interface PlayerState {
  current: Channel | null;       // single fullscreen player
  multi: Channel[];              // mosaic tiles
  multiOpen: boolean;
  activeAudio: string | null;    // url of the tile whose audio is on

  play: (ch: Channel) => void;
  close: () => void;

  openMulti: () => void;
  closeMulti: () => void;
  addToMulti: (ch: Channel) => void;
  removeFromMulti: (url: string) => void;
  clearMulti: () => void;
  setActiveAudio: (url: string | null) => void;
  isInMulti: (url: string) => boolean;
  hydrateMulti: (multi: Channel[] | undefined) => void; // from the account on sign-in
}

const initialMulti = typeof localStorage !== 'undefined' ? loadMulti() : [];
const initialAudio = (typeof localStorage !== 'undefined' && localStorage.getItem(LS_AUDIO)) || null;

export const usePlayer = create<PlayerState>((set, get) => ({
  current: null,
  multi: initialMulti,
  multiOpen: false,
  activeAudio: initialAudio || initialMulti[0]?.url || null,

  play: (ch) => set({ current: ch }),
  close: () => set({ current: null }),

  // Opening the mosaic closes the single player so a channel can't mount twice.
  openMulti: () => set({ multiOpen: true, current: null }),
  closeMulti: () => set({ multiOpen: false }),

  addToMulti: (ch) => {
    const cur = get().multi;
    // Already in the mosaic, or mosaic full (9 tiles): open it anyway so the tap
    // ALWAYS does something visible -- a silent no-op looked broken on a TV remote.
    // The MultiView header shows the count (e.g. 9/9), explaining why it didn't add.
    if (cur.some((c) => c.url === ch.url) || cur.length >= MAX_TILES) {
      set({ multiOpen: true, current: null });
      return;
    }
    const multi = [...cur, ch];
    const activeAudio = get().activeAudio ?? ch.url;
    saveMulti(multi, activeAudio);
    pushMulti(multi);
    set({ multi, multiOpen: true, current: null, activeAudio });
  },

  removeFromMulti: (url) => {
    const multi = get().multi.filter((c) => c.url !== url);
    const activeAudio = get().activeAudio === url ? multi[0]?.url ?? null : get().activeAudio;
    saveMulti(multi, activeAudio);
    pushMulti(multi);
    set({ multi, activeAudio });
  },

  clearMulti: () => { saveMulti([], null); pushMulti([]); set({ multi: [], activeAudio: null }); },
  setActiveAudio: (url) => { saveMulti(get().multi, url); set({ activeAudio: url }); },
  isInMulti: (url) => get().multi.some((c) => c.url === url),

  // Replace the local mosaic with the account's saved config (server wins on sign-in,
  // so a TV picks up what was set on the computer). Empty server config keeps local.
  hydrateMulti: (serverMulti) => {
    if (!Array.isArray(serverMulti) || !serverMulti.length) return;
    const multi = serverMulti.slice(0, MAX_TILES);
    const activeAudio = multi[0]?.url ?? null;
    saveMulti(multi, activeAudio);
    set({ multi, activeAudio });
  },
}));

export { MAX_TILES };
