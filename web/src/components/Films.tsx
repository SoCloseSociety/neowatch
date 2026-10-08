import { useEffect, useMemo, useState } from 'react';
import { Film as FilmIcon, Search, Play } from 'lucide-react';
import { api } from '@/lib/api';
import type { Channel } from '@/types';
import { usePlayer } from '@/store/playerStore';
import { useCatalog } from '@/store/catalogStore';
import { toast } from '@/store/uiStore';
import { useT } from '@/lib/i18n';
import { AdBanner } from './AdBanner';
import { EmptyState, Spinner } from './ui';

interface Film { id: string; title: string; year: number | null; description: string; genres: string[]; poster: string }

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Public-domain movies (Internet Archive). Posters lazy-load; the playable file is
// resolved on click (one server call), then played in the Player.
export function Films() {
  const t = useT();
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const [films, setFilms] = useState<Film[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set()); // posters that 404'd

  useEffect(() => {
    let alive = true;
    setState('loading');
    api.get<{ films: Film[] }>('/films')
      .then((r) => { if (alive) { setFilms(r.films || []); setState((r.films || []).length ? 'ready' : 'error'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [reload]);

  const filtered = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return films;
    return films.filter((f) => norm(`${f.title} ${f.genres.join(' ')}`).includes(n));
  }, [films, q]);

  const playFilm = async (f: Film) => {
    if (busyId) return;
    setBusyId(f.id);
    try {
      const r = await api.get<{ url: string }>(`/films/${encodeURIComponent(f.id)}/play`);
      const ch: Channel = {
        id: `film:${f.id}`, channelId: null, name: f.title, url: r.url, kind: 'other',
        quality: null, label: null, userAgent: null, referrer: null, logo: f.poster,
        categories: ['movies'], categoryNames: [t('cat.movies')], country: null,
        countryName: f.year ? String(f.year) : null, flag: null, languages: [], languageNames: [],
        website: null, nsfw: false, tier: 'free', locked: false, source: 'custom',
        proxyUrl: null, alternates: [], online: true, latency: null,
      };
      addRecent(ch);
      play(ch);
    } catch {
      toast(t('pages.films.playFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px] px-[var(--gouttiere)] pb-12 pt-5">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 flex items-center gap-2.5 text-titre font-semibold text-ink">
              <FilmIcon className="text-ink-2" size={26} aria-hidden="true" /> {t('films.title')}
            </h1>
            <p className="mb-0 mt-1 text-sous text-ink-2">{t('pages.films.subtitle')}</p>
          </div>
          <div className="relative w-full sm:w-80">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('films.search')}
              aria-label={t('films.search')}
              className="field-input"
            />
          </div>
        </div>

        <AdBanner />

        {state === 'loading' ? (
          <div className="flex items-center justify-center py-20"><Spinner /></div>
        ) : state === 'error' ? (
          <EmptyState icon={<FilmIcon size={32} />} title={t('films.unavailable')} body={t('pages.films.errorBody')} action={{ label: t('empty.tryAgain'), onClick: () => setReload((n) => n + 1), variant: 'primary' }} />
        ) : !filtered.length ? (
          <EmptyState icon={<Search size={32} />} title={t('films.empty')} body={t('pages.films.emptyBody')} action={{ label: t('empty.clearSearch'), onClick: () => setQ(''), variant: 'primary' }} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--ecart-cartes)]">
            {filtered.map((f) => (
              <button
                key={f.id}
                type="button"
                data-card=""
                data-key={`film:${f.id}`}
                onClick={() => playFilm(f)}
                title={f.title}
                aria-label={f.title}
                aria-busy={busyId === f.id || undefined}
                className="lift group relative overflow-hidden rounded-card border border-line bg-card text-left"
              >
                <span className="relative grid aspect-[2/3] place-items-center overflow-hidden bg-mini">
                  {failed.has(f.id) ? (
                    <FilmIcon size={30} className="text-ink-3" aria-hidden="true" />
                  ) : (
                    <img src={f.poster} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setFailed((s) => new Set(s).add(f.id))} />
                  )}
                  <span
                    aria-hidden="true"
                    className={
                      'absolute inset-0 grid place-items-center bg-[rgba(5,7,10,.45)] transition-opacity duration-d1 ' +
                      (busyId === f.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')
                    }
                  >
                    <span className="grid h-12 w-12 place-items-center rounded-pill bg-pillbg text-image-ink">
                      {busyId === f.id ? <Spinner className="h-5 w-5" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                    </span>
                  </span>
                </span>
                <span className="block px-3 pb-3 pt-2">
                  <span className="block truncate text-sous font-semibold text-ink" translate="no">{f.title}</span>
                  <span className="meta block truncate" translate="no">{f.year || f.genres[0] || ' '}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="meta mt-8">{t('films.note')}</p>
      </div>
    </main>
  );
}
