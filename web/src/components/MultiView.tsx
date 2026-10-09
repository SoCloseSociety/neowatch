import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { X, Volume2, VolumeX, LayoutGrid, Maximize2 } from 'lucide-react';
import { HlsVideo } from './HlsVideo';
import { EmptyState, Spinner } from './ui';
import { usePlayer, MAX_TILES } from '@/store/playerStore';
import { toast } from '@/store/uiStore';
import { useT, fmtNum } from '@/lib/i18n';
import { isTV } from '@/lib/device';

// Multi-view (spec 2.6): up to 9 live tiles, one with sound. It is a layer
// (spatialNav): Back closes it, the D-pad moves between tiles, the focus comes
// back where it was. Tiles are re-resolved on open (live links) before mounting.

// Balanced grid by tile count; fewer columns on small screens.
function gridClass(n: number, width: number): string {
  const small = width < 700;
  if (n <= 1) return 'grid-cols-1';
  if (n === 2) return small ? 'grid-cols-1 grid-rows-2' : 'grid-cols-2';
  if (n <= 4) return 'grid-cols-2 grid-rows-2';
  if (n <= 6) return small ? 'grid-cols-2 grid-rows-3' : 'grid-cols-3 grid-rows-2';
  return small ? 'grid-cols-2 grid-rows-4' : 'grid-cols-3 grid-rows-3';
}

