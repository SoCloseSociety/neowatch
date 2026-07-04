import type { Channel } from '@/types';

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

// Curated icons + FR labels for the most useful categories.
export const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  sports: { label: 'Sport', icon: '⚽' },
  news: { label: 'News / Actu', icon: '📰' },
  movies: { label: 'Films', icon: '🎬' },
  series: { label: 'Séries', icon: '📺' },
  entertainment: { label: 'Divertissement', icon: '✨' },
  kids: { label: 'Enfants', icon: '🧸' },
  music: { label: 'Musique', icon: '🎵' },
  documentary: { label: 'Docu', icon: '🌍' },
  general: { label: 'Généraliste', icon: '📡' },
  culture: { label: 'Culture', icon: '🎭' },
  comedy: { label: 'Comédie', icon: '😄' },
  cooking: { label: 'Cuisine', icon: '🍳' },
  lifestyle: { label: 'Lifestyle', icon: '💎' },
  business: { label: 'Business', icon: '📈' },
  science: { label: 'Science', icon: '🔬' },
  education: { label: 'Éducation', icon: '🎓' },
  religious: { label: 'Religion', icon: '🕊️' },
  travel: { label: 'Voyage', icon: '✈️' },
  weather: { label: 'Météo', icon: '⛅' },
  animation: { label: 'Animation', icon: '🎨' },
  family: { label: 'Famille', icon: '👨‍👩‍👧' },
  legislative: { label: 'Politique', icon: '🏛️' },
  outdoor: { label: 'Outdoor', icon: '🏔️' },
  auto: { label: 'Auto/Moto', icon: '🏎️' },
  shop: { label: 'Shopping', icon: '🛍️' },
  relax: { label: 'Détente', icon: '🧘' },
  undefined: { label: 'Autres', icon: '📦' },
};

export function categoryLabel(id: string): string {
  return CATEGORY_META[id]?.label || id.charAt(0).toUpperCase() + id.slice(1);
}
export function categoryIcon(id: string): string {
  return CATEGORY_META[id]?.icon || '📺';
}

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
