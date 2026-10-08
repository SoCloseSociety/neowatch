import { api, ApiError } from './api';
import type { Channel } from '@/types';

// Signed proxy links (`/api/proxy?...&exp=<ms>&sig=...`) live 2 h (server
// signing.js). A Channel kept longer than that (favorites, recents, the mosaic,
// the account copy, a TV left on Home) holds dead links. freshChannel() asks the
// FROZEN route GET /api/catalog/channel/:id for the current copy; stableChannel()
// is what every store persists, so nothing signed is ever written to storage.

/** Refresh when a signed link expires in less than this. */
const MIN_LIFE_MS = 10 * 60_000;
/** A refreshed copy is reused for this long (several tiles, a quick re-open). */
const MEMO_MS = 60_000;
const TIMEOUT_MS = 8_000;

/** The catalog id formula (djb2, base 36), same as server util.js stableId (frozen). */
export function stableId(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Catalog ids are short lowercase base-36 hashes; films/radios use a prefix. */
const CATALOG_ID = /^[0-9a-z]{1,13}$/;

/** `exp` (ms) of a signed proxy link, or null when absent / not a proxy link. */
export function proxyExp(proxyUrl: string | null | undefined): number | null {
  if (!proxyUrl) return null;
  const m = /[?&]exp=(\d+)/.exec(proxyUrl);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** The channel can be re-resolved through the catalog (not a film, radio or YouTube item). */
export function isCatalogChannel(ch: Pick<Channel, 'id' | 'url' | 'kind' | 'locked'>): boolean {
  if (!ch || !ch.url || ch.locked || ch.kind === 'youtube') return false;
  return CATALOG_ID.test(ch.id || '') || !ch.id;
}

/** True when the channel's signed links are missing or expire within 10 min. */
export function needsFresh(ch: Channel, now = Date.now()): boolean {
  if (!isCatalogChannel(ch)) return false;
  if (!ch.proxyUrl) return true; // persisted copy (stableChannel) or never signed
  const links = [ch.proxyUrl, ...(ch.alternates || []).map((a) => a.proxyUrl)];
  return links.some((u) => {
    const e = proxyExp(u);
    return e === null || e - now < MIN_LIFE_MS;
  });
}

const memo = new Map<string, { at: number; ch: Channel }>();
const inflight = new Map<string, Promise<Channel | null>>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); }
    );
  });
}

async function fetchChannel(id: string, channelId: string | null): Promise<Channel | null> {
  const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : '';
  try {
    return await api.get<Channel>(`/catalog/channel/${encodeURIComponent(id)}${q}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Merge the server's current copy into ours: our fields win (a stub `{ id, url }`
 * gets everything else from the server), then the server's playback fields and
 * health, and the canonical id is adopted.
 */
function merge(ch: Channel, srv: Channel): Channel {
  return {
    ...srv,
    ...ch,
    id: srv.canonicalId || srv.id || ch.id,
    canonicalId: srv.canonicalId || srv.id || ch.canonicalId,
    url: srv.url || ch.url,
    proxyUrl: srv.proxyUrl ?? null,
    alternates: srv.alternates || [],
    online: srv.online ?? ch.online ?? null,
    checkedAt: srv.checkedAt ?? ch.checkedAt ?? null,
    latency: srv.latency ?? ch.latency ?? null,
    userAgent: srv.userAgent ?? ch.userAgent ?? null,
    referrer: srv.referrer ?? ch.referrer ?? null,
    logo: ch.logo || srv.logo,
  };
}

/**
 * Current copy of a channel, with live signed links. Re-resolves when the links
 * are missing or expire within 10 min (always the case for a persisted copy), or
 * when `force` is set (a 403 from the relay). Never throws: on any failure
 * (offline, 404, timeout, film or radio item) the channel comes back unchanged.
 */
export async function freshChannel(ch: Channel, opts: { force?: boolean } = {}): Promise<Channel> {
  try {
    if (!ch || !isCatalogChannel(ch)) return ch;
    if (!opts.force && !needsFresh(ch)) return ch;
    const id = ch.id && CATALOG_ID.test(ch.id) ? ch.id : stableId(ch.url);
    const key = ch.url;
    const hit = memo.get(key);
    if (!opts.force && hit && Date.now() - hit.at < MEMO_MS) return merge(ch, hit.ch);
    let p = inflight.get(key);
    if (!p) {
      p = withTimeout(fetchChannel(id, ch.channelId), TIMEOUT_MS).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const srv = await p;
    if (!srv || !srv.url || srv.locked) return ch;
    memo.set(key, { at: Date.now(), ch: srv });
    if (memo.size > 200) memo.delete(memo.keys().next().value as string);
    return merge(ch, srv);
  } catch {
    return ch;
  }
}

/** Copy safe to persist (localStorage, the account): no signed links, no transient state. */
export function stableChannel(ch: Channel): Channel {
  const { proxyUrl: _p, latency: _l, ...rest } = ch;
  void _p;
  void _l;
  return {
    ...rest,
    proxyUrl: null,
    alternates: (ch.alternates || []).map((a) => ({ ...a, proxyUrl: null })),
  };
}
