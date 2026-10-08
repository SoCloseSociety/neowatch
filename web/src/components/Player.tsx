import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type Hls from 'hls.js';
import { clsx } from 'clsx';
import {
  X, Heart, Plus, Check, Maximize2, PictureInPicture2, Route, Gauge, Subtitles,
  Volume2, Volume1, VolumeX, Play, Pause, SkipBack, SkipForward,
} from 'lucide-react';
import type { Channel } from '@/types';
import { HlsVideo, type PlaybackStatus } from './HlsVideo';
import { HealthPill, LivePill, Pill, Spinner } from './ui';
import { countryLabel } from './ChannelCard';
import { categoryLabel } from '@/lib/format';
import { fetchNowNext, type NowNext } from '@/lib/epg';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer, MAX_TILES } from '@/store/playerStore';
import { useSettings } from '@/store/settingsStore';
import { toast } from '@/store/uiStore';
import { useT, fmtTime } from '@/lib/i18n';
import { isTV } from '@/lib/device';
import { navigateFromLayers } from '@/lib/spatialNav';

// The player (spec 2.5): a layer over everything (spatialNav pushes a history
// entry, takes focus, restores it to the launching card on Back). Top: close,
// LIVE · category · country, the channel name, now / next. Bottom: one row of
// controls. Zapping: Previous / Next channel in the list it was opened from
// (buttons, PageUp / PageDown, ChannelUp / ChannelDown).

interface Track { name: string; lang?: string }

const isTyping = (el: Element | null) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
const ZAP_NEXT = new Set(['PageDown', 'ChannelDown', 'MediaTrackNext']);
const ZAP_PREV = new Set(['PageUp', 'ChannelUp', 'MediaTrackPrevious']);
// Tizen / webOS channel keys (keyCode only on some remotes).
const ZAP_NEXT_CODES = new Set([428]);
const ZAP_PREV_CODES = new Set([427]);

