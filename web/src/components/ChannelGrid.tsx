import { useEffect, useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import { CloudOff, SearchX, Tv } from 'lucide-react';
import { useCatalog, applyClientFilters } from '@/store/catalogStore';
import { useSettings } from '@/store/settingsStore';
import { usePrefs } from '@/store/prefsStore';
import { ChannelCard, type PlayFn } from './ChannelCard';
import { healthOf } from './Rail';
import { CardSkeleton, EmptyState, Spinner } from './ui';
import { useT } from '@/lib/i18n';

// Responsive from phone (2 cols) up to 4K TV / ultrawide (2xl).
const DENSITY: Record<string, string> = {
  cozy: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6',
  comfortable: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8',
  compact: 'grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-10',
};

export function ChannelGrid({ onPlay }: { onPlay: PlayFn }) {
  // Field selectors (not the whole store) so the grid only re-renders when a slice
  // it actually uses changes -- not on every unrelated catalog mutation.
  const channels = useCatalog((s) => s.channels);
  const filters = useCatalog((s) => s.filters);
  const health = useCatalog((s) => s.health);
  const loading = useCatalog((s) => s.loading);
  const loadingMore = useCatalog((s) => s.loadingMore);
  const error = useCatalog((s) => s.error);
  const page = useCatalog((s) => s.page);
  const pages = useCatalog((s) => s.pages);
  const loadMore = useCatalog((s) => s.loadMore);
  const checkHealth = useCatalog((s) => s.checkHealth);
  const setFilters = useCatalog((s) => s.setFilters);
  const resetFilters = useCatalog((s) => s.resetFilters);
  const density = useSettings((s) => s.density);
  const showOffline = useSettings((s) => s.showOffline);
  const hiddenCategories = usePrefs((s) => s.prefs.hiddenCategories);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const t = useT();

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
      list = list.filter((c) => !(c.categories.length && c.categories.every((cat) => hidden.has(cat))));
    }
    return list;
  }, [channels, filters, health, showOffline, hiddenCategories]);

  // Arrow-key / D-pad navigation across the card grid (TV remotes have no Tab
  // key): left/right by 1, up/down by one full row. Other arrows are left to
  // the shared spatial navigation.
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    const cards = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-card]') || []);
    if (!cards.length) return;
    const cur = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-card]');
    const idx = cur ? cards.indexOf(cur) : -1;
    if (idx === -1) return;
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
      cards[next].focus({ preventScroll: true });
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

  const gridClass = clsx('grid gap-x-[var(--ecart-cartes)] gap-y-[calc(var(--ecart-cartes)_+_4px)]', DENSITY[density]);

  if (loading) {
    return (
      <div className={clsx(gridClass, 'px-[var(--gouttiere)] py-6')}>
        {Array.from({ length: 18 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  // One empty state per page, one action: the page's only primary (no hero here).
  if (!visible.length) {
    if (error) {
      const retry = useCatalog.getState().retry;
      return (
        <EmptyState
          icon={<CloudOff size={44} strokeWidth={1.5} />}
          title={t('grid.error')}
          body={t('home.errorBody')}
          action={{ label: t('empty.tryAgain'), onClick: () => (retry ? retry() : useCatalog.getState().loadChannels()), variant: 'primary' }}
        />
      );
    }
    if (filters.favoritesOnly) {
      return (
        <EmptyState
          icon={<Tv size={44} strokeWidth={1.5} />}
          title={t('grid.noFav')}
          body={t('grid.noFavBody')}
          action={{ label: t('empty.browseChannels'), onClick: () => resetFilters(), variant: 'primary' }}
        />
      );
    }
    const q = filters.q.trim();
    return (
      <EmptyState
        icon={<SearchX size={44} strokeWidth={1.5} />}
        title={t('grid.noMatch')}
        body={t('grid.noMatchBody')}
        action={
          q
            ? { label: t('empty.clearSearch'), onClick: () => setFilters({ q: '' }), variant: 'primary' }
            : { label: t('grid.clearFilters'), onClick: () => resetFilters(), variant: 'primary' }
        }
      />
    );
  }

  return (
    <div className="px-[var(--gouttiere)] py-6">
      <div ref={gridRef} onKeyDown={onGridKeyDown} className={gridClass}>
        {visible.map((ch) => (
          <ChannelCard
            key={ch.url}
            channel={ch}
            health={healthOf(ch, health)}
            onPlay={onPlay}
            queue={visible}
            // Clear the sticky FilterBar when the D-pad scrolls a card into view (TV-9).
            className="scroll-mt-[calc(var(--champ-h)*2_+_40px)]"
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
