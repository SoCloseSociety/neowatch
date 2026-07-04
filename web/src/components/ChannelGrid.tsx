import { useEffect, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import { SearchX, Tv } from 'lucide-react';
import type { Channel } from '@/types';
import { useCatalog, applyClientFilters } from '@/store/catalogStore';
import { useSettings } from '@/store/settingsStore';
import { usePrefs } from '@/store/prefsStore';
import { ChannelCard } from './ChannelCard';
import { CardSkeleton, EmptyState, Spinner } from './ui';
import { useT } from '@/lib/i18n';

// Responsive from phone (2 cols) up to 4K TV / ultrawide (2xl).
const DENSITY: Record<string, string> = {
  cozy: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6',
  comfortable: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8',
  compact: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-9 2xl:grid-cols-12',
};

export function ChannelGrid({ onPlay }: { onPlay: (ch: Channel) => void }) {
  // Field selectors (not the whole store) so the grid only re-renders when a slice
  // it actually uses changes -- not on every unrelated catalog mutation.
  const channels = useCatalog((s) => s.channels);
  const filters = useCatalog((s) => s.filters);
  const health = useCatalog((s) => s.health);
  const latency = useCatalog((s) => s.latency);
  const loading = useCatalog((s) => s.loading);
  const loadingMore = useCatalog((s) => s.loadingMore);
  const page = useCatalog((s) => s.page);
  const pages = useCatalog((s) => s.pages);
  const loadMore = useCatalog((s) => s.loadMore);
  const checkHealth = useCatalog((s) => s.checkHealth);
  const density = useSettings((s) => s.density);
  const showOffline = useSettings((s) => s.showOffline);
  const hiddenCategories = usePrefs((s) => s.prefs.hiddenCategories);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const gridRef = useRef<HTMLDivElement>(null);

  // When the active filter changes (e.g. entering the grid from Home), scroll the
  // content back to the top so the first row isn't hidden under the sticky FilterBar.
  useEffect(() => {
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
  }, [filters.category, filters.country, filters.language, filters.q, filters.foot, filters.favoritesOnly]);

  const visible = useMemo(() => {
    let list = applyClientFilters(channels, filters, health);
    if (!showOffline) list = list.filter((c) => health[c.url] !== 'offline');
    // Premium curation: drop channels whose every category is hidden.
    if (hiddenCategories.length) {
      const hidden = new Set(hiddenCategories);
      list = list.filter((c) => !c.categories.every((cat) => hidden.has(cat)));
    }
    return list;
  }, [channels, filters, health, showOffline, hiddenCategories]);

  // Arrow-key / D-pad spatial navigation across the card grid (TV remotes have
  // no Tab key). Moves focus left/right by 1 and up/down by one full row.
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    const cards = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-card]') || []);
    if (!cards.length) return;
    const idx = cards.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) {
      e.preventDefault();
      cards[0].focus();
      return;
    }
    // Columns = number of cards sharing the first row's top offset.
    const top0 = cards[0].offsetTop;
    const cols = Math.max(1, cards.filter((c) => c.offsetTop === top0).length);
    let next = idx;
    if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowLeft') next = idx - 1;
    else if (e.key === 'ArrowDown') next = idx + cols;
    else if (e.key === 'ArrowUp') next = idx - cols;
    if (next >= 0 && next < cards.length) {
      e.preventDefault();
      cards[next].focus();
      cards[next].scrollIntoView({ block: 'nearest' });
    }
  };

  // Probe health for whatever is loaded (deduped + cached server-side).
  useEffect(() => {
    if (channels.length) checkHealth(channels);
    // checkHealth is a stable Zustand action (never recreated); re-run only when
    // the channel list changes -- adding it to deps would not change behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && page < pages && !loadingMore) loadMore();
      },
      { rootMargin: '600px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [page, pages, loadingMore, loadMore]);

  if (loading) {
    return (
      <div className={clsx('grid gap-3 p-4', DENSITY[density])}>
        {Array.from({ length: 18 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!visible.length) {
    return filters.favoritesOnly ? (
      <EmptyState icon={<Tv size={48} />} title={t('grid.noFav')} hint={t('grid.noFavHint')} />
    ) : (
      <EmptyState icon={<SearchX size={48} />} title={t('grid.noMatch')} hint={t('grid.noMatchHint')} />
    );
  }

  return (
    <div className="p-4">
      <div ref={gridRef} onKeyDown={onGridKeyDown} className={clsx('grid gap-3', DENSITY[density])}>
        {visible.map((ch) => (
          <ChannelCard
            key={ch.id}
            channel={ch}
            health={health[ch.url] || 'unknown'}
            latency={latency[ch.url]}
            onPlay={onPlay}
          />
        ))}
      </div>

      {!filters.favoritesOnly && page < pages && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {loadingMore && <Spinner />}
        </div>
      )}
    </div>
  );
}
