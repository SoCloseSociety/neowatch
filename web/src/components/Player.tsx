import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { clsx } from 'clsx';
import {
  X, Heart, Plus, Check, Maximize2, PictureInPicture2, ShieldCheck, Gauge, Subtitles,
  Volume2, Volume1, VolumeX, Play, Pause,
} from 'lucide-react';
import type { Channel } from '@/types';
import { HlsVideo, type PlaybackStatus } from './HlsVideo';
import { HealthBadge } from './ui';
import { categoryLabel } from '@/lib/format';
import { fetchNowNext, fmtTime, type NowNext } from '@/lib/epg';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer } from '@/store/playerStore';
import { useSettings } from '@/store/settingsStore';
import { useT } from '@/lib/i18n';

interface Track { name: string; lang?: string }

export function Player({ channel }: { channel: Channel }) {
  const close = usePlayer((s) => s.close);
  const addToMulti = usePlayer((s) => s.addToMulti);
  const inMulti = usePlayer((s) => s.isInMulti(channel.url));
  const toggleFavorite = useCatalog((s) => s.toggleFavorite);
  const isFavorite = useCatalog((s) => s.isFavorite(channel.url));
  const health = useCatalog((s) => s.health[channel.url] || 'unknown');
  const latency = useCatalog((s) => s.latency[channel.url]);
  const { defaultMuted, preferProxy, set: setSettings } = useSettings();

  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>('loading');
  const [levels, setLevels] = useState<{ height: number; bitrate: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [showQuality, setShowQuality] = useState(false);
  const [muted, setMuted] = useState(defaultMuted);
  const [volume, setVolume] = useState(1);
  const [paused, setPaused] = useState(false);
  const [epg, setEpg] = useState<NowNext | null>(null);
  // Audio languages + subtitles, when the stream carries multiple tracks.
  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [subTracks, setSubTracks] = useState<Track[]>([]);
  const [subTrack, setSubTrack] = useState(-1);
  const [showTracks, setShowTracks] = useState(false);
  const t = useT();
  const isYouTube = channel.kind === 'youtube';

  // Program guide (now/next) for this channel, if EPG data is loaded.
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

  // Sync volume + mute to the <video>, and mirror native play/pause into state
  // so our quick-action buttons stay correct even if the user uses the native bar.
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
      const next = Math.min(1, Math.max(0, +(vol + delta).toFixed(2)));
      if (next > 0 && muted) setMuted(false);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') close();
      else if (k === 'f') toggleFullscreen();
      else if (k === 'm') setMuted((m) => !m);
      else if (e.key === ' ' && !isYouTube) {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowUp' && !isYouTube) {
        e.preventDefault();
        bumpVolume(0.1);
      } else if (e.key === 'ArrowDown' && !isYouTube) {
        e.preventDefault();
        bumpVolume(-0.1);
      }
    };
    // Capture phase so the player's volume/seek/escape keys win over the global
    // spatial-navigation handler (which then only sees the keys we don't handle).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, isYouTube, muted]);

  const onHls = (hls: Hls | null) => {
    hlsRef.current = hls;
    // Reset stale level/track state whenever the instance is torn down or replaced.
    setLevels([]); setCurrentLevel(-1);
    setAudioTracks([]); setAudioTrack(-1); setSubTracks([]); setSubTrack(-1);
    if (!hls) return;
    const syncTracks = () => {
      setAudioTracks((hls.audioTracks || []).map((a: any) => ({ name: a.name, lang: a.lang })));
      setAudioTrack(hls.audioTrack);
      setSubTracks((hls.subtitleTracks || []).map((s: any) => ({ name: s.name, lang: s.lang })));
      setSubTrack(hls.subtitleTrack);
    };
    hls.on('hlsManifestParsed' as any, () => {
      setLevels(hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate })));
      syncTracks();
    });
    hls.on('hlsLevelSwitched' as any, (_e: unknown, data: { level: number }) => setCurrentLevel(data.level));
    hls.on('hlsAudioTracksUpdated' as any, syncTracks);
    hls.on('hlsSubtitleTracksUpdated' as any, syncTracks);
    hls.on('hlsAudioTrackSwitched' as any, (_e: unknown, d: { id: number }) => setAudioTrack(d.id));
    hls.on('hlsSubtitleTrackSwitch' as any, (_e: unknown, d: { id: number }) => setSubTrack(d.id));
  };

  const pickAudio = (id: number) => { if (hlsRef.current) hlsRef.current.audioTrack = id; setAudioTrack(id); };
  const pickSub = (id: number) => { if (hlsRef.current) hlsRef.current.subtitleTrack = id; setSubTrack(id); };
  const hasTracks = audioTracks.length > 1 || subTracks.length > 0;

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => {});
  };

  const enterPip = async () => {
    const video = containerRef.current?.querySelector('video');
    if (video && document.pictureInPictureEnabled) {
      try {
        await (video as HTMLVideoElement).requestPictureInPicture();
      } catch {
        /* ignored */
      }
    }
  };

  const pickLevel = (idx: number) => {
    if (hlsRef.current) hlsRef.current.currentLevel = idx;
    setCurrentLevel(idx);
    setShowQuality(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm animate-fade-in">
      {/* Header */}
      <div className="glass flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-xl">{channel.flag || '🌐'}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-bold text-ink">{channel.name}</h2>
            <HealthBadge status={health} latency={latency} />
          </div>
          <p className="truncate text-[11px] text-ink/40">
            {[channel.countryName, channel.categories.map(categoryLabel).slice(0, 2).join(' · ')]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button onClick={close} className="ml-auto rounded-lg p-2 text-ink/60 hover:bg-white/5 hover:text-ink" aria-label="Fermer">
          <X size={18} />
        </button>
      </div>

      {/* Program guide (now / next) */}
      {epg?.now && (
        <div className="flex items-center gap-3 border-b border-white/[0.06] bg-black/40 px-4 py-1.5 text-[11px]">
          <span className="flex items-center gap-1.5 font-mono text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-emerald-400" /> {t('player.onNow')}
          </span>
          <span className="truncate text-ink/80">{epg.now.title}</span>
          {epg.now.stop && <span className="shrink-0 text-ink/40">→ {fmtTime(epg.now.stop)}</span>}
          {epg.next && (
            <span className="ml-auto hidden shrink-0 truncate text-ink/40 sm:block">
              {t('player.nextUp')} : {epg.next.title} ({fmtTime(epg.next.start)})
            </span>
          )}
        </div>
      )}

      {/* Video */}
      <div ref={containerRef} className="relative flex-1 bg-black">
        <HlsVideo channel={channel} muted={muted} controls onStatus={setStatus} onHls={onHls} />
      </div>

      {/* Control bar */}
      <div className="glass flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-3 py-2.5 sm:px-4">
        {!isYouTube && (
          <>
            <CtrlBtn onClick={togglePlay} title={paused ? t('player.play') : t('player.pause')}>
              {paused ? <Play size={16} /> : <Pause size={16} />}
            </CtrlBtn>
            <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2">
              <button onClick={() => setMuted((m) => !m)} title={t('player.mute')} aria-label={t('player.mute')} className="text-ink/70 hover:text-accent">
                {muted || volume === 0 ? <VolumeX size={16} /> : volume < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
              </button>
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
                className="h-1 w-16 cursor-pointer accent-[rgb(var(--accent))] sm:w-24"
                aria-label={t('player.volume')}
              />
            </div>
            <span className="hidden w-8 font-mono text-[10px] tabular-nums text-ink/40 sm:inline">{Math.round((muted ? 0 : volume) * 100)}%</span>
          </>
        )}
        <CtrlBtn active={isFavorite} onClick={() => toggleFavorite(channel)} title={t('common.favorite')}>
          <Heart size={16} fill={isFavorite ? 'currentColor' : 'none'} />
        </CtrlBtn>
        <CtrlBtn active={inMulti} onClick={() => addToMulti(channel)} title={t('common.addMulti')}>
          {inMulti ? <Check size={16} /> : <Plus size={16} />}
        </CtrlBtn>
        <CtrlBtn active={preferProxy} onClick={() => setSettings({ preferProxy: !preferProxy })} title={t('player.proxyTitle')}>
          <ShieldCheck size={16} />
        </CtrlBtn>

        <div className="relative">
          <CtrlBtn active={showQuality} onClick={() => setShowQuality((v) => !v)} title={t('player.quality')} disabled={!levels.length}>
            <Gauge size={16} />
          </CtrlBtn>
          {showQuality && levels.length > 0 && (
            <div className="absolute bottom-11 left-0 max-h-64 w-24 overflow-y-auto rounded-lg border border-white/10 bg-panel shadow-xl sm:w-32">
              <button
                onClick={() => pickLevel(-1)}
                className={clsx('block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/5', currentLevel === -1 && 'text-accent')}
              >
                Auto (ABR)
              </button>
              {levels.map((l, i) => (
                <button
                  key={i}
                  onClick={() => pickLevel(i)}
                  className={clsx('block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/5', currentLevel === i && 'text-accent')}
                >
                  {l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}k`}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Audio language + subtitles -- shown only when the stream carries tracks */}
        {hasTracks && (
          <div className="relative">
            <CtrlBtn active={showTracks} onClick={() => setShowTracks((v) => !v)} title={`${t('player.audioTrack')} / ${t('player.subtitles')}`}>
              <Subtitles size={16} />
            </CtrlBtn>
            {showTracks && (
              <div className="absolute bottom-11 left-0 max-h-72 w-44 overflow-y-auto rounded-lg border border-white/10 bg-panel py-1 shadow-xl">
                {audioTracks.length > 1 && (
                  <>
                    <div className="px-3 py-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{t('player.audioTrack')}</div>
                    {audioTracks.map((a, i) => (
                      <button key={`a${i}`} onClick={() => pickAudio(i)} className={clsx('block w-full truncate px-3 py-1.5 text-left text-[11px] hover:bg-white/5', audioTrack === i && 'text-accent')}>
                        {(a.lang || a.name || `Audio ${i + 1}`)}{a.lang && a.name ? ` · ${a.name}` : ''}
                      </button>
                    ))}
                  </>
                )}
                <div className="px-3 py-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{t('player.subtitles')}</div>
                <button onClick={() => pickSub(-1)} className={clsx('block w-full px-3 py-1.5 text-left text-[11px] hover:bg-white/5', subTrack === -1 && 'text-accent')}>{t('player.off')}</button>
                {subTracks.map((s, i) => (
                  <button key={`s${i}`} onClick={() => pickSub(i)} className={clsx('block w-full truncate px-3 py-1.5 text-left text-[11px] hover:bg-white/5', subTrack === i && 'text-accent')}>
                    {(s.lang || s.name || `ST ${i + 1}`)}{s.lang && s.name ? ` · ${s.name}` : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-ink/40">{status === 'playing' ? t('player.live') : status === 'loading' ? t('player.loading') : t('player.error')}</span>
          <CtrlBtn onClick={enterPip} title={t('player.pip')}>
            <PictureInPicture2 size={16} />
          </CtrlBtn>
          <CtrlBtn onClick={toggleFullscreen} title={t('player.fullscreen')}>
            <Maximize2 size={16} />
          </CtrlBtn>
        </div>
      </div>
    </div>
  );
}

function CtrlBtn({
  children,
  onClick,
  active,
  title,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={clsx(
        'flex h-9 w-9 items-center justify-center rounded-lg border transition-colors',
        disabled && 'cursor-not-allowed opacity-30',
        active ? 'border-accent/40 bg-accent/15 text-accent' : 'border-white/10 bg-white/[0.03] text-ink/70 hover:border-accent/30 hover:text-accent'
      )}
    >
      {children}
    </button>
  );
}
