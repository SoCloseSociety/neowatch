import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type Hls from 'hls.js';
import { RadioTower, Search, Play, Square, Volume2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { AdBanner } from './AdBanner';
import { countryLabel } from './ChannelCard';
import { Button, EmptyState, Spinner } from './ui';
import { imgSrc } from '@/lib/img';

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

type PlayState = 'idle' | 'loading' | 'playing' | 'stalled' | 'error';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
const isHlsUrl = (u: string) => /\.m3u8(\?|$)/i.test(u) || /\/hls\//i.test(u);
/** A station that does not start within this time is tried another way, then reported. */
const START_TIMEOUT_MS = 12_000;
/** Playing but no audio progress for this long: reconnect once. */
const STALL_MS = 15_000;

// Internet radio (radio-browser.info directory). Stations play in a sticky bar:
// HTTPS streams play direct, HTTP streams through the signed relay (mixed content),
// with a direct -> relay fallback. HLS stations (.m3u8) use hls.js, loaded only
// when needed (Safari plays them natively). A watchdog turns a silent start or a
// frozen stream into a visible state instead of an endless spinner.
export function Radios() {
  const t = useT();
  const [stations, setStations] = useState<Station[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [q, setQ] = useState('');
  const [current, setCurrent] = useState<Station | null>(null);
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [noIcon, setNoIcon] = useState<Set<string>>(new Set()); // favicons that failed (404, blocked)
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const triedRelay = useRef(false);
  const reconnected = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgress = useRef(0);
  const session = useRef(0); // bumps on every play/stop: late callbacks of an old station are ignored
  const currentRef = useRef<Station | null>(null);

  useEffect(() => {
    let alive = true;
    setState('loading');
    api.get<{ items: Station[] }>('/radios?limit=200')
      .then((r) => { if (alive) { setStations(r.items || []); setState((r.items || []).length ? 'ready' : 'error'); } })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [reload]);

  const filtered = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return stations;
    const tokens = n.split(/\s+/).filter(Boolean);
    return stations.filter((s) => {
      const hay = norm(`${s.name} ${s.country || ''} ${s.tags.join(' ')}`);
      return tokens.every((tk) => hay.includes(tk));
    });
  }, [stations, q]);

  const clearStartTimer = () => {
    if (startTimer.current) clearTimeout(startTimer.current);
    startTimer.current = null;
  };

  const teardown = useCallback(() => {
    clearStartTimer();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      try { a.load(); } catch { /* detached */ }
    }
  }, []);

  // Load one source into the <audio>: native for files and Safari HLS, hls.js otherwise.
  const load = useCallback(async (s: Station, relay: boolean) => {
    const a = audioRef.current;
    if (!a) return;
    const my = session.current;
    teardown();
    const src = relay || /^http:\/\//i.test(s.url) ? s.proxyUrl : s.url;
    setPlayState('loading');
    lastProgress.current = Date.now();
    startTimer.current = setTimeout(() => {
      if (session.current === my) onFailRef.current();
    }, START_TIMEOUT_MS);
    if (isHlsUrl(s.url) && !a.canPlayType('application/vnd.apple.mpegurl')) {
      try {
        const { default: HlsCtor } = await import('hls.js');
        if (session.current !== my) return;
        if (!HlsCtor.isSupported()) throw new Error('no MSE');
        const hls = new HlsCtor({ enableWorker: true, lowLatencyMode: false, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
        hlsRef.current = hls;
        hls.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (session.current === my && data.fatal) onFailRef.current();
        });
        hls.loadSource(src);
        hls.attachMedia(a);
      } catch {
        if (session.current === my) onFailRef.current();
        return;
      }
    } else {
      a.src = src;
    }
    a.play().catch(() => { /* the error/timeout path decides */ });
  }, [teardown]);

  // Direct failed or never started -> once through the relay, then say so.
  const onFail = () => {
    const s = currentRef.current;
    if (!s) return;
    if (!triedRelay.current) {
      triedRelay.current = true;
      void load(s, true);
    } else {
      teardown();
      setPlayState('error');
    }
  };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  const play = (s: Station) => {
    session.current += 1;
    triedRelay.current = /^http:\/\//i.test(s.url); // http starts on the relay already
    reconnected.current = false;
    currentRef.current = s;
    setCurrent(s);
    void load(s, false);
  };

  const stop = () => {
    session.current += 1;
    teardown();
    currentRef.current = null;
    setCurrent(null);
    setPlayState('idle');
  };

  // Watchdog: playing but no progress for STALL_MS -> one reconnect, then the error state.
  useEffect(() => {
    if (playState !== 'playing' && playState !== 'stalled') return;
    const iv = setInterval(() => {
      const a = audioRef.current;
      const s = currentRef.current;
      if (!a || !s || a.paused) return;
      if (Date.now() - lastProgress.current < STALL_MS) return;
      if (!reconnected.current) {
        reconnected.current = true;
        void load(s, triedRelay.current);
      } else {
        teardown();
        setPlayState('error');
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [playState, load, teardown]);

  // Leaving the page stops the stream (audio keeps downloading otherwise).
  useEffect(() => () => {
    session.current += 1;
    teardown();
  }, [teardown]);

  const status =
    playState === 'error' ? t('radio.error')
      : playState === 'playing' ? t('radio.playing')
        : playState === 'stalled' ? t('pages.radio.stalled')
          : t('radio.connecting');

  return (
    <main className={clsx('flex-1 overflow-y-auto', current && 'pb-28')}>
      <div className="mx-auto w-full max-w-[1760px] px-[var(--gouttiere)] pb-12 pt-5">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 flex items-center gap-2.5 text-titre font-semibold text-ink">
              <RadioTower size={26} className="text-ink-2" aria-hidden="true" /> {t('radio.title')}
            </h1>
            <p className="mb-0 mt-1 text-sous text-ink-2">{t('radio.subtitle')}</p>
          </div>
          <div className="relative w-full sm:w-80">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden="true" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('pages.radio.search')}
              aria-label={t('pages.radio.search')}
              className="field-input"
            />
          </div>
        </div>

        <AdBanner />

        {state === 'loading' ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : state === 'error' ? (
          <EmptyState icon={<RadioTower size={32} />} title={t('pages.radio.errorTitle')} body={t('pages.radio.errorBody')} action={{ label: t('empty.tryAgain'), onClick: () => setReload((n) => n + 1), variant: 'primary' }} />
        ) : !filtered.length ? (
          <EmptyState icon={<Search size={32} />} title={t('radio.empty')} body={t('pages.radio.emptyBody')} action={{ label: t('empty.clearSearch'), onClick: () => setQ(''), variant: 'primary' }} />
        ) : (
          <>
            <p className="meta mb-3">{t.n('count.stations', filtered.length)}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {filtered.map((s) => {
                const active = current?.id === s.id;
                const label = active ? `${t('radio.stop')} · ${s.name}` : s.name;
                return (
                  <button
                    key={s.id}
                    type="button"
                    data-card=""
                    data-key={s.url}
                    onClick={() => (active ? stop() : play(s))}
                    aria-pressed={active}
                    aria-label={label}
                    className={clsx(
                      'lift group flex items-center gap-3 rounded-card border bg-card p-3 text-left',
                      active ? 'border-line-strong bg-[var(--bg-3)]' : 'border-line'
                    )}
                  >
                    <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-field bg-mini" aria-hidden="true">
                      {s.favicon && !noIcon.has(s.id) ? (
                        <img src={imgSrc(s.favicon)} alt="" width={48} height={48} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-full w-full object-contain"
                          onError={() => setNoIcon((x) => new Set(x).add(s.id))} />
                      ) : (
                        <RadioTower size={18} className="text-ink-3" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sous font-semibold text-ink" translate="no">{s.name}</span>
                      <span className="meta block truncate" translate="no">{[countryLabel({ country: s.countryCode, countryName: s.country }, t.lang), s.tags[0]].filter(Boolean).join(' · ') || ' '}</span>
                    </span>
                    <span className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-pill border', active ? 'border-line-strong bg-ink text-surface' : 'border-line text-ink-2')} aria-hidden="true">
                      {active ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Now-playing bar */}
      <audio
        ref={audioRef}
        preload="none"
        onPlaying={() => { clearStartTimer(); lastProgress.current = Date.now(); setPlayState('playing'); }}
        onTimeUpdate={() => { lastProgress.current = Date.now(); setPlayState((p) => (p === 'stalled' ? 'playing' : p)); }}
        onWaiting={() => setPlayState((p) => (p === 'playing' ? 'stalled' : p))}
        onStalled={() => setPlayState((p) => (p === 'playing' ? 'stalled' : p))}
        onError={() => { if (!hlsRef.current && currentRef.current) onFailRef.current(); }}
      />
      {current && (
        <div className="glass fixed inset-x-0 bottom-[var(--dock-h)] z-40 border-x-0 border-b-0 px-[var(--gouttiere)] py-3 md:bottom-0 [:root[data-tv]_&]:bottom-0">
          <div className="mx-auto flex w-full max-w-[1100px] items-center gap-3" role="status" aria-live="polite">
            {playState === 'loading' || playState === 'stalled' ? <Spinner className="shrink-0" /> : <Volume2 size={18} className="shrink-0 text-ink-2" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sous font-semibold text-ink" translate="no">{current.name}</div>
              <div className={clsx('truncate text-meta', playState === 'error' ? 'text-red' : 'text-ink-3')}>{status}</div>
            </div>
            {playState === 'error' && (
              <Button onClick={() => play(current)} aria-label={t('empty.tryAgain')}>{t('empty.tryAgain')}</Button>
            )}
            <Button iconOnly onClick={stop} aria-label={t('radio.stop')} title={t('radio.stop')} icon={<Square size={14} fill="currentColor" aria-hidden="true" />} />
          </div>
        </div>
      )}
    </main>
  );
}
