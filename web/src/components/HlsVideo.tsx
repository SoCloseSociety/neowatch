import { useEffect, useRef, useState } from 'react';
import Hls, { type ErrorData } from 'hls.js';
import { clsx } from 'clsx';
import { WifiOff, RefreshCw, Volume2, Play } from 'lucide-react';
import type { Channel } from '@/types';
import { getYouTubeId, youTubeEmbed } from '@/lib/format';
import { freshChannel, needsFresh, proxyExp } from '@/lib/fresh';
import { useSettings } from '@/store/settingsStore';
import { useT } from '@/lib/i18n';
import { Button, Spinner } from '@/components/ui';

interface Source {
  url: string;
  proxyUrl: string | null;
  userAgent?: string | null;
  referrer?: string | null;
}

export type PlaybackStatus = 'loading' | 'playing' | 'error';
type Phase = 'direct' | 'proxy' | 'retry' | 'stall';
/** Why playback stopped: not answering (default), taken down (410), or this device cannot play HLS. */
type ErrKind = 'down' | 'removed' | 'unsupported';

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
  /** Error overlay "Next channel" (shown only when given). */
  onNext?: () => void;
  /** The browser blocked sound: playback went on muted (true), or the viewer turned sound back on (false). */
  onMutedChange?: (muted: boolean) => void;
}

const sourcesOf = (ch: Channel): Source[] =>
  [{ url: ch.url, proxyUrl: ch.proxyUrl ?? null, userAgent: ch.userAgent, referrer: ch.referrer }, ...(ch.alternates || [])].filter((s) => !!s.url);

// Codec trouble is the device's, not the network's: the relay cannot fix it.
const CODEC_DETAILS = new Set<string>([
  Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
  Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR,
  Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR,
]);
const httpCode = (d: ErrorData): number => Number(d.response?.code ?? d.networkDetails?.status ?? 0) || 0;

