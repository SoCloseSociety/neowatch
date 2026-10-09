import { create } from 'zustand';
import type { Channel } from '@/types';
import { api, getToken } from '@/lib/api';
import { freshChannel, needsFresh, stableChannel } from '@/lib/fresh';
import { useAuth } from './authStore';
import { useCatalog } from './catalogStore';

const MAX_TILES = 9;
const LS_MULTI = 'neowatch.multi';
const LS_AUDIO = 'neowatch.multi.audio';

// Storage can throw (private mode, TV WebViews): every access is guarded.
function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* quota / blocked */ }
}
function lsDel(key: string) {
  try { localStorage.removeItem(key); } catch { /* blocked */ }
}

const isChannel = (v: unknown): v is Channel =>
  !!v && typeof v === 'object' && typeof (v as Channel).url === 'string' && !!(v as Channel).url && typeof (v as Channel).name === 'string';

// The mosaic survives reloads and deploys. Only stable fields are stored: a
// signed proxy link dies after 2 h, freshChannel() gets a live one before play.
function loadMulti(): Channel[] {
  try {
    const raw = lsGet(LS_MULTI);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isChannel).slice(0, MAX_TILES) : [];
  } catch {
    return [];
  }
}
function saveMulti(multi: Channel[], activeAudio: string | null) {
  lsSet(LS_MULTI, JSON.stringify(multi.map(stableChannel)));
  lsSet(LS_AUDIO, activeAudio || '');
}

// When signed in, mirror the mosaic to the account (debounced) so it roams:
// set it up on a computer, pick it up on the TV after signing in.
let pushTimer: ReturnType<typeof setTimeout> | null = null;
function pushMulti(multi: Channel[]) {
  if (!getToken()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    api.put('/auth/multi', { multi: multi.map(stableChannel) }).catch(() => { /* offline */ });
  }, 800);
}

/** The `data-key` (stream url) of the card the focus is on, if any. */
function focusedKey(): string | null {
  if (typeof document === 'undefined') return null;
  const el = (document.activeElement as HTMLElement | null)?.closest?.('[data-key]') as HTMLElement | null;
  return el?.dataset.key || null;
}

const playable = (c: Channel) => !!c.url && !c.locked;

// A guide row is a short projection (no stream url): it joins a zapping list as
// a stub, resolved through GET /catalog/channel/:id when zapping reaches it.
const STUB = 'nw-guide:';
/** A guide row not resolved yet (no stream: nothing to favorite or tile). */
export const isStub = (c: Channel) => c.url.startsWith(STUB);
/** Zapping-list entry for a guide row (id + channelId), resolved when it plays. */
export function guideStub(row: { id: string; name: string; logo: string | null; channelId: string }): Channel {
  return {
    id: row.id, channelId: row.channelId || null, name: row.name, url: `${STUB}${row.id}`, kind: 'hls',
    quality: null, label: null, userAgent: null, referrer: null, logo: row.logo || undefined,
    categories: [], categoryNames: [], country: null, countryName: null, flag: null,
    languages: [], languageNames: [], website: null, nsfw: false, proxyUrl: null, alternates: [],
  };
}
async function resolveStub(c: Channel): Promise<Channel | null> {
  try {
    const q = c.channelId ? `?channelId=${encodeURIComponent(c.channelId)}` : '';
    const full = await api.get<Channel>(`/catalog/channel/${encodeURIComponent(c.id)}${q}`);
    return full && full.url && !full.locked ? full : null;
  } catch {
    return null;
  }
}

export interface PlayOptions {
  /** The list the channel was picked from (rail, grid, search), for next / previous. */
  queue?: Channel[];
  /** data-key of the launcher, for the focus to come back on close. Default: the focused card. */
  originKey?: string | null;
  /** Start with the sound off whatever the setting says (a shared link with ?play=1). */
  muted?: boolean;
}

interface PlayerState {
  current: Channel | null;       // single fullscreen player
  /** The current channel has live links: the video may mount. */
  currentReady: boolean;
  /** Zapping list (playable channels only) and the current position in it. */
  queue: Channel[];
  /** Card that launched the player (focus restore on Back). */
  originKey: string | null;
  /** This opening starts muted (PlayOptions.muted). */
  startMuted: boolean;
  /** Url of the channel the player shows (or showed last). */
  lastUrl: string | null;
  multi: Channel[];              // mosaic tiles
  multiOpen: boolean;
  /** Mosaic tiles re-resolved (live signed links) since it opened. */
  multiReady: boolean;
  activeAudio: string | null;    // url of the tile whose audio is on

