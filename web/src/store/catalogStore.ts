import { create } from 'zustand';
import { api, getToken, claims } from '@/lib/api';
import { freshChannel, stableChannel, stableId } from '@/lib/fresh';
import { filmChannel, filmIdOfUrl, loadFilmList } from '@/lib/films';
import { t } from '@/lib/i18n';
import type { CatalogMeta, Channel, ChannelPage, Filters, HealthStatus } from '@/types';

const LS_FAV = 'neowatch.favorites';
const LS_RECENT = 'neowatch.recents';
const LS_SEARCHES = 'neowatch.searches';

const loadLS = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const saveLS = (key: string, val: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage blocked */ }
};
const dropLS = (key: string) => {
  try { localStorage.removeItem(key); } catch { /* storage blocked */ }
};

// Persisted channels never carry signed links (they expire after 2 h): strip them on
// write AND on read (copies written by older builds). Playback re-resolves the
// channel through freshChannel() (HlsVideo does it when the links are missing).
const loadChannelsLS = (key: string): Channel[] => {
  const v = loadLS<unknown>(key, []);
  return Array.isArray(v) ? v.filter((c): c is Channel => !!c && typeof (c as Channel).url === 'string').map(stableChannel) : [];
};
const saveChannelsLS = (key: string, list: Channel[]) => saveLS(key, list.map(stableChannel));

// Favorites roaming (WEB-4). `accountId` is the account the favorites are synced
// with; `remoteOnly` holds account favorites this device could not turn into a
// channel yet (offline, removed from the catalog): they stay in every PUT, so a
// toggle on this device never deletes them from the account.
let accountId: string | null = null;
let remoteOnly = new Set<string>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;

// Only push while the token held is the synced account's (WEB-25: another tab may
// have switched accounts; never write one account's list into another).
function canPush(): boolean {
  const tk = getToken();
  return !!tk && !!accountId && claims(tk)?.sub === accountId;
}
function pushFavorites(list: Channel[]) {
  if (!canPush()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!canPush()) return;
    const urls = [...new Set([...list.map((f) => f.url), ...remoteOnly])].slice(0, 1000);
    api.put('/auth/favorites', { favorites: urls }).catch(() => { /* offline: the next toggle or sign-in resends */ });
  }, 400);
}

// Auto-retry a failed grid load (WEB-24): 5 s, 10 s, 20 s, 40 s, then every 60 s.
// The catalog meta (filters, status) and Home's rows use the same steps (WEB-6).
export const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
let metaRetryTimer: ReturnType<typeof setTimeout> | null = null;
let metaRetryCount = 0;
let loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
let loadRetryCount = 0;
function cancelLoadRetry() {
  if (loadRetryTimer) clearTimeout(loadRetryTimer);
  loadRetryTimer = null;
}

const DEFAULT_FILTERS: Filters = {
  category: null,
  country: null,
  language: null,
  q: '',
  foot: false,
  favoritesOnly: false,
  onlineOnly: false,
  hideGeoBlocked: false,
  sort: 'smart',
};

interface CatalogState {
  meta: CatalogMeta | null;
  filters: Filters;
  channels: Channel[];
  page: number;
  pages: number;
  total: number;
  loading: boolean;
  loadingMore: boolean;
  /** Localized message when the channel grid failed to load (null = fine). Render it with a Retry action. */
  error: string | null;
  /** The facets (/catalog/meta) failed to load. */
  metaError: boolean;

  favorites: Channel[];
  recents: Channel[];
  searchHistory: string[]; // recent search terms (for the searchbar suggestions)
  health: Record<string, HealthStatus>;
  latency: Record<string, number>;
  gen: number; // request generation guard against out-of-order responses

  loadMeta: () => Promise<void>;
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  loadChannels: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Reload what failed (facets and/or the grid) now. */
  retry: () => void;

  toggleFavorite: (ch: Channel) => void;
  isFavorite: (url: string) => boolean;
  addRecent: (ch: Channel) => void;
  addSearchTerm: (q: string) => void;
  clearSearchHistory: () => void;
  checkHealth: (channels: Channel[], force?: boolean) => Promise<void>;

  /** After sign-in: union of this device's favorites and the account's (never overwrite). */
  syncFavorites: (userId: string, serverUrls: string[]) => Promise<void>;
  /** After sign-out: forget the account's favorites, history and searches on this device. */
  clearAccountData: () => void;
}

function buildQuery(f: Filters, page: number): string {
  const p = new URLSearchParams();
  if (f.category) p.set('category', f.category);
  if (f.country) p.set('country', f.country);
  if (f.language) p.set('language', f.language);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.foot) p.set('foot', '1');
  if (f.onlineOnly) p.set('hideOffline', '1'); // drop server-confirmed-dead catalog-wide
  if (f.sort && f.sort !== 'smart') p.set('sort', f.sort);
  p.set('page', String(page));
  p.set('limit', '60');
  return p.toString();
}

