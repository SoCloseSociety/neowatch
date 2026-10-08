import { api } from './api';
import { fmtTime as fmtTimeI18n } from './i18n';

export interface Programme {
  start: number;
  stop: number | null;
  title: string;
  desc?: string | null;
}
export interface NowNext {
  now: Programme | null;
  next: Programme | null;
}
export interface ProgrammeResult {
  channelId: string;
  channel: { id: string; name: string; logo?: string; flag?: string; tier?: 'free' | 'premium' };
  title: string;
  start: number;
  stop: number | null;
  live: boolean;
}

// Now/next is asked by Home, every rail, the player and the detail page, often for the
// same tvg-ids. Answers are cached per id until the programme on air ends (at most
// 5 min), concurrent asks share one request, and long id lists go in chunks so the
// query string stays short (FROZEN route GET /api/epg/now?ids=).
const TTL_MS = 5 * 60_000;
const CHUNK = 60;
const cache = new Map<string, { until: number; v: NowNext }>();
const inflight = new Map<string, Promise<Record<string, NowNext>>>();

function validUntil(v: NowNext, now: number): number {
  const stop = v.now?.stop ?? v.next?.start ?? null;
  return Math.min(now + TTL_MS, stop && stop > now ? stop : now + TTL_MS);
}

async function fetchChunk(ids: string[]): Promise<Record<string, NowNext>> {
  const key = ids.join(',');
  let p = inflight.get(key);
  if (!p) {
    p = api
      .get<{ channels: Record<string, NowNext> }>(`/epg/now?ids=${encodeURIComponent(key)}`)
      .then((r) => r.channels || {})
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export async function fetchNowNext(ids: string[]): Promise<Record<string, NowNext>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return {};
  const now = Date.now();
  const out: Record<string, NowNext> = {};
  const todo: string[] = [];
  for (const id of wanted) {
    const hit = cache.get(id);
    if (hit && hit.until > now) out[id] = hit.v;
    else todo.push(id);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  const results = await Promise.all(chunks.map((c) => fetchChunk(c).catch(() => ({}) as Record<string, NowNext>)));
  const at = Date.now();
  for (const r of results) {
    for (const [id, v] of Object.entries(r)) {
      if (!v) continue;
      out[id] = v;
      cache.set(id, { until: validUntil(v, at), v });
    }
  }
  if (cache.size > 2000) {
    for (const [k, e] of cache) if (e.until <= at) cache.delete(k);
  }
  return out;
}

export async function searchProgrammes(q: string): Promise<ProgrammeResult[]> {
  if (!q.trim()) return [];
  try {
    const r = await api.get<{ results: ProgrammeResult[] }>(`/epg/search?q=${encodeURIComponent(q)}`);
    return r.results || [];
  } catch {
    return [];
  }
}

/** HH:MM (24 h) in the current UI language (kept here for existing imports). */
export function fmtTime(ms: number): string {
  return fmtTimeI18n(ms);
}
