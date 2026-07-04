import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { clsx } from 'clsx';
import { Loader2, WifiOff, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Channel } from '@/types';
import { getYouTubeId, youTubeEmbed } from '@/lib/format';
import { useSettings } from '@/store/settingsStore';
import { useT } from '@/lib/i18n';

interface Source {
  url: string;
  proxyUrl: string | null;
  userAgent?: string | null;
  referrer?: string | null;
}

export type PlaybackStatus = 'loading' | 'playing' | 'error';
type Phase = 'direct' | 'proxy' | 'retry' | 'stall';

interface Props {
  channel: Channel;
  muted: boolean;
  controls?: boolean;
  className?: string;
  // Mosaic tiles: cap quality to the (small) tile size + shrink buffers, so many
  // streams can decode at once without choking CPU/RAM/bandwidth.
  lowRes?: boolean;
  // Mosaic tiles: start on the (HTTPS) proxy -- avoids mixed-content blocks on HTTP
  // streams and a doomed direct attempt across many tiles.
  startProxy?: boolean;
  // Mosaic tiles: stagger initial load so N streams don't hit the network at once.
  startDelayMs?: number;
  onStatus?: (s: PlaybackStatus) => void;
  onHls?: (hls: Hls | null) => void;
}

// Tuned for resilient playback of flaky public streams: deep buffers, generous
// retries/timeouts, gap-jumping (nudge), and ABR. Latency is traded for stability.
const HLS_CONFIG: Partial<Hls['config']> = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 60,
  maxBufferLength: 30,
  maxMaxBufferLength: 120,
  maxBufferHole: 0.5,
  highBufferWatchdogPeriod: 2,
  nudgeOffset: 0.2,
  nudgeMaxRetry: 8,
  manifestLoadingTimeOut: 15000,
  manifestLoadingMaxRetry: 4,
  manifestLoadingRetryDelay: 1000,
  levelLoadingTimeOut: 15000,
  levelLoadingMaxRetry: 4,
  levelLoadingRetryDelay: 1000,
  fragLoadingTimeOut: 30000,
  fragLoadingMaxRetry: 8,
  fragLoadingRetryDelay: 1000,
  appendErrorMaxRetry: 5,
  startLevel: -1,
  startFragPrefetch: true,
};

const MAX_PROXY_RETRIES = 2;
const PHASE_KEY: Record<Phase, string> = {
  direct: 'player.connecting',
  proxy: 'player.viaProxy',
  retry: 'player.retrying',
  stall: 'player.buffering',
};

