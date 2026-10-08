import type { Channel } from '@/types';
import { currentLang, hasKey, translate } from './i18n';

// The proxy URL is SIGNED server-side (HMAC + TTL) and delivered as ch.proxyUrl
// for every channel the user is allowed to play. The client never builds or
// signs it -- this is what keeps the proxy from being an open relay and keeps
// any credential out of the query string.
export function proxiedUrl(ch: Channel): string | null {
  return ch.proxyUrl || null;
}

// A stream needs the proxy if it carries custom UA/referrer (browser-forbidden headers).
export function mustProxy(ch: Channel): boolean {
  return !!(ch.userAgent || ch.referrer);
}

export function getYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || u.pathname.split('/').pop() || null;
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
  } catch {
    /* invalid */
  }
  return null;
}

export function youTubeEmbed(id: string): string {
  return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&playsinline=1&modestbranding=1&rel=0`;
}

// Category emoji, for DATA only (iptv-org categories, e.g. inside a select).
// Spec 2.3: no emoji in row titles, tiles or cards. Labels are i18n keys
// `cat.<id>` (lib/i18n.ts), in the current UI language.
export const CATEGORY_ICONS: Record<string, string> = {
  sports: '⚽', news: '📰', movies: '🎬', series: '📺', entertainment: '✨', kids: '🧸',
  music: '🎵', documentary: '🌍', general: '📡', culture: '🎭', comedy: '😄', cooking: '🍳',
  lifestyle: '💎', business: '📈', science: '🔬', education: '🎓', religious: '🕊️', travel: '✈️',
  weather: '⛅', animation: '🎨', family: '👨‍👩‍👧', legislative: '🏛️', outdoor: '🏔️', auto: '🏎️',
  shop: '🛍️', relax: '🧘', classic: '🎞️', public: '🏛️', interactive: '🕹️', undefined: '📦',
};

/** Category label in the current UI language (`cat.<id>`), else the id capitalised.
 *  One argument only: it is used as `categories.map(categoryLabel)`. */
export function categoryLabel(id: string): string {
  const key = `cat.${id}`;
  return hasKey(key) ? translate(currentLang(), key) : id.charAt(0).toUpperCase() + id.slice(1);
}
export function categoryIcon(id: string): string {
  return CATEGORY_ICONS[id] || '📺';
}

// Locale-aware formatting lives in lib/i18n.ts; re-exported for convenience.
export { fmtNum, fmtTime, fmtDate, fmtAge } from './i18n';

export function qualityRank(q: string | null): number {
  if (!q) return 0;
  const m = q.match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

export function debounce<F extends (...a: any[]) => void>(fn: F, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: Parameters<F>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  // Cancel a pending call (e.g. when Enter triggers the action immediately).
  wrapped.cancel = () => clearTimeout(t);
  return wrapped as typeof wrapped & { cancel: () => void };
}
