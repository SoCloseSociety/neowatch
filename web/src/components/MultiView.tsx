import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { X, Volume2, VolumeX, Trash2, Grip, LayoutGrid, Maximize2 } from 'lucide-react';
import { HlsVideo } from './HlsVideo';
import { usePlayer } from '@/store/playerStore';
import { useT } from '@/lib/i18n';

// Grid layout chosen by tile count for a balanced mosaic. Fewer columns on
// small screens so tiles stay readable and D-pad focusable.
function gridClass(n: number, width: number): string {
  const small = width < 700;
  if (n <= 1) return 'grid-cols-1';
  if (n === 2) return small ? 'grid-cols-1 grid-rows-2' : 'grid-cols-2';
  if (n <= 4) return 'grid-cols-2 grid-rows-2';
  if (n <= 6) return small ? 'grid-cols-2 grid-rows-3' : 'grid-cols-3 grid-rows-2';
  return small ? 'grid-cols-2 grid-rows-4' : 'grid-cols-3 grid-rows-3';
}

export function MultiView() {
  const { multi, activeAudio, multiOpen, removeFromMulti, clearMulti, closeMulti, setActiveAudio } = usePlayer();
  const [layout, setLayout] = useState<'mosaic' | 'focus'>('mosaic');
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  const t = useT();

  // Back/Escape (TV remote) closes the mosaic.
  useEffect(() => {
    if (!multiOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMulti(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [multiOpen, closeMulti]);

  // Re-pick the mosaic layout on resize / rotate (tablet portrait <-> landscape).
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); };
  }, []);

  if (!multiOpen) return null;

  // Empty state: the button still "works" -- explain how to populate the mosaic.
  if (multi.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center animate-fade-in">
        <button onClick={closeMulti} className="absolute right-4 top-4 rounded-lg p-2 text-ink/60 hover:bg-white/5 hover:text-ink" aria-label={t('common.close')}><X size={20} /></button>
        <Grip size={40} className="text-accent" />
        <h2 className="text-lg font-bold text-ink">{t('multi.title')}</h2>
        <p className="max-w-sm text-sm text-ink/60">{t('multi.emptyBody')}</p>
        <button onClick={closeMulti} className="rounded-xl bg-accent px-5 py-2.5 text-sm font-bold text-[#06151a] hover:brightness-110">{t('multi.browse')}</button>
      </div>
    );
  }

  // Focus layout: the active-audio tile (or the first) spans 2x2, the rest tile around it.
  const focusUrl = activeAudio && multi.some((c) => c.url === activeAudio) ? activeAudio : multi[0]?.url;
  const canFocus = multi.length >= 3;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] bg-surface/80 px-4 py-2.5">
        <Grip size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-ink">{t('multi.title')}</h2>
        <span className="rounded bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">{multi.length}/9</span>
        <span className="hidden text-[11px] text-ink/40 sm:inline">{t('multi.hint')}</span>
        <div className="ml-auto flex items-center gap-2">
          {canFocus && (
            <button
              onClick={() => setLayout((l) => (l === 'mosaic' ? 'focus' : 'mosaic'))}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-ink/60 hover:border-accent/30 hover:text-accent"
              title={t('multi.layout')}
            >
              {layout === 'focus' ? <LayoutGrid size={14} /> : <Maximize2 size={14} />}
              <span className="hidden sm:inline">{layout === 'focus' ? t('multi.mosaic') : t('multi.focus')}</span>
            </button>
          )}
          <button
            onClick={clearMulti}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-ink/60 hover:border-rose-500/30 hover:text-rose-400"
          >
            <Trash2 size={14} /> {t('multi.clear')}
          </button>
          <button onClick={closeMulti} className="rounded-lg p-2 text-ink/60 hover:bg-white/5 hover:text-ink" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Mosaic */}
      <div className={clsx('grid flex-1 gap-1 p-1', layout === 'focus' && canFocus ? 'auto-rows-fr grid-cols-3' : gridClass(multi.length, width))}>
        {multi.map((ch, idx) => {
          const isAudio = activeAudio === ch.url;
          const isFocus = layout === 'focus' && canFocus && ch.url === focusUrl;
          return (
            <div
              key={ch.url}
              tabIndex={0}
              role="button"
              aria-label={ch.name}
              onClick={() => setActiveAudio(ch.url)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveAudio(ch.url); } }}
              className={clsx(
                'group relative cursor-pointer overflow-hidden rounded-lg border bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isFocus && 'col-span-2 row-span-2',
                isAudio ? 'border-accent/60 ring-1 ring-accent/40' : 'border-white/[0.06]'
              )}
            >
              <HlsVideo channel={ch} muted={!isAudio} controls={false} lowRes startDelayMs={idx * 300} />

              {/* Tile overlay -- hidden by default (clean video), revealed on hover/focus
                  so the name + controls never block the picture, esp. on a TV remote. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <span className="truncate text-[11px] font-medium text-white">{ch.flag} {ch.name}</span>
                <div className="pointer-events-auto ml-auto flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); setActiveAudio(ch.url); }}
                    className={clsx(
                      'flex h-6 w-6 items-center justify-center rounded bg-black/60 backdrop-blur transition-colors',
                      isAudio ? 'text-accent' : 'text-white/60 hover:text-white'
                    )}
                    aria-label={t('multi.audio')}
                  >
                    {isAudio ? <Volume2 size={13} /> : <VolumeX size={13} />}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFromMulti(ch.url); }}
                    className="flex h-6 w-6 items-center justify-center rounded bg-black/60 text-white/60 backdrop-blur hover:text-rose-400"
                    aria-label={t('multi.remove')}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
