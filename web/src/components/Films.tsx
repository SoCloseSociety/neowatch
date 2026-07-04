import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Film as FilmIcon, Search, Loader2, Play, Info } from 'lucide-react';
import { api } from '@/lib/api';
import type { Channel } from '@/types';
import { usePlayer } from '@/store/playerStore';
import { useCatalog } from '@/store/catalogStore';
import { useT } from '@/lib/i18n';

interface Film { id: string; title: string; year: number | null; description: string; genres: string[]; poster: string }

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Netflix-style public-domain movies (Internet Archive). Posters lazy-load; the
// playable mp4 is resolved on click (one server call), then played in the Player.
export function Films() {
  const navigate = useNavigate();
  const t = useT();
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const [films, setFilms] = useState<Film[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set()); // posters that 404'd

  useEffect(() => {
    let alive = true;
    api.get<{ films: Film[] }>('/films')
      .then((r) => { if (alive) { setFilms(r.films || []); setState((r.films || []).length ? 'ready' : 'error'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);

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
        categories: ['movies'], categoryNames: ['Films'], country: null,
        countryName: f.year ? String(f.year) : null, flag: '🎬', languages: [], languageNames: [],
        website: null, nsfw: false, tier: 'free', locked: false, source: 'custom',
        proxyUrl: null, alternates: [], online: true, latency: null,
      };
      addRecent(ch);
      play(ch);
    } catch { /* unavailable */ } finally { setBusyId(null); }
  };

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px] px-[clamp(16px,2.6vw,40px)] pb-12 pt-4">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 flex items-center gap-2 text-[clamp(22px,3vw,32px)] font-extrabold tracking-[-0.02em] text-ink"><FilmIcon className="text-accent" size={26} /> {t('films.title')}</h1>
            <p className="mt-0.5 text-[13px] text-ink-3">{t('films.subtitle')}</p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('films.search')} className="h-[38px] w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] pl-9 pr-3 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none" />
          </div>
        </div>

        {state === 'loading' ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="animate-spin text-accent" size={30} /></div>
        ) : state === 'error' ? (
          <div className="rounded-2xl border border-white/[0.08] bg-panel/40 px-4 py-16 text-center text-[14px] text-ink-3">{t('films.unavailable')}</div>
        ) : !filtered.length ? (
          <div className="rounded-2xl border border-white/[0.08] bg-panel/40 px-4 py-16 text-center text-[14px] text-ink-3">{t('films.empty')}</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 sm:gap-4">
            {filtered.map((f) => (
              <button
                key={f.id}
                onClick={() => playFilm(f)}
                title={f.description || f.title}
                className="lift group relative overflow-hidden rounded-[14px] border border-white/[0.08] bg-panel text-left focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <div className="relative grid aspect-[2/3] place-items-center overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,rgba(124,92,252,.18),rgba(8,11,17,.5))]">
                  {failed.has(f.id) ? (
                    <FilmIcon size={30} className="text-ink-3/50" />
                  ) : (
                    <img src={f.poster} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setFailed((s) => new Set(s).add(f.id))} />
                  )}
                  <span className={clsx('absolute inset-0 grid place-items-center bg-black/40 transition-opacity', busyId === f.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}>
                    <span className="grid h-11 w-11 place-items-center rounded-full bg-accent/90 text-[#06151a]">
                      {busyId === f.id ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                    </span>
                  </span>
                </div>
                <div className="px-2.5 pb-2.5 pt-2">
                  <div className="truncate text-[13px] font-bold text-ink">{f.title}</div>
                  <div className="truncate font-mono text-[11px] text-ink-3">{f.year || f.genres[0] || ''}</div>
                </div>
              </button>
            ))}
          </div>
        )}
        <p className="mt-6 flex items-center gap-1.5 text-[11px] text-ink-3"><Info size={12} /> {t('films.note')}</p>
        <button onClick={() => navigate('/')} className="sr-only">NEOWATCH</button>
      </div>
    </main>
  );
}