export function Player({ channel }: { channel: Channel }) {
  const close = usePlayer((s) => s.close);
  const ready = usePlayer((s) => s.currentReady);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const canZap = usePlayer((s) => s.queue.length > 1);
  const addToMulti = usePlayer((s) => s.addToMulti);
  const inMulti = usePlayer((s) => s.isInMulti(channel.url));
  const toggleFavorite = useCatalog((s) => s.toggleFavorite);
  const isFavorite = useCatalog((s) => s.isFavorite(channel.url));
  const health = useCatalog((s) => s.health[channel.url] || (channel.online === true ? 'online' : channel.online === false ? 'offline' : 'unknown'));
  const { defaultMuted, preferProxy, set: setSettings } = useSettings();
  const navigate = useNavigate();
  const t = useT();

  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>('loading');
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [menu, setMenu] = useState<'quality' | 'tracks' | null>(null);
  const startMuted = usePlayer((s) => s.startMuted);
  const [muted, setMuted] = useState(defaultMuted || startMuted);
  const [volume, setVolume] = useState(1);
  const [paused, setPaused] = useState(false);
  const [epg, setEpg] = useState<NowNext | null>(null);
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [subTracks, setSubTracks] = useState<Track[]>([]);
  const [subTrack, setSubTrack] = useState(-1);
  const isYouTube = channel.kind === 'youtube';
  const tv = isTV();

  // Now / next for this channel, when the guide has it.
  useEffect(() => {
    setEpg(null);
    if (!channel.channelId) return;
    let alive = true;
    fetchNowNext([channel.channelId]).then((map) => {
      if (alive) setEpg(map[channel.channelId!] || null);
    });
    return () => {
      alive = false;
    };
  }, [channel.channelId]);

  const getVideo = () => containerRef.current?.querySelector('video') as HTMLVideoElement | null;

  // Volume + mute to the <video>; native play/pause mirrored into our buttons.
  useEffect(() => {
    const v = getVideo();
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, [volume, muted, status]);

  const togglePlay = () => {
    const v = getVideo();
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  };

  const bumpVolume = (delta: number) => {
    setVolume((vol) => {
      const n = Math.min(1, Math.max(0, +(vol + delta).toFixed(2)));
      if (n > 0) setMuted(false);
      return n;
    });
  };

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  };

  // Shortcuts. Capture phase so they win over spatial navigation, but never
  // while a menu or a field has the focus (its arrows are its own) and never
  // on TV for the arrows (the D-pad moves between the controls there).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (isTyping(active)) return;
      const inMenu = !!active?.closest('[role="menu"]');
      const k = e.key;
      if (ZAP_NEXT.has(k) || ZAP_NEXT_CODES.has(e.keyCode)) {
        e.preventDefault();
        next();
        return;
      }
      if (ZAP_PREV.has(k) || ZAP_PREV_CODES.has(e.keyCode)) {
        e.preventDefault();
        prev();
        return;
      }
      if (k === 'Escape' && menu) {
        e.preventDefault(); // close the menu first, the player on the next Back
        setMenu(null);
        return;
      }
      if (inMenu) return;
      const lower = k.toLowerCase();
      if (lower === 'f') toggleFullscreen();
      else if (lower === 'm') setMuted((m) => !m);
      else if ((k === ' ' || k === 'MediaPlayPause') && !isYouTube) {
        // Space on a focused button presses that button, except from the Android shell
        // (dispatched on document) and when nothing in particular has the focus.
        const onControl = !!active && active !== document.body && active.tagName === 'BUTTON' && e.target !== document;
        if (onControl && k === ' ') return;
        e.preventDefault();
        togglePlay();
      } else if (!tv && !isYouTube && (k === 'ArrowUp' || k === 'ArrowDown')) {
        const free = !active || active === document.body || active === containerRef.current || active.tagName === 'VIDEO';
        if (!free) return;
        e.preventDefault();
        bumpVolume(k === 'ArrowUp' ? 0.1 : -0.1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isYouTube, menu, next, prev, tv]);

  const onHls = (hls: Hls | null) => {
    hlsRef.current = hls;
    // Reset stale level / track state whenever the instance is torn down or replaced.
    setLevels([]); setCurrentLevel(-1);
    setAudioTracks([]); setAudioTrack(-1); setSubTracks([]); setSubTrack(-1);
    if (!hls) return;
    const syncTracks = () => {
      setAudioTracks((hls.audioTracks || []).map((a) => ({ name: a.name, lang: a.lang })));
      setAudioTrack(hls.audioTrack);
      setSubTracks((hls.subtitleTracks || []).map((s) => ({ name: s.name, lang: s.lang })));
      setSubTrack(hls.subtitleTrack);
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    hls.on('hlsManifestParsed' as any, () => {
      setLevels(hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate })));
      syncTracks();
    });
    hls.on('hlsLevelSwitched' as any, (_e: unknown, data: { level: number }) => setCurrentLevel(data.level));
    hls.on('hlsAudioTracksUpdated' as any, syncTracks);
    hls.on('hlsSubtitleTracksUpdated' as any, syncTracks);
    hls.on('hlsAudioTrackSwitched' as any, (_e: unknown, d: { id: number }) => setAudioTrack(d.id));
    hls.on('hlsSubtitleTrackSwitch' as any, (_e: unknown, d: { id: number }) => setSubTrack(d.id));
    /* eslint-enable @typescript-eslint/no-explicit-any */
  };

  const pickAudio = (id: number) => { if (hlsRef.current) hlsRef.current.audioTrack = id; setAudioTrack(id); setMenu(null); };
  const pickSub = (id: number) => { if (hlsRef.current) hlsRef.current.subtitleTrack = id; setSubTrack(id); setMenu(null); };
  const pickLevel = (idx: number) => { if (hlsRef.current) hlsRef.current.currentLevel = idx; setCurrentLevel(idx); setMenu(null); };
  const hasTracks = audioTracks.length > 1 || subTracks.length > 0;

  const enterPip = async () => {
    const video = getVideo();
    if (video && document.pictureInPictureEnabled) {
      try { await video.requestPictureInPicture(); } catch { /* refused */ }
    }
  };

  const onFavorite = () => {
    const was = isFavorite;
    toggleFavorite(channel);
    toast(t(was ? 'toast.removedList' : 'toast.addedList'), { ok: !was, undo: () => toggleFavorite(channel) });
  };
  const onMulti = () => {
    const n = usePlayer.getState().multi.length + (inMulti ? 0 : 1);
    addToMulti(channel);
    if (!inMulti) toast(t('toast.addedMulti', { n: Math.min(n, MAX_TILES), max: MAX_TILES }), { ok: true });
  };
  const openChannelPage = () => {
    navigateFromLayers(navigate, `/chaine/${encodeURIComponent(channel.canonicalId || channel.id)}`);
    close();
  };

  const country = countryLabel(channel, t.lang);
  const category = channel.categories[0] ? categoryLabel(channel.categories[0]) : null;
  const pipOk = typeof document !== 'undefined' && !!document.pictureInPictureEnabled && !isYouTube;

  return (
    <div
      ref={rootRef}
      data-layer="player"
      role="dialog"
      aria-modal="true"
      aria-label={channel.name}
      className="fixed inset-0 z-50 flex flex-col bg-[var(--e-fond)] animate-fade-in"
    >
      {/* Top: close, overline, name, now / next */}
      <div className="flex items-start gap-3 border-b border-line bg-[var(--bg-1)] px-[var(--gouttiere)] py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* What the screen shows, not the last check: no LIVE over the error overlay. */}
            {status === 'playing' ? <LivePill /> : status === 'error' ? <Pill tone="alert">{t('pill.unavailable')}</Pill> : <HealthPill status={health} />}
            {(category || country) && (
              <p className="overline truncate">
                {category}
                {category && country && ' · '}
                {country && <span translate="no">{country}</span>}
              </p>
            )}
          </div>
          <h2 translate="no" className="mt-1 truncate text-titre2 font-semibold text-ink">
            {channel.name}
          </h2>
          {epg?.now && (
            <p className="mt-0.5 truncate text-sous text-ink-2">
              {epg.now.stop ? t('player.untilTime', { title: epg.now.title, time: fmtTime(epg.now.stop) }) : <span translate="no">{epg.now.title}</span>}
            </p>
          )}
          {epg?.next && (
            <p className="meta mt-0.5 hidden truncate sm:block">
              {t('player.nextTime', { time: fmtTime(epg.next.start), title: epg.next.title })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {channel.id && (
            <button type="button" onClick={openChannelPage} className="btn btn-secondary hidden sm:inline-flex">
              {t('player.channelPage')}
            </button>
          )}
          <button type="button" onClick={close} aria-label={t('player.close')} title={t('player.close')} className="btn btn-secondary btn-icon">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Video */}
      <div ref={containerRef} tabIndex={-1} className="relative min-h-0 flex-1 bg-black outline-none">
        {ready ? (
          <HlsVideo
            channel={channel}
            muted={muted}
            // Native controls once the picture runs: while loading, the browser's own
            // spinner would sit on top of ours.
            controls={!tv && status === 'playing'}
            onStatus={setStatus}
            onHls={onHls}
            onNext={canZap ? next : undefined}
            // A forced mute (autoplay refused with sound) must stick: the effect
            // above writes `muted` back to the <video> on every status change.
            onMutedChange={setMuted}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-[var(--bg-1)] px-[var(--gouttiere)] py-2.5">
        {canZap && (
          <Ctrl onClick={prev} label={t('shell.prevChannel')}>
            <SkipBack size={18} />
          </Ctrl>
        )}
        {!isYouTube && (
          <Ctrl onClick={togglePlay} label={paused ? t('player.play') : t('player.pause')} autoFocus>
            {paused ? <Play size={18} /> : <Pause size={18} />}
          </Ctrl>
        )}
        {canZap && (
          <Ctrl onClick={next} label={t('player.nextChannel')}>
            <SkipForward size={18} />
          </Ctrl>
        )}
        {!isYouTube && (
          <div className="flex items-center gap-2">
            <Ctrl onClick={() => setMuted((m) => !m)} label={t('player.mute')} pressed={muted}>
              {muted || volume === 0 ? <VolumeX size={18} /> : volume < 0.5 ? <Volume1 size={18} /> : <Volume2 size={18} />}
            </Ctrl>
            {!tv && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  setMuted(v === 0);
                }}
                style={{ accentColor: 'var(--t1)' }}
                className="hidden h-1 w-24 cursor-pointer sm:block"
                aria-label={t('player.volume')}
                title={t('player.volume')}
              />
            )}
          </div>
        )}

        <Ctrl onClick={onFavorite} label={isFavorite ? t('home.inMyList') : t('home.myList')} pressed={isFavorite}>
          <Heart size={18} fill={isFavorite ? 'currentColor' : 'none'} />
        </Ctrl>
        <Ctrl onClick={onMulti} label={inMulti ? t('shell.inMulti') : t('common.addMulti')} pressed={inMulti}>
          {inMulti ? <Check size={18} /> : <Plus size={18} />}
        </Ctrl>

        <div className="ml-auto flex items-center gap-2">
          <Ctrl onClick={() => setSettings({ preferProxy: !preferProxy })} label={t('player.proxyTitle')} pressed={preferProxy}>
            <Route size={18} />
          </Ctrl>
          {levels.length > 1 && (
            <div className="relative">
              <Ctrl onClick={() => setMenu((m) => (m === 'quality' ? null : 'quality'))} label={t('player.quality')} pressed={menu === 'quality'} hasMenu>
                <Gauge size={18} />
              </Ctrl>
              {menu === 'quality' && (
                <Menu label={t('player.quality')}>
                  <MenuItem checked={currentLevel === -1} onSelect={() => pickLevel(-1)} autoFocus>
                    {t('shell.qualityAuto')}
                  </MenuItem>
                  {levels.map((l, i) => (
                    <MenuItem key={i} checked={currentLevel === i} onSelect={() => pickLevel(i)}>
                      {l.height ? <span translate="no">{`${l.height}p`}</span> : t('shell.qualityLevel', { n: i + 1 })}
                    </MenuItem>
                  ))}
                </Menu>
              )}
            </div>
          )}
          {hasTracks && (
            <div className="relative">
              <Ctrl onClick={() => setMenu((m) => (m === 'tracks' ? null : 'tracks'))} label={t('shell.audioSubs')} pressed={menu === 'tracks'} hasMenu>
                <Subtitles size={18} />
              </Ctrl>
              {menu === 'tracks' && (
                <Menu label={t('shell.audioSubs')}>
                  {audioTracks.length > 1 && (
                    <>
                      <p className="overline px-3 pb-1 pt-2">{t('player.audioTrack')}</p>
                      {audioTracks.map((a, i) => (
                        <MenuItem key={`a${i}`} checked={audioTrack === i} onSelect={() => pickAudio(i)} autoFocus={i === 0}>
                          <span translate="no">{trackName(a, t('shell.trackN', { n: i + 1 }))}</span>
                        </MenuItem>
                      ))}
                    </>
                  )}
                  <p className="overline px-3 pb-1 pt-2">{t('player.subtitles')}</p>
                  <MenuItem checked={subTrack === -1} onSelect={() => pickSub(-1)} autoFocus={audioTracks.length <= 1}>
                    {t('player.off')}
                  </MenuItem>
                  {subTracks.map((s, i) => (
                    <MenuItem key={`s${i}`} checked={subTrack === i} onSelect={() => pickSub(i)}>
                      <span translate="no">{trackName(s, t('shell.trackN', { n: i + 1 }))}</span>
                    </MenuItem>
                  ))}
                </Menu>
              )}
            </div>
          )}
          {pipOk && (
            <Ctrl onClick={enterPip} label={t('player.pip')}>
              <PictureInPicture2 size={18} />
            </Ctrl>
          )}
          {!tv && (
            <Ctrl onClick={toggleFullscreen} label={t('player.fullscreen')}>
              <Maximize2 size={18} />
            </Ctrl>
          )}
        </div>
      </div>
    </div>
  );
}