export function MultiView() {
  const multi = usePlayer((s) => s.multi);
  const ready = usePlayer((s) => s.multiReady);
  const activeAudio = usePlayer((s) => s.activeAudio);
  const multiOpen = usePlayer((s) => s.multiOpen);
  const { removeFromMulti, clearMulti, restoreMulti, closeMulti, setActiveAudio } = usePlayer.getState();
  const [layout, setLayout] = useState<'mosaic' | 'focus'>('mosaic');
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  const t = useT();
  const tv = isTV();
  /** Url of the sound tile the browser keeps muted (autoplay with sound refused). */
  const [blocked, setBlocked] = useState<string | null>(null);

  // Re-pick the layout on resize / rotate (tablet portrait <-> landscape).
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  if (!multiOpen) return null;

  const clear = () => {
    const before = usePlayer.getState().multi;
    const audio = usePlayer.getState().activeAudio;
    clearMulti();
    toast(t('shell.multiCleared'), { undo: () => restoreMulti(before, audio) });
  };
  const remove = (url: string, name: string) => {
    const before = usePlayer.getState().multi;
    const audio = usePlayer.getState().activeAudio;
    removeFromMulti(url);
    toast(t('shell.tileRemoved', { name }), { undo: () => restoreMulti(before, audio) });
  };

  // Pick the tile to hear. Already the sound tile but kept muted by the browser:
  // unmute it right here, inside the tap (the only moment Safari / iOS allow it).
  const select = (url: string, tile: Element | null) => {
    if (activeAudio === url && blocked === url) {
      const v = tile?.querySelector('video');
      if (v) {
        v.muted = false;
        v.play().catch(() => { /* still refused: the pill keeps saying so */ });
        if (!v.muted) setBlocked(null);
      }
      return;
    }
    setBlocked(null);
    setActiveAudio(url);
  };

  // Focus layout: the tile with sound (or the first) spans 2x2.
  const focusUrl = activeAudio && multi.some((c) => c.url === activeAudio) ? activeAudio : multi[0]?.url;
  const canFocus = multi.length >= 3;
  const focusLayout = layout === 'focus' && canFocus;

  return (
    <div data-layer="multi" role="dialog" aria-modal="true" aria-labelledby="nw-multi-title" className="fixed inset-0 z-50 flex flex-col bg-[var(--e-fond)] animate-fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-[var(--bg-1)] px-[var(--gouttiere)] py-3">
        <div className="min-w-0">
          <h2 id="nw-multi-title" className="text-carte font-semibold text-ink">
            {t('multi.title')}
          </h2>
          {multi.length > 0 && (
            <p className="meta">
              {t.n('shell.tilesOf', multi.length, { max: fmtNum(MAX_TILES) })}
              <span className="hidden md:inline"> · {t('shell.multiHint')}</span>
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {canFocus && (
            <button type="button" onClick={() => setLayout((l) => (l === 'mosaic' ? 'focus' : 'mosaic'))} className="btn btn-secondary" aria-label={t('multi.layout')} title={t('multi.layout')}>
              {focusLayout ? <LayoutGrid size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
              <span className="hidden sm:inline">{focusLayout ? t('multi.mosaic') : t('multi.focus')}</span>
            </button>
          )}
          {multi.length > 0 && (
            <button type="button" onClick={clear} className="btn btn-quiet">
              {t('multi.clear')}
            </button>
          )}
          <button type="button" onClick={closeMulti} className="btn btn-secondary btn-icon" aria-label={t('common.close')} title={t('common.close')}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {multi.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <EmptyState
            icon={<LayoutGrid size={40} />}
            title={t('multi.emptyBody')}
            body={t('shell.multiEmptyHow')}
            action={{ label: t('multi.browse'), onClick: closeMulti, variant: 'primary' }}
          />
        </div>
      ) : !ready ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className={clsx('grid min-h-0 flex-1 gap-2 p-2', focusLayout ? 'auto-rows-fr grid-cols-3' : gridClass(multi.length, width))}>
          {multi.map((ch, idx) => {
            const isAudio = activeAudio === ch.url;
            const isFocus = focusLayout && ch.url === focusUrl;
            const silenced = isAudio && blocked === ch.url;
            return (
              // A plain group (WEB-14): ONE button selects the sound (it covers the
              // tile for the D-pad and screen readers), Remove is its sibling. The
              // pointer goes through it, so the video's own Retry stays clickable.
              <div
                key={ch.url}
                data-key={ch.url}
                role="group"
                aria-label={ch.name}
                onClick={(e) => select(ch.url, e.currentTarget)}
                className={clsx(
                  'group relative min-h-0 cursor-pointer rounded-card bg-black',
                  isFocus && 'col-span-2 row-span-2',
                  isAudio ? 'shadow-[inset_0_0_0_2px_var(--t1)]' : 'shadow-[inset_0_0_0_1px_var(--line)]'
                )}
              >
                {/* Clips the picture to the tile; the select button stays outside it so its focus ring is not cut. */}
                <div className="absolute inset-0 overflow-hidden rounded-card">
                <HlsVideo
                  channel={ch}
                  muted={!isAudio}
                  controls={false}
                  lowRes
                  startDelayMs={idx * 300}
                  // The browser refused sound outside a tap (Safari / iOS): the tile
                  // says so, and the next tap on it turns the sound on (WEB-13).
                  onMutedChange={(m) => setBlocked((b) => (m ? ch.url : b === ch.url ? null : b))}
                />
                </div>

                <button
                  type="button"
                  aria-pressed={isAudio}
                  aria-label={t('shell.tileLabel', { name: ch.name })}
                  data-autofocus={(activeAudio ? isAudio : idx === 0) ? '' : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    select(ch.url, e.currentTarget.parentElement);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete') {
                      e.preventDefault();
                      remove(ch.url, ch.name);
                    }
                  }}
                  className="pointer-events-none absolute inset-0 rounded-card"
                />

                {/* Name + sound state: always readable, never over the middle of the picture. */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 rounded-b-card bg-[linear-gradient(180deg,rgba(5,7,10,0),rgba(5,7,10,.86))] px-3 pb-2 pt-6">
                  <span translate="no" className="text-on-image min-w-0 truncate text-sous font-semibold">
                    {ch.name}
                  </span>
                  {isAudio && (
                    <span className="pill ml-auto shrink-0">
                      {silenced ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
                      {silenced ? t('shell.soundBlocked') : t('shell.soundOn')}
                    </span>
                  )}
                </div>

                {/* Remove: revealed on hover / focus (the remote reaches it with the D-pad). */}
                <div
                  className={clsx(
                    'absolute right-2 top-2 flex items-center gap-1.5 transition-opacity duration-d1',
                    tv ? 'opacity-0 group-focus-within:opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                  )}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(ch.url, ch.name);
                    }}
                    className="btn btn-secondary btn-icon"
                    aria-label={t('multi.remove')}
                    title={t('multi.remove')}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
