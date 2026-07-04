import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { RadioTower, Search, Loader2, Play, Square, Volume2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Station {
  id: string;
  name: string;
  url: string;
  proxyUrl: string;
  favicon: string | null;
  country: string | null;
  countryCode: string | null;
  tags: string[];
  codec: string | null;
  bitrate: number | null;
  clicks: number;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Internet radio (radio-browser.info directory). Stations play in a sticky audio
// bar: HTTPS streams play direct; HTTP streams go through the signed proxy
// (mixed-content), with an automatic direct -> proxy fallback on error.
export function Radios() {
  const t = useT();
  const [stations, setStations] = useState<Station[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [q, setQ] = useState('');
  const [current, setCurrent] = useState<Station | null>(null);
  const [playState, setPlayState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const audioRef = useRef<HTMLAudioElement>(null);
  const triedProxy = useRef(false);

  useEffect(() => {
    let alive = true;
    api.get<{ items: Station[] }>('/radios?limit=200')
      .then((r) => { if (alive) { setStations(r.items || []); setState((r.items || []).length ? 'ready' : 'error'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return stations;
    const tokens = n.split(/\s+/).filter(Boolean);
    return stations.filter((s) => {
      const hay = norm(`${s.name} ${s.country || ''} ${s.tags.join(' ')}`);
      return tokens.every((tk) => hay.includes(tk));
    });
  }, [stations, q]);

  const srcFor = (s: Station, proxy: boolean) =>
    proxy || /^http:\/\//i.test(s.url) ? s.proxyUrl : s.url;

  const play = (s: Station) => {
    const a = audioRef.current;
    if (!a) return;
    triedProxy.current = /^http:\/\//i.test(s.url); // http starts on proxy already
    setCurrent(s);
    setPlayState('loading');
    a.src = srcFor(s, false);
    a.play().catch(() => { /* onError handles the fallback */ });
  };

  const stop = () => {
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute('src'); a.load(); }
    setCurrent(null);
    setPlayState('idle');
  };

  // Direct failed -> retry once through the proxy, then give up.
  const onAudioError = () => {
    const a = audioRef.current;
    if (!a || !current) return;
    if (!triedProxy.current) {
      triedProxy.current = true;
      setPlayState('loading');
      a.src = current.proxyUrl;
      a.play().catch(() => setPlayState('error'));
    } else {
      setPlayState('error');
    }
  };

  // Cleanup on unmount: stop the stream (audio keeps downloading otherwise).
  useEffect(() => () => { const a = audioRef.current; if (a) { a.pause(); a.removeAttribute('src'); } }, []);

  return (
    <main className="flex-1 overflow-y-auto pb-24">
      <div className="mx-auto w-full max-w-[1760px] px-[clamp(16px,2.6vw,40px)] py-6">
        <div className="mb-1 flex items-center gap-2.5">
          <RadioTower size={22} className="text-accent" />
          <h1 className="text-[clamp(22px,3vw,32px)] font-extrabold tracking-tight text-ink">{t('radio.title')}</h1>
        </div>
        <p className="mb-5 text-[13px] text-ink/50">{t('radio.subtitle')}</p>

        <div className="relative mb-5 max-w-md">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('radio.search')}
            aria-label={t('radio.search')}
            className="h-[38px] w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] pl-9 pr-3 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none"
          />
        </div>

        {state === 'loading' ? (
          <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-accent" /></div>
        ) : state === 'error' || !filtered.length ? (
          <div className="rounded-2xl border border-white/[0.08] bg-panel/40 px-4 py-16 text-center text-[14px] text-ink-3">{t('radio.empty')}</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {filtered.map((s) => {
              const active = current?.id === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => (active ? stop() : play(s))}
                  className={clsx(
                    'lift group flex items-center gap-3 rounded-[14px] border bg-panel p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                    active ? 'border-accent/60 ring-1 ring-accent/40' : 'border-white/[0.08]'
                  )}
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-white/[0.05]">
                    {s.favicon ? (
                      <img src={s.favicon} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    ) : (
                      <RadioTower size={18} className="text-ink-3" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-ink">{s.name}</span>
                    <span className="block truncate font-mono text-[10px] text-ink-3">
                      {[s.country, s.codec, s.bitrate ? `${s.bitrate}k` : null].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors', active ? 'bg-accent text-[#06151a]' : 'bg-white/[0.06] text-ink-3 group-hover:text-accent')}>
                    {active ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky now-playing bar */}
      <audio ref={audioRef} onPlaying={() => setPlayState('playing')} onError={onAudioError} onStalled={() => setPlayState('loading')} />
      {current && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-panel/95 px-4 py-3 backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3">
            {playState === 'loading' ? <Loader2 size={18} className="shrink-0 animate-spin text-accent" /> : <Volume2 size={18} className="shrink-0 text-accent" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-bold text-ink">{current.name}</div>
              <div className="truncate font-mono text-[10px] text-ink-3">
                {playState === 'error' ? t('radio.error') : playState === 'playing' ? t('radio.playing') : t('radio.connecting')}
              </div>
            </div>
            <button onClick={stop} aria-label={t('radio.stop')} className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-ink/70 hover:border-rose-500/40 hover:text-rose-400">
              <Square size={14} fill="currentColor" />
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
