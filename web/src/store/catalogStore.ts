import { create } from 'zustand';
import { api } from '@/lib/api';
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
  error: string | null;

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

  toggleFavorite: (ch: Channel) => void;
  isFavorite: (url: string) => boolean;
  addRecent: (ch: Channel) => void;
  addSearchTerm: (q: string) => void;
  clearSearchHistory: () => void;
  checkHealth: (channels: Channel[], force?: boolean) => Promise<void>;
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

  favorites: loadLS<Channel[]>(LS_FAV, []),
  recents: loadLS<Channel[]>(LS_RECENT, []),
  searchHistory: loadLS<string[]>(LS_SEARCHES, []),
  health: {},
  latency: {},
  gen: 0,

  loadMeta: async () => {
    try {
      const meta = await api.get<CatalogMeta>('/catalog/meta');
      set({ meta });
    } catch (e) {
      set({ error: 'Catalogue indisponible (le serveur charge peut-être encore les données).' });
    }
  },

  setFilters: (patch) => {
    set({ filters: { ...get().filters, ...patch } });
    // Server-side filters trigger a reload; pure client filters do not.
    const serverKeys = ['category', 'country', 'language', 'q', 'foot', 'onlineOnly', 'sort'];
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
    if (filters.favoritesOnly) {
      // Served entirely from local favorites.
      set({ channels: get().favorites, page: 1, pages: 1, total: get().favorites.length, loading: false });
      return;
    }
    set({ loading: true, error: null });
    try {
      const data = await api.get<ChannelPage>(`/catalog/channels?${buildQuery(filters, 1)}`);
      if (get().gen !== gen) return; // a newer request superseded this one
      seedHealth(set, get, data.items);
      set({ channels: data.items, page: data.page, pages: data.pages, total: data.total, loading: false });
    } catch (e) {
      if (get().gen !== gen) return;
      set({ loading: false, error: 'Chargement des chaînes impossible.' });
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

  toggleFavorite: (ch) => {
    const exists = get().favorites.some((f) => f.url === ch.url);
    const favorites = exists ? get().favorites.filter((f) => f.url !== ch.url) : [ch, ...get().favorites];
    set({ favorites });
    localStorage.setItem(LS_FAV, JSON.stringify(favorites));
    // Best-effort server sync (roams across devices when logged in).
    api.put('/auth/favorites', { favorites: favorites.map((f) => f.url) }).catch(() => {});
    if (get().filters.favoritesOnly) get().loadChannels();
  },

  isFavorite: (url) => get().favorites.some((f) => f.url === url),

  addRecent: (ch) => {
    const recents = [ch, ...get().recents.filter((r) => r.url !== ch.url)].slice(0, 24);
    set({ recents });
    saveLS(LS_RECENT, recents);
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
    // Skip locked/premium channels (no URL) — nothing to probe.
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
}));

// Client-side post-filters (online-only, hide geo-blocked) applied to the loaded list.
export function applyClientFilters(channels: Channel[], filters: Filters, health: Record<string, HealthStatus>): Channel[] {
  let list = channels;
  if (filters.hideGeoBlocked) list = list.filter((c) => !/geo-?block/i.test(c.label || ''));
  // Strict: show only channels confirmed reachable (probes resolve within seconds).
  if (filters.onlineOnly) list = list.filter((c) => health[c.url] === 'online');
  return list;
}
