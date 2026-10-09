import type { Channel } from '@/types';
import { api } from './api';
import { t } from './i18n';

// Public-domain films (Internet Archive, GET /api/films). They are not catalog
// channels: their id is `film:<archive id>`, there is no channel page and no
// /catalog/channel/:id copy. A favorite roams as its play url
// (https://archive.org/download/<id>/<file>), turned back into a film here.

export interface Film { id: string; title: string; year: number | null; description: string; genres: string[]; poster: string }

const PREFIX = 'film:';

/** The channel is a film (VOD, no channel page, no live pill). */
export const isFilm = (ch: Pick<Channel, 'id'> | null | undefined): boolean => !!ch?.id && ch.id.startsWith(PREFIX);

/** The player's copy of a film, `url` being its resolved play file. */
export function filmChannel(f: Pick<Film, 'id' | 'title' | 'year' | 'poster'>, url: string): Channel {
  return {
    id: `${PREFIX}${f.id}`, channelId: null, name: f.title, url, kind: 'other',
    quality: null, label: null, userAgent: null, referrer: null, logo: f.poster,
    categories: ['movies'], categoryNames: [t('cat.movies')], country: null,
    countryName: f.year ? String(f.year) : null, flag: null, languages: [], languageNames: [],
    website: null, nsfw: false, tier: 'free', locked: false, source: 'custom',
    proxyUrl: null, alternates: [], online: true, latency: null,
  };
}

/** Archive item id of a film play url, or null for anything else. */
export function filmIdOfUrl(url: string): string | null {
  const m = /^https:\/\/archive\.org\/download\/([^/?#]+)\//.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

let listP: Promise<Film[]> | null = null;
/** The film list, fetched once per page load (a failure is not kept). */
export function loadFilmList(): Promise<Film[]> {
  if (!listP) {
    listP = api
      .get<{ films: Film[] }>('/films')
      .then((r) => r.films || [])
      .catch(() => {
        listP = null;
        return [];
      });
  }
  return listP;
}