// Seed the health/latency maps from the server-provided `online` field so
// LIVE/OFFLINE badges appear instantly (no per-card probe) for swept channels.
function seedHealth(set: any, get: any, items: Channel[]) {
  const h = { ...get().health };
  const lat = { ...get().latency };
  let changed = false;
  for (const it of items) {
    if (it.online === true || it.online === false) {
      const v = it.online ? 'online' : 'offline';
      if (h[it.url] !== v) { h[it.url] = v; changed = true; }
      if (it.latency != null) lat[it.url] = it.latency;
    }
  }
  if (changed) set({ health: h, latency: lat });
}

export const useCatalog = create<CatalogState>((set, get) => ({
  meta: null,
  filters: DEFAULT_FILTERS,
  channels: [],
  page: 0,
  pages: 0,
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  metaError: false,

  favorites: loadChannelsLS(LS_FAV),
  recents: loadChannelsLS(LS_RECENT),
  searchHistory: loadLS<string[]>(LS_SEARCHES, []),
  health: {},
  latency: {},
  gen: 0,

  loadMeta: async () => {
    if (metaRetryTimer) clearTimeout(metaRetryTimer);
    metaRetryTimer = null;
    try {
      const meta = await api.get<CatalogMeta>('/catalog/meta');
      metaRetryCount = 0;
      set({ meta, metaError: false });
    } catch {
      set({ metaError: true });
      // A TV switched on before its Wi-Fi: the filters and the status come back on
      // their own (and at once on 'online', below).
      const delay = RETRY_DELAYS_MS[Math.min(metaRetryCount, RETRY_DELAYS_MS.length - 1)];
      metaRetryCount++;
      metaRetryTimer = setTimeout(() => {
        metaRetryTimer = null;
        if (get().metaError) get().loadMeta();
      }, delay);
    }
  },

  setFilters: (patch) => {
    set({ filters: { ...get().filters, ...patch } });
    // Server-side filters trigger a reload; pure client filters do not.
    const serverKeys = ['category', 'country', 'language', 'q', 'foot', 'onlineOnly', 'sort', 'favoritesOnly'];
    if (Object.keys(patch).some((k) => serverKeys.includes(k))) {
      get().loadChannels();
    }
  },

  resetFilters: () => {
    set({ filters: DEFAULT_FILTERS });
    get().loadChannels();
  },

  loadChannels: async () => {
    const { filters } = get();
    const gen = get().gen + 1;
    set({ gen });
    cancelLoadRetry();
    if (filters.favoritesOnly) {
      // Served entirely from local favorites.
      set({ channels: get().favorites, page: 1, pages: 1, total: get().favorites.length, loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const data = await api.get<ChannelPage>(`/catalog/channels?${buildQuery(filters, 1)}`);
      if (get().gen !== gen) return; // a newer request superseded this one
      seedHealth(set, get, data.items);
      loadRetryCount = 0;
      set({ channels: data.items, page: data.page, pages: data.pages, total: data.total, loading: false, error: null });
    } catch {
      if (get().gen !== gen) return;
      set({ loading: false, error: t('catalog.unavailable') });
      // A TV switched on during a deploy recovers on its own.
      const delay = RETRY_DELAYS_MS[Math.min(loadRetryCount, RETRY_DELAYS_MS.length - 1)];
      loadRetryCount++;
      loadRetryTimer = setTimeout(() => {
        loadRetryTimer = null;
        if (get().gen === gen && get().error) get().loadChannels();
      }, delay);
    }
  },

  loadMore: async () => {
    const { filters, page, pages, loadingMore, channels, gen } = get();
    if (filters.favoritesOnly || loadingMore || page >= pages) return;
    set({ loadingMore: true });
    try {
      const data = await api.get<ChannelPage>(`/catalog/channels?${buildQuery(filters, page + 1)}`);
      // Drop if filters changed (generation bumped) while this page was in flight.
      if (get().gen !== gen) {
        set({ loadingMore: false });
        return;
      }
      seedHealth(set, get, data.items);
      set({ channels: [...channels, ...data.items], page: data.page, loadingMore: false });
    } catch {
      set({ loadingMore: false });
    }
  },

  retry: () => {
    loadRetryCount = 0;
    if (!get().meta || get().metaError) get().loadMeta();
    get().loadChannels();
  },

  toggleFavorite: (ch) => {
    if (!ch?.url) return;
    const exists = get().favorites.some((f) => f.url === ch.url);
    const favorites = exists ? get().favorites.filter((f) => f.url !== ch.url) : [ch, ...get().favorites];
    remoteOnly.delete(ch.url);
    set({ favorites });
    saveChannelsLS(LS_FAV, favorites);
    // Roams across devices when signed in (the full list incl. account-only entries).
    pushFavorites(favorites);
    if (get().filters.favoritesOnly) get().loadChannels();
  },

  isFavorite: (url) => get().favorites.some((f) => f.url === url),

  addRecent: (ch) => {
    if (!ch?.url) return;
    const recents = [ch, ...get().recents.filter((r) => r.url !== ch.url)].slice(0, 24);
    set({ recents });
    saveChannelsLS(LS_RECENT, recents);
  },

  // Remember a settled search term (deduped, case-insensitive, newest first, cap 8)
  // so the searchbar can suggest past searches -- a big help with a TV remote.
  addSearchTerm: (q) => {
    const term = q.trim();
    if (term.length < 2) return;
    const lower = term.toLowerCase();
    const searchHistory = [term, ...get().searchHistory.filter((s) => s.toLowerCase() !== lower)].slice(0, 8);
    set({ searchHistory });
    saveLS(LS_SEARCHES, searchHistory);
  },
  clearSearchHistory: () => { set({ searchHistory: [] }); saveLS(LS_SEARCHES, []); },

  checkHealth: async (channels, force = false) => {
    const { health } = get();
    // Skip locked channels (no URL): nothing to probe.
    const toCheck = channels.filter((c) => c.url && (force || !health[c.url] || health[c.url] === 'unknown'));
    if (!toCheck.length) return;
    const pending = { ...get().health };
    toCheck.forEach((c) => (pending[c.url] = 'checking'));
    set({ health: pending });

    // Chunk into batches of 40 (server cap).
    for (let i = 0; i < toCheck.length; i += 40) {
      const batch = toCheck.slice(i, i + 40);
      try {
        const { results } = await api.post<{ results: { id: string; online: boolean; ms: number }[] }>(
          '/catalog/check',
          { items: batch.map((c) => ({ id: c.url, url: c.url, ua: c.userAgent, ref: c.referrer })), force }
        );
        const h = { ...get().health };
        const lat = { ...get().latency };
        results.forEach((r) => {
          h[r.id] = r.online ? 'online' : 'offline';
          lat[r.id] = r.ms;
        });
        set({ health: h, latency: lat });
      } catch {
        const h = { ...get().health };
        batch.forEach((c) => (h[c.url] = 'unknown'));
        set({ health: h });
      }
    }
  },

  syncFavorites: async (userId, serverUrls) => {
    const server = [...new Set((serverUrls || []).filter((u) => typeof u === 'string' && u))];
    accountId = userId;
    const local = get().favorites;
    const localUrls = new Set(local.map((f) => f.url));
    const missing = server.filter((u) => !localUrls.has(u));
    remoteOnly = new Set(missing);
    // The union goes back to the account once when this device brought new entries.
    const serverSet = new Set(server);
    if (local.some((f) => !serverSet.has(f.url))) pushFavorites(local);
    if (!missing.length) return;
    // Turn account-only urls into channels (frozen /catalog/channel/:id, id = djb2(url)),
    // a few at a time. Unresolved ones stay in remoteOnly (kept on the account).
    const resolved: Channel[] = [];
    const queue = missing.slice(0, 300);
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift() as string;
        // A film is not in the catalog: rebuild it from the film list (QA-5).
        const filmId = filmIdOfUrl(url);
        if (filmId) {
          const f = (await loadFilmList()).find((x) => x.id === filmId);
          if (f) resolved.push(filmChannel(f, url));
          continue;
        }
        const stub = { id: stableId(url), url } as Channel; // the rest comes from the server
        const ch = await freshChannel(stub, { force: true });
        if (ch !== stub && ch.name) resolved.push(ch);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (accountId !== userId || !resolved.length) return; // signed out meanwhile
    const cur = get().favorites;
    const have = new Set(cur.map((f) => f.url));
    const add = resolved.filter((c) => !have.has(c.url));
    for (const c of resolved) remoteOnly.delete(c.url);
    // A server-side alias may resolve to a new stream url: keep the account's url too.
    for (const u of missing) if (!resolved.some((c) => c.url === u)) remoteOnly.add(u);
    if (!add.length) return;
    const favorites = [...cur, ...add];
    set({ favorites });
    saveChannelsLS(LS_FAV, favorites);
    if (get().filters.favoritesOnly) get().loadChannels();
  },

  clearAccountData: () => {
    accountId = null;
    remoteOnly = new Set();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    dropLS(LS_FAV);
    dropLS(LS_RECENT);
    dropLS(LS_SEARCHES);
    set({ favorites: [], recents: [], searchHistory: [] });
    if (get().filters.favoritesOnly) get().loadChannels();
  },
}));

// Client-side post-filters (online-only, hide geo-blocked) applied to the loaded list.
export function applyClientFilters(channels: Channel[], filters: Filters, health: Record<string, HealthStatus>): Channel[] {
  let list = channels;
  if (filters.hideGeoBlocked) list = list.filter((c) => !/geo-?block/i.test(c.label || ''));
  // Strict: show only channels confirmed reachable (probes resolve within seconds).
  if (filters.onlineOnly) list = list.filter((c) => health[c.url] === 'online');
  return list;
}

// Back online: a failed meta load is retried now, not at the next backoff step.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (useCatalog.getState().metaError) useCatalog.getState().loadMeta();
  });
}