function trackName(tr: Track, fallback: string) {
  if (tr.lang && tr.name && tr.name.toLowerCase() !== tr.lang.toLowerCase()) return `${tr.lang} · ${tr.name}`;
  return tr.name || tr.lang || fallback;
}

function Ctrl({ children, onClick, label, pressed, autoFocus, hasMenu }: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  pressed?: boolean;
  autoFocus?: boolean;
  hasMenu?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={hasMenu ? undefined : pressed}
      aria-haspopup={hasMenu ? 'menu' : undefined}
      aria-expanded={hasMenu ? !!pressed : undefined}
      data-autofocus={autoFocus ? '' : undefined}
      className={clsx('btn btn-icon', pressed ? 'btn-secondary border-[var(--t2)] text-ink' : 'btn-secondary text-ink-2 hover:text-ink')}
    >
      <span aria-hidden="true" className="contents">
        {children}
      </span>
    </button>
  );
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus the checked (or first) item when the menu opens: the D-pad starts inside it.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') || ref.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
    el?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="absolute bottom-[calc(100%+8px)] right-0 z-10 max-h-72 min-w-[180px] overflow-y-auto rounded-card border border-line-strong bg-[var(--surface-menu)] p-1.5 shadow-menu"
    >
      {children}
    </div>
  );
}

function MenuItem({ children, checked, onSelect, autoFocus }: { children: ReactNode; checked: boolean; onSelect: () => void; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-autofocus={autoFocus ? '' : undefined}
      onClick={onSelect}
      className="flex min-h-[var(--cible-souris)] w-full items-center gap-3 rounded-field px-3 text-left text-sous text-ink hover:bg-[var(--bg-3)] focus-visible:bg-[var(--bg-3)]"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check size={16} aria-hidden="true" className="text-ink-2" />}
    </button>
  );
}
