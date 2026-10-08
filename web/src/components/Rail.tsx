import { useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Channel, HealthStatus } from '@/types';
import type { NowNext } from '@/lib/epg';
import { useCatalog } from '@/store/catalogStore';
import { useT } from '@/lib/i18n';
import { ChannelCard, type PlayFn } from './ChannelCard';
import { Meta } from './ui';

// A row (spec 2.3): title above, mono meta, "See all" on the right, then a track
// of at most 8 16:9 cards and a 9th "See all" card. The next card peeks at the
// right edge. Rows of non-channel media (the Browse row) pass `children`.

export const ROW_MAX = 8;

interface Props {
  title: string;
  /** Meta pieces shown after the title ("1,204 channels · picked now"). */
  meta?: ReactNode[];
  channels?: Channel[];
  onPlay?: PlayFn;
  /** Opens the full list (grid). Adds the header link and the 9th card. */
  onSeeAll?: () => void;
  /** Count shown on the See all card. */
  total?: number;
  wide?: boolean;
  epg?: Record<string, NowNext>;
  /** Custom track content (media cards): replaces the channel cards. */
  children?: ReactNode;
}

/** Health of a card: the live probe map first, else the server verdict carried by the channel. */
export function healthOf(ch: Channel, health: Record<string, HealthStatus>): HealthStatus {
  const h = health[ch.url];
  if (h && h !== 'unknown') return h;
  return ch.online === true ? 'online' : ch.online === false ? 'offline' : 'unknown';
}

export function Rail({ title, meta, channels = [], onPlay, onSeeAll, total, wide, epg, children }: Props) {
  const t = useT();
  const track = useRef<HTMLDivElement>(null);
  const health = useCatalog((s) => s.health);
  const shown = channels.slice(0, ROW_MAX);
  const seeAllCard = !!onSeeAll && (total ?? channels.length) > shown.length;

  // Left/Right stay inside the row (the next card is centred); Up/Down are left
  // to the shared spatial navigation (lib/spatialNav.ts).
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const items = Array.from(track.current?.querySelectorAll<HTMLElement>(':scope > button') || []);
    const active = document.activeElement;
    const idx = items.findIndex((el) => el === active || el.contains(active));
    if (idx === -1) return;
    const next = items[idx + (e.key === 'ArrowRight' ? 1 : -1)];
    e.preventDefault(); // at an end, stay put (no jump to another row)
    if (next) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    }
  };

  const scrollBy = (dir: number) => {
    const sc = track.current;
    if (sc) sc.scrollBy({ left: dir * Math.min(900, sc.clientWidth * 0.8), behavior: 'smooth' });
  };

  if (!children && !shown.length) return null;

  return (
    <section className="row mt-[var(--ecart-rangees)]">
      <div className="flex items-center gap-3 px-[var(--gouttiere)]">
        <h2 className="row-title m-0 min-w-0 truncate">{title}</h2>
        {meta && meta.length > 0 && <Meta parts={meta} className="hidden shrink-0 sm:block" />}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onSeeAll && (
            <button type="button" onClick={onSeeAll} className="btn btn-quiet px-3">
              {t('home.seeAll')}
            </button>
          )}
          {/* Chevrons: desktop pointer only, never on TV or touch */}
          <span className="hidden gap-1 [@media(hover:hover)_and_(pointer:fine)]:flex [:root[data-tv]_&]:!hidden">
            <button type="button" onClick={() => scrollBy(-1)} aria-label={t('common.prev')} title={t('common.prev')} className="btn btn-quiet btn-icon min-h-[36px] w-9">
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => scrollBy(1)} aria-label={t('common.next')} title={t('common.next')} className="btn btn-quiet btn-icon min-h-[36px] w-9">
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
      <div ref={track} onKeyDown={onKey} className="row-track scroll-pl-[var(--gouttiere)]">
        {children ??
          shown.map((ch) => {
            const nn = ch.channelId ? epg?.[ch.channelId] : undefined;
            return (
              <ChannelCard
                key={ch.url}
                channel={ch}
                health={healthOf(ch, health)}
                onPlay={onPlay || (() => {})}
                queue={channels}
                now={nn?.now ?? null}
                next={nn?.next ?? null}
                inRow
                wide={wide}
              />
            );
          })}
        {!children && seeAllCard && (
          <button
            type="button"
            onClick={onSeeAll}
            className="lift card-surface flex w-[var(--carte-l)] shrink-0 snap-start flex-col items-center justify-center gap-1 self-start text-center"
          >
            <span className="text-carte font-semibold text-ink">{t('home.seeAll')}</span>
            <span className="meta">{t.n('count.channels', total ?? channels.length)}</span>
          </button>
        )}
        {/* Right edge spacer: the last card can scroll fully in view */}
        <span aria-hidden="true" className="w-[var(--gouttiere)] shrink-0" />
      </div>
    </section>
  );
}