export function HlsVideo({ channel, muted, controls = true, className, lowRes = false, startProxy = false, startDelayMs = 0, onStatus, onHls }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const statusRef = useRef<PlaybackStatus>('loading');
  const [status, setStatus] = useState<PlaybackStatus>('loading');
  const [phase, setPhase] = useState<Phase>('direct');
  const [reloadKey, setReloadKey] = useState(0);
  const [forcedProxy, setForcedProxy] = useState(false);
  const [srcIdx, setSrcIdx] = useState(0);
  const preferProxy = useSettings((s) => s.preferProxy);
  const t = useT();
  const ytId = channel.kind === 'youtube' ? getYouTubeId(channel.url) : null;

  // Primary feed + the channel's alternate feeds (tried in order on failure).
  const sources = useMemo<Source[]>(() => {
    const primary: Source = { url: channel.url, proxyUrl: channel.proxyUrl ?? null, userAgent: channel.userAgent, referrer: channel.referrer };
    return [primary, ...(channel.alternates || [])].filter((s) => s.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.url]);

  useEffect(() => {
    statusRef.current = status;
    onStatus?.(status);
  }, [status, onStatus]);

  // Reset feed index + one-time "force proxy" when the channel changes.
  useEffect(() => {
    setForcedProxy(false);
    setSrcIdx(0);
  }, [channel.url]);

  useEffect(() => {
    if (ytId) return; // YouTube handled via iframe below
    const video = videoRef.current;
    if (!video) return;

    if (channel.kind === 'dash') {
      setStatus('error');
      return;
    }

    const source = sources[srcIdx];
    if (!source) {
      setStatus('error');
      return;
    }
    // Most public streams are HLS even without a .m3u8 extension (.php/.htm,
    // path markers, extension-less). Use hls.js unless it's obviously a
    // progressive file (mp4/webm/...) which <video> plays natively.
    const progressive = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|mp3|aac)(\?|$)/i.test(source.url);
    const useHls = Hls.isSupported() && !progressive;

    let destroyed = false;
    // Start on the (HTTPS) proxy when: the stream needs custom headers, OR it's an
    // HTTP stream on our HTTPS page (mixed-content -> browser blocks the direct load
    // outright, so skip the doomed attempt), OR proxy is forced (settings/tile). Plain
    // HTTPS streams play direct -- keeps the proxy/VPS unburdened across many tiles.
    const isMixed = typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//i.test(source.url);
    const needsProxyHeaders = !!(source.userAgent || source.referrer);
    const wantProxy = preferProxy || forcedProxy || startProxy;
    let mode: 'direct' | 'proxy' = needsProxyHeaders || isMixed || (wantProxy && !!source.proxyUrl) ? 'proxy' : 'direct';
    let proxyRetries = 0;
    let mediaRecover = 0;
    let stalls = 0;
    let played = false;
    let lastProgressAt = Date.now();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    // If a stream buffers with NO forward progress for this long, stop waiting
    // and escalate (proxy -> alternate feed -> error) instead of spinning forever.
    const DEAD_AIR_MS = 20000;

    const clearTimers = () => {
      clearTimeout(watchdog);
      clearTimeout(stallTimer);
    };
    const destroyHls = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
        onHls?.(null);
      }
    };

    // Escalate direct -> proxy, then retry the proxy a few times, then fail.
    const fail = () => {
      if (destroyed) return;
      clearTimers();
      // Without a signed proxy URL, proxy escalation/retries can only insta-fail
      // (null src) -- skip straight to the next alternate feed instead of burning
      // MAX_PROXY_RETRIES microtask-fast on a doomed mode.
      const canProxy = !!source.proxyUrl;
      if (mode === 'direct' && canProxy) {
        mode = 'proxy';
        queueMicrotask(() => !destroyed && load());
        return;
      }
      if (canProxy && proxyRetries < MAX_PROXY_RETRIES) {
        proxyRetries++;
        if (!destroyed) {
          setStatus('loading');
          setPhase('retry');
        }
        setTimeout(() => !destroyed && load(), 700 * proxyRetries);
        return;
      }
      // This feed is exhausted -> try the channel's next alternate feed.
      if (srcIdx < sources.length - 1) {
        destroyHls();
        setStatus('loading');
        setPhase('retry');
        setSrcIdx(srcIdx + 1); // re-runs the effect on the next source
        return;
      }
      setStatus('error');
      destroyHls();
    };

    const armWatchdog = () => {
      clearTimeout(watchdog);
      // Direct gets a short leash; proxy gets longer (server fetch + segments).
      watchdog = setTimeout(() => {
        if (!destroyed && !played) fail();
      }, mode === 'direct' ? 9000 : 15000);
    };

    // Recurring buffer-stall recovery: nudge forward + kick the loader, and
    // re-check every few seconds. Escalates (proxy -> alternate -> error) if the
    // stream never started OR if it stalls with zero forward progress for too
    // long -- this is what prevents the infinite "Mise en mémoire tampon".
    const onStall = () => {
      if (destroyed) return;
      stalls++;
      try {
        if (hlsRef.current) hlsRef.current.startLoad();
        if (video.buffered.length) {
          const end = video.buffered.end(video.buffered.length - 1);
          if (end - video.currentTime > 0.1) video.currentTime = Math.max(video.currentTime, end - 0.3);
        }
        video.play().catch(() => {});
      } catch {
        /* ignore */
      }
      const deadAir = Date.now() - lastProgressAt;
      // Hard escalate after prolonged dead air, even if it had started playing.
      if (deadAir > DEAD_AIR_MS) return fail();
      // Never started: give up sooner.
      if (!played && stalls >= 3) return fail();
      // Otherwise keep trying to recover in place.
      clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, 4000);
    };

    const load = () => {
      destroyHls();
      clearTimers();
      played = false;
      mediaRecover = 0;
      setStatus('loading');
      setPhase(mode === 'proxy' ? (proxyRetries ? 'retry' : 'proxy') : 'direct');
      armWatchdog();

      const src = mode === 'proxy' ? source.proxyUrl : source.url;
      if (!src) {
        // No signed proxy URL for this source -> escalate (advance / fail).
        return fail();
      }

      if (useHls) {
        const hls = new Hls(lowRes
          ? { ...HLS_CONFIG, capLevelToPlayerSize: true, maxBufferLength: 18, maxMaxBufferLength: 40, backBufferLength: 0 }
          : HLS_CONFIG);
        hlsRef.current = hls;
        onHls?.(hls);
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!destroyed) video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (destroyed) return;
          // Non-fatal buffer stall -> recover in place.
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            onStall();
            return;
          }
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (mediaRecover === 0) {
              mediaRecover++;
              hls.recoverMediaError();
              return;
            }
            if (mediaRecover === 1) {
              mediaRecover++;
              try {
                hls.swapAudioCodec();
              } catch {
                /* not always available */
              }
              hls.recoverMediaError();
              return;
            }
          }
          fail();
        });
      } else {
        // Native playback (Safari HLS, or progressive sources).
        video.src = src;
        video.play().catch(() => {});
        video.onerror = fail;
      }
    };

    const onPlaying = () => {
      if (destroyed) return;
      played = true;
      stalls = 0;
      lastProgressAt = Date.now();
      clearTimers();
      setStatus('playing');
    };
    const onWaiting = () => {
      if (destroyed) return;
      setStatus('loading');
      setPhase('stall');
      clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, 6000);
    };
    const onProgress = () => {
      stalls = 0;
      lastProgressAt = Date.now();
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('timeupdate', onProgress);

    // Stagger mosaic tiles so N streams don't hammer the network/proxy at once.
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    if (startDelayMs > 0) startTimer = setTimeout(() => { if (!destroyed) load(); }, startDelayMs);
    else load();

    return () => {
      destroyed = true;
      if (startTimer) clearTimeout(startTimer);
      clearTimers();
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('timeupdate', onProgress);
      destroyHls();
      // Native path cleanup: detach handler + stop loading the old source.
      video.onerror = null;
      if (video.src) {
        video.removeAttribute('src');
        try { video.load(); } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.url, preferProxy, forcedProxy, reloadKey, srcIdx]);

  // Auto-reconnect only if playback had actually failed (don't disrupt a
  // healthy stream on a transient connectivity flap).
  useEffect(() => {
    const onOnline = () => {
      if (statusRef.current === 'error') {
        setSrcIdx(0);
        setReloadKey((k) => k + 1);
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // YouTube embeds keep their document + media session alive after the <iframe> is
  // removed from the DOM (a real leak across channel switches / player open-close).
  // Blank the src on teardown so the embed releases its document.
  const ytFrameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => () => {
    const f = ytFrameRef.current;
    if (f) { try { f.src = 'about:blank'; } catch { /* */ } }
  }, [ytId]);

  const retry = () => {
    setStatus('loading');
    setSrcIdx(0);
    setReloadKey((k) => k + 1);
  };
  const retryViaProxy = () => {
    setStatus('loading');
    setForcedProxy(true);
    setSrcIdx(0);
    setReloadKey((k) => k + 1);
  };

  if (ytId) {
    return (
      <iframe
        ref={ytFrameRef}
        src={youTubeEmbed(ytId)}
        className={clsx('h-full w-full border-0 bg-black', className)}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title={channel.name}
      />
    );
  }

  return (
    <div className={clsx('relative h-full w-full bg-black', className)}>
      <video ref={videoRef} muted={muted} controls={controls} playsInline autoPlay className="h-full w-full bg-black" />

      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40">
          <Loader2 className="animate-spin text-accent" size={32} />
          <span className="font-mono text-[10px] tracking-wider text-ink/50">{t(PHASE_KEY[phase])}</span>
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 px-4 text-center">
          <WifiOff className="text-rose-400" size={28} />
          <div>
            <p className="text-xs font-mono text-rose-300">{t('player.interrupted')}</p>
            <p className="mx-auto mt-1 max-w-xs text-[10px] text-ink/50">
              {t('player.errorHint')}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button onClick={retry} className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-ink/80 hover:border-accent/40 hover:text-accent">
              <RefreshCw size={13} /> {t('player.retry')}
            </button>
            {!forcedProxy && channel.kind !== 'dash' && !!channel.proxyUrl && (
              <button onClick={retryViaProxy} className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-[11px] text-accent hover:bg-accent/20">
                <ShieldCheck size={13} /> {t('player.forceProxy')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