/** HTTP status of a relay link (native path: <video> errors carry no status). 0 = unknown. */
async function probeStatus(src: string): Promise<number> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 5000);
  try {
    const r = await fetch(src, { signal: ctl?.signal, cache: 'no-store' });
    try { await r.body?.cancel(); } catch { /* */ }
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
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

export function HlsVideo({ channel, muted, controls = true, className, lowRes = false, startProxy = false, startDelayMs = 0, onStatus, onHls, onNext, onMutedChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const statusRef = useRef<PlaybackStatus>('loading');
  const [status, setStatus] = useState<PlaybackStatus>('loading');
  const [phase, setPhase] = useState<Phase>('direct');
  const [errKind, setErrKind] = useState<ErrKind>('down');
  const [reloadKey, setReloadKey] = useState(0);
  const [forcedProxy, setForcedProxy] = useState(false);
  const [srcIdx, setSrcIdx] = useState(0);
  // Autoplay with sound was refused: we play muted and offer "Turn sound on".
  const [autoMuted, setAutoMuted] = useState(false);
  // Even muted autoplay was refused: one tap starts playback.
  const [needsTap, setNeedsTap] = useState(false);
  const tapRef = useRef<() => void>(() => {});
  const preferProxy = useSettings((s) => s.preferProxy);
  const t = useT();
  const ytId = channel.kind === 'youtube' ? getYouTubeId(channel.url) : null;
  const compact = lowRes; // mosaic tile: small overlay, no primary button

  // The channel as last resolved (fresh signed links), kept across retries and feed
  // switches. Not a url-keyed memo: a re-signed copy of the same url replaces it (PLAY-2).
  const chRef = useRef<Channel>(channel);
  const keyRef = useRef(channel.url); // the prop url this copy belongs to (a refresh may move .url)
  if (keyRef.current !== channel.url) {
    keyRef.current = channel.url;
    chRef.current = channel;
  } else if ((proxyExp(channel.proxyUrl) ?? 0) > (proxyExp(chRef.current.proxyUrl) ?? 0)) chRef.current = channel;

  useEffect(() => {
    statusRef.current = status;
    onStatus?.(status);
  }, [status, onStatus]);

  // Reset feed index, one-time "force proxy" and the sound prompts when the channel changes.
  useEffect(() => {
    setForcedProxy(false);
    setSrcIdx(0);
    setAutoMuted(false);
    setNeedsTap(false);
  }, [channel.url]);

  // The viewer muted or unmuted on purpose: the "Turn sound on" prompt is moot.
  useEffect(() => {
    setAutoMuted(false);
  }, [muted]);

  useEffect(() => {
    if (ytId) return; // YouTube handled via iframe below
    const video = videoRef.current;
    if (!video) return;

    if (channel.kind === 'dash') {
      setErrKind('down');
      setStatus('error');
      return;
    }

    let ch = chRef.current;
    let source: Source | undefined = sourcesOf(ch)[srcIdx];
    if (!source) {
      setErrKind('down');
      setStatus('error');
      return;
    }
    // Most public streams are HLS even without a .m3u8 extension (.php/.htm,
    // path markers, extension-less). Use hls.js unless it's obviously a
    // progressive file (mp4/webm/...) which <video> plays natively.
    const progressive = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|mp3|aac)(\?|$)/i.test(source.url);
    const useHls = Hls.isSupported() && !progressive;
    // PLAY-20: no MSE and no native HLS -> this device cannot play it; the relay won't help.
    if (!useHls && !progressive && !video.canPlayType('application/vnd.apple.mpegurl')) {
      setErrKind('unsupported');
      setStatus('error');
      return;
    }

    let destroyed = false;
    // Start on the (HTTPS) proxy when: the stream needs custom headers, OR it's an
    // HTTP stream on our HTTPS page (mixed-content -> browser blocks the direct load
    // outright, so skip the doomed attempt), OR proxy is forced (settings/tile). Plain
    // HTTPS streams play direct -- keeps the proxy/VPS unburdened across many tiles.
    const isMixed = typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//i.test(source.url);
    const needsProxyHeaders = !!(source.userAgent || source.referrer);
    const wantProxy = preferProxy || forcedProxy || startProxy;
    // A persisted copy has no signed link yet: proxy-bound starts wait for the refresh.
    const canProxyAtAll = !!source.proxyUrl || needsFresh(ch);
    let mode: 'direct' | 'proxy' = needsProxyHeaders || isMixed || (wantProxy && canProxyAtAll) ? 'proxy' : 'direct';
    let proxyRetries = 0;
    let mediaRecover = 0;
    let stalls = 0;
    let played = false;
    let playingSince = 0;
    let directRanLong = false; // direct playback ran > 5 s: never escalate it to the proxy
    let sameModeRetried = false;
    let refreshed403 = false;
    let lastProgressAt = Date.now();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    // If a stream buffers with NO forward progress for this long, stop waiting
    // and escalate (proxy -> alternate feed -> error) instead of spinning forever.
    const DEAD_AIR_MS = 20000;

    // Refresh the signed links when they are stale (in the background; awaited only
    // by a proxy load). One refresh in flight at a time, never a settled memo: links
    // re-signed 2 h ago are stale again (WEB-7). freshChannel never throws and
    // returns the channel unchanged on failure.
    let freshP: Promise<void> | null = null;
    const adopt = (next: Channel) => {
      if (destroyed || next === ch) return;
      ch = next;
      chRef.current = next;
      source = sourcesOf(next)[srcIdx] || source;
    };
    const ensureFresh = (force = false): Promise<void> => {
      if (force) return freshChannel(ch, { force: true }).then(adopt);
      if (freshP) return freshP;
      if (!needsFresh(ch)) return Promise.resolve();
      const p = freshChannel(ch).then(adopt).finally(() => {
        if (freshP === p) freshP = null;
      });
      freshP = p;
      return p;
    };
    if (needsFresh(ch)) void ensureFresh();

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
    const final = (kind: ErrKind) => {
      if (destroyed) return;
      clearTimers();
      destroyHls();
      setErrKind(kind);
      setStatus('error');
    };

    // play() with the autoplay policy handled (PLAY-11): a refusal is not a dead stream.
    const tryPlay = () => {
      let p: Promise<void> | undefined;
      try { p = video.play(); } catch { return; }
      p?.catch((err: unknown) => {
        if (destroyed || (err as { name?: string })?.name !== 'NotAllowedError') return;
        if (!video.muted) {
          video.muted = true;
          setAutoMuted(true);
          onMutedChange?.(true);
          video.play().catch((e2: unknown) => {
            if (destroyed || (e2 as { name?: string })?.name !== 'NotAllowedError') return;
            clearTimeout(watchdog);
            setNeedsTap(true);
          });
        } else {
          clearTimeout(watchdog); // waiting for a tap, not for the network
          setNeedsTap(true);
        }
      });
    };
    tapRef.current = () => {
      setNeedsTap(false);
      armWatchdog();
      tryPlay();
    };

    // Next alternate feed, else the error overlay.
    const nextSource = () => {
      if (destroyed) return;
      clearTimers();
      if (srcIdx < sourcesOf(ch).length - 1) {
        destroyHls();
        setStatus('loading');
        setPhase('retry');
        setSrcIdx(srcIdx + 1); // re-runs the effect on the next source
        return;
      }
      final('down');
    };

    // Escalate direct -> proxy, then retry the proxy a few times, then the next feed.
    const fail = () => {
      if (destroyed) return;
      clearTimers();
      // PLAY-8: a stream that already played gets one retry in the same mode first.
      if (played && !sameModeRetried) {
        sameModeRetried = true;
        setStatus('loading');
        setPhase('retry');
        setTimeout(() => !destroyed && start(), 500);
        return;
      }
      // Without a signed proxy URL (and no refresh to come), proxy escalation can only
      // insta-fail: skip straight to the next alternate feed.
      const canProxy = !!source?.proxyUrl || needsFresh(ch);
      if (mode === 'direct' && canProxy && !directRanLong) {
        mode = 'proxy';
        queueMicrotask(() => !destroyed && start());
        return;
      }
      if (mode === 'proxy' && canProxy && proxyRetries < MAX_PROXY_RETRIES) {
        proxyRetries++;
        setStatus('loading');
        setPhase('retry');
        setTimeout(() => !destroyed && start(), 700 * proxyRetries);
        return;
      }
      nextSource();
    };

    // Relay answered 403 (signature expired) or 410 (taken down): handle before fail().
    const onRelayStatus = (code: number): boolean => {
      if (mode !== 'proxy') return false;
      if (code === 410) {
        final('removed');
        return true;
      }
      if (code === 403 && !refreshed403) {
        refreshed403 = true;
        const before = source?.proxyUrl;
        destroyHls();
        setStatus('loading');
        setPhase('retry');
        void ensureFresh(true).then(() => {
          if (destroyed) return;
          if (source?.proxyUrl && source.proxyUrl !== before) load();
          else fail();
        });
        return true;
      }
      return false;
    };

    const armWatchdog = () => {
      clearTimeout(watchdog);
      // Direct gets a short leash; proxy gets longer (server fetch + segments).
      watchdog = setTimeout(() => {
        if (!destroyed && !played) fail();
      }, mode === 'direct' ? 9000 : 15000);
    };

    const isLive = () => {
      const d = hlsRef.current?.latestLevelDetails;
      if (d) return !!d.live;
      return !Number.isFinite(video.duration);
    };

    // Recurring buffer-stall recovery: kick the loader and nudge playback, and re-check
    // every few seconds. Escalates (proxy -> alternate -> error) if the stream never
    // started OR stalls with zero forward progress for too long (no endless "Buffering").
    const onStall = () => {
      if (destroyed) return;
      // PLAY-6: a paused video is not stalled (the viewer paused, or the tab is hidden).
      if (played && video.paused) return;
      stalls++;
      try {
        if (hlsRef.current) hlsRef.current.startLoad();
        const b = video.buffered;
        const now = video.currentTime;
        if (b.length) {
          if (isLive()) {
            // Live: catch up to the buffered edge (the original recovery).
            const end = b.end(b.length - 1);
            if (end - now > 0.1) video.currentTime = Math.max(now, end - 0.3);
          } else {
            // PLAY-7, VOD: never jump to the last range. Only hop a small gap into the
            // range that starts just ahead of the playhead.
            for (let i = 0; i < b.length; i++) {
              if (b.start(i) > now && b.start(i) <= now + 0.5 && b.end(i) > now) {
                video.currentTime = b.start(i) + 0.05;
                break;
              }
            }
          }
        }
        tryPlay();
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
      if (destroyed) return;
      destroyHls();
      clearTimers();
      played = false;
      playingSince = 0;
      mediaRecover = 0;
      setStatus('loading');
      setPhase(mode === 'proxy' ? (proxyRetries || sameModeRetried ? 'retry' : 'proxy') : sameModeRetried ? 'retry' : 'direct');
      armWatchdog();

      const src = mode === 'proxy' ? source?.proxyUrl : source?.url;
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
          if (!destroyed) tryPlay();
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (destroyed || hlsRef.current !== hls) return;
          // Non-fatal buffer stall -> recover in place.
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            onStall();
            return;
          }
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && onRelayStatus(httpCode(data))) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !CODEC_DETAILS.has(data.details)) {
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
          // PLAY-8: codec / media trouble is the device's; the relay cannot fix it.
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR || CODEC_DETAILS.has(data.details)) {
            destroyHls();
            nextSource();
            return;
          }
          fail();
        });
      } else {
        // Native playback (Safari HLS, or progressive sources).
        video.src = src;
        tryPlay();
        video.onerror = () => {
          if (destroyed) return;
          // MEDIA_ERR_DECODE: the relay cannot fix a decode error.
          if (video.error?.code === 3) return nextSource();
          if (mode !== 'proxy') return fail();
          // <video> errors carry no HTTP status: ask the relay once.
          const exp = proxyExp(src);
          const expired = exp !== null && exp < Date.now();
          void (expired ? Promise.resolve(403) : probeStatus(src)).then((code) => {
            if (destroyed) return;
            if (!onRelayStatus(code)) fail();
          });
        };
      }
    };

    // Proxy-bound loads wait for the refreshed links (no-op when they are current).
    const start = () => {
      if (destroyed) return;
      if (mode === 'proxy' && needsFresh(ch)) {
        setStatus('loading');
        setPhase('proxy');
        void ensureFresh().then(() => !destroyed && load());
        return;
      }
      load();
    };

    const onPlaying = () => {
      if (destroyed) return;
      played = true;
      if (!playingSince) playingSince = Date.now();
      stalls = 0;
      lastProgressAt = Date.now();
      clearTimers();
      setNeedsTap(false);
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
      if (!playingSince) return;
      const ranFor = Date.now() - playingSince;
      if (mode === 'direct' && ranFor > 5000) directRanLong = true;
      if (ranFor > 30000) {
        // A long healthy run earns a new in-place retry, a new relay refresh on 403
        // and new relay retries: a TV left on a proxied channel outlives many link
        // lifetimes (WEB-7).
        sameModeRetried = false;
        refreshed403 = false;
        proxyRetries = 0;
      }
    };
    // PLAY-6: time spent paused or seeking is not dead air.
    const onResetClock = () => {
      stalls = 0;
      lastProgressAt = Date.now();
      if (video.paused) clearTimeout(stallTimer);
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('timeupdate', onProgress);
    video.addEventListener('play', onResetClock);
    video.addEventListener('pause', onResetClock);
    video.addEventListener('seeking', onResetClock);

    // Stagger mosaic tiles so N streams don't hammer the network/proxy at once.
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    if (startDelayMs > 0) startTimer = setTimeout(() => { if (!destroyed) start(); }, startDelayMs);
    else start();

    return () => {
      destroyed = true;
      if (startTimer) clearTimeout(startTimer);
      clearTimers();
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('timeupdate', onProgress);
      video.removeEventListener('play', onResetClock);
      video.removeEventListener('pause', onResetClock);
      video.removeEventListener('seeking', onResetClock);
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
    setNeedsTap(false);
    setSrcIdx(0);
    setReloadKey((k) => k + 1);
  };
  const retryViaProxy = () => {
    setStatus('loading');
    setNeedsTap(false);
    setForcedProxy(true);
    setSrcIdx(0);
    setReloadKey((k) => k + 1);
  };
  const soundOn = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    setAutoMuted(false);
    onMutedChange?.(false);
    v.play().catch(() => { /* still refused: the native controls remain */ });
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

  const canRoute = errKind === 'down' && !forcedProxy && channel.kind !== 'dash' && !!(chRef.current.proxyUrl || needsFresh(chRef.current));
  const errTitle = errKind === 'removed' ? t('player.removed') : errKind === 'unsupported' ? t('player.unsupported') : t('player.interrupted');
  const errHint = errKind === 'removed' ? t('player.removedHint') : errKind === 'unsupported' ? t('player.unsupportedHint') : t('player.errorHint');
  const canRetry = errKind === 'down';

  return (
    <div className={clsx('relative h-full w-full bg-black', className)}>
      <video ref={videoRef} muted={muted} controls={controls} playsInline autoPlay className="h-full w-full bg-black" />

      {status === 'loading' && !needsTap && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[rgba(5,7,10,.45)]">
          <Spinner className={compact ? 'h-6 w-6' : 'h-8 w-8'} />
          {!compact && (
            <span role="status" className="text-sous text-on-image">
              {t(PHASE_KEY[phase])}
            </span>
          )}
        </div>
      )}

      {needsTap && status !== 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[rgba(5,7,10,.55)]">
          <Button variant={compact ? 'secondary' : 'primary'} icon={<Play size={16} aria-hidden="true" />} onClick={() => tapRef.current()} aria-label={t('player.tapToPlay')}>
            {t('player.tapToPlay')}
          </Button>
        </div>
      )}

      {autoMuted && status === 'playing' && !compact && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2">
          <Button variant="secondary" icon={<Volume2 size={16} aria-hidden="true" />} onClick={soundOn} aria-label={t('player.soundOn')}>
            {t('player.soundOn')}
          </Button>
        </div>
      )}

      {status === 'error' && (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[rgba(5,7,10,.9)] px-4 text-center">
          <WifiOff className="text-ink-3" size={compact ? 22 : 28} aria-hidden="true" />
          <div className="space-y-1">
            <p className={clsx('font-semibold text-ink', compact ? 'text-sous' : 'text-carte')}>{errTitle}</p>
            {!compact && <p className="mx-auto max-w-xs text-sous text-ink-2">{errHint}</p>}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {canRetry && (
              <Button variant={compact ? 'secondary' : 'primary'} icon={<RefreshCw size={15} aria-hidden="true" />} onClick={retry}>
                {t('player.retry')}
              </Button>
            )}
            {canRoute && !compact && (
              <Button variant="secondary" onClick={retryViaProxy}>
                {t('player.forceProxy')}
              </Button>
            )}
            {onNext && (
              <Button variant={!canRetry && !compact ? 'primary' : 'quiet'} onClick={onNext}>
                {t('player.nextChannel')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