  play: (ch: Channel, opts?: PlayOptions) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
  hasQueue: () => boolean;

  openMulti: () => void;
  closeMulti: () => void;
  addToMulti: (ch: Channel) => void;
  removeFromMulti: (url: string) => void;
  clearMulti: () => void;
  /** Put back a mosaic (undo of clear). */
  restoreMulti: (multi: Channel[], activeAudio: string | null) => void;
  setActiveAudio: (url: string | null) => void;
  isInMulti: (url: string) => boolean;
  hydrateMulti: (multi: Channel[] | undefined) => void; // from the account on sign-in
  /** Sign-out: forget everything tied to the account on this device. */
  resetAccount: () => void;
}

const initialMulti = typeof window !== 'undefined' ? loadMulti() : [];
const storedAudio = typeof window !== 'undefined' ? lsGet(LS_AUDIO) : null;
const initialAudio = storedAudio && initialMulti.some((c) => c.url === storedAudio) ? storedAudio : initialMulti[0]?.url ?? null;

let playSeq = 0;
let multiSeq = 0;

export const usePlayer = create<PlayerState>((set, get) => {
  /**
   * Open the player on `ch`. A copy without live signed links (favorites,
   * recents, the account) is re-resolved first: the overlay opens at once and
   * the video mounts when the fresh copy lands (at most 2.5 s), so playback never
   * starts on a dead link and never restarts.
   */
  const show = (ch: Channel) => {
    const seq = ++playSeq;
    if (typeof window !== 'undefined') window.__nwLastPlayedKey = ch.url;
    if (isStub(ch)) {
      // A guide row reached by zapping: the overlay shows its name at once, the
      // video mounts on the resolved channel, which takes the stub's place in
      // the list. Unresolvable (gone, Premium): skip it, same direction.
      set({ current: ch, currentReady: false, lastUrl: ch.url });
      void resolveStub(ch).then((full) => {
        if (seq !== playSeq || !get().current) return;
        if (!full) {
          const queue = get().queue.filter((c) => c.url !== ch.url);
          const i = get().queue.findIndex((c) => c.url === ch.url);
          set({ queue });
          const nextCh = queue.length ? queue[Math.min(Math.max(i, 0), queue.length - 1)] : null;
          if (nextCh) show(nextCh);
          else get().close();
          return;
        }
        set({ queue: get().queue.map((c) => (c.url === ch.url ? full : c)) });
        useCatalog.getState().addRecent(full);
        show(full);
      });
      return;
    }
    if (!needsFresh(ch)) {
      set({ current: ch, currentReady: true, lastUrl: ch.url });
      return;
    }
    set({ current: ch, currentReady: false, lastUrl: ch.url });
    let done = false;
    const finish = (c: Channel) => {
      if (done || seq !== playSeq || !get().current) return;
      done = true;
      set({ current: c, currentReady: true, lastUrl: c.url });
    };
    const guard = setTimeout(() => finish(ch), 2500);
    freshChannel(ch).then((fresh) => {
      clearTimeout(guard);
      finish(fresh);
    });
  };

  const step = (dir: 1 | -1) => {
    const { queue, current } = get();
    if (!current || queue.length < 2) return;
    const i = queue.findIndex((c) => c.url === current.url);
    const n = queue.length;
    const nextCh = queue[(((i < 0 ? 0 : i) + dir) % n + n) % n];
    if (!nextCh || nextCh.url === current.url) return;
    if (!isStub(nextCh)) useCatalog.getState().addRecent(nextCh);
    show(nextCh);
  };

  /** Re-resolve every tile once per opening (persisted copies have no live links). */
  const refreshMulti = () => {
    const seq = ++multiSeq;
    const tiles = get().multi;
    if (!tiles.length) {
      set({ multiReady: true });
      return;
    }
    set({ multiReady: false });
    // Never block the mosaic more than 3 s on a slow network.
    const guard = setTimeout(() => { if (seq === multiSeq) set({ multiReady: true }); }, 3000);
    Promise.all(tiles.map((c) => freshChannel(c))).then((fresh) => {
      clearTimeout(guard);
      if (seq !== multiSeq) return;
      const byUrl = new Map(tiles.map((c, i) => [c.url, fresh[i]]));
      // Tiles may have been removed meanwhile: keep the current list, fresh copies swapped in.
      set({ multi: get().multi.map((c) => byUrl.get(c.url) || c), multiReady: true });
    });
  };

  return {
    current: null,
    currentReady: false,
    queue: [],
    originKey: null,
    startMuted: false,
    lastUrl: null,
    multi: initialMulti,
    multiOpen: false,
    multiReady: false,
    activeAudio: initialAudio,

    play: (ch, opts = {}) => {
      if (!playable(ch)) return;
      let queue = (opts.queue || []).filter(playable);
      if (!queue.length) {
        // No list given: the loaded grid (the channel first when it is not in it).
        queue = useCatalog.getState().channels.filter(playable);
      }
      if (!queue.some((c) => c.url === ch.url)) queue = [ch, ...queue];
      const originKey = opts.originKey !== undefined ? opts.originKey : focusedKey() || ch.url;
      // Opening the player closes the mosaic so a channel can't mount twice.
      set({ queue: queue.slice(0, 500), originKey, startMuted: !!opts.muted, multiOpen: false });
      show(ch);
    },
    close: () => {
      playSeq += 1;
      set({ current: null, currentReady: false });
    },
    next: () => step(1),
    prev: () => step(-1),
    hasQueue: () => get().queue.length > 1,

    openMulti: () => {
      playSeq += 1;
      set({ multiOpen: true, current: null });
      refreshMulti();
    },
    closeMulti: () => {
      multiSeq += 1;
      set({ multiOpen: false });
    },

    addToMulti: (ch) => {
      const cur = get().multi;
      // Already in the mosaic, or full (9 tiles): open it anyway so the press ALWAYS
      // does something visible; the header count (9 of 9) says why nothing was added.
      if (!playable(ch) || cur.some((c) => c.url === ch.url) || cur.length >= MAX_TILES) {
        get().openMulti();
        return;
      }
      const multi = [...cur, ch];
      const activeAudio = get().activeAudio ?? ch.url;
      saveMulti(multi, activeAudio);
      pushMulti(multi);
      set({ multi, activeAudio });
      get().openMulti();
    },

    removeFromMulti: (url) => {
      const multi = get().multi.filter((c) => c.url !== url);
      const activeAudio = get().activeAudio === url ? multi[0]?.url ?? null : get().activeAudio;
      saveMulti(multi, activeAudio);
      pushMulti(multi);
      set({ multi, activeAudio });
    },

    clearMulti: () => {
      saveMulti([], null);
      pushMulti([]);
      set({ multi: [], activeAudio: null });
    },
    restoreMulti: (multi, activeAudio) => {
      const list = multi.slice(0, MAX_TILES);
      saveMulti(list, activeAudio);
      pushMulti(list);
      set({ multi: list, activeAudio });
    },
    setActiveAudio: (url) => {
      saveMulti(get().multi, url);
      set({ activeAudio: url });
    },
    isInMulti: (url) => get().multi.some((c) => c.url === url),

    // Replace the local mosaic with the account's saved config (server wins on
    // sign-in, so a TV picks up what was set on the computer). Empty keeps local.
    hydrateMulti: (serverMulti) => {
      if (!Array.isArray(serverMulti) || !serverMulti.length) return;
      const multi = serverMulti.filter(isChannel).slice(0, MAX_TILES);
      if (!multi.length) return;
      // The tile picked for sound on this device stays, when it is still a tile (QA-12).
      const kept = get().activeAudio;
      const activeAudio = kept && multi.some((c) => c.url === kept) ? kept : multi[0]?.url ?? null;
      saveMulti(multi, activeAudio);
      set({ multi, activeAudio });
      if (get().multiOpen) refreshMulti();
    },

    resetAccount: () => {
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
      playSeq += 1;
      multiSeq += 1;
      lsDel(LS_MULTI);
      lsDel(LS_AUDIO);
      set({ current: null, currentReady: false, queue: [], originKey: null, multi: [], multiOpen: false, activeAudio: null });
    },
  };
});

// Sign-out (this tab or a 401): the mosaic belongs to the account, so the next
// person on a shared TV or browser does not inherit it.
if (typeof window !== 'undefined') {
  let prevUser = useAuth.getState().user?.id ?? null;
  useAuth.subscribe((s) => {
    const id = s.user?.id ?? null;
    if (prevUser && !id) usePlayer.getState().resetAccount();
    prevUser = id;
  });
}

export { MAX_TILES };
