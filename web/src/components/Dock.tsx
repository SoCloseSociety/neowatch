import { NavLink } from 'react-router-dom';
import { clsx } from 'clsx';
import { Tv, CalendarClock, Film, RadioTower, LayoutGrid } from 'lucide-react';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer } from '@/store/playerStore';
import { useT, fmtNum } from '@/lib/i18n';
import { isTV } from '@/lib/device';

// Phone dock (spec 2.1, Sentinel "dock"): the four doors + Multi-view, one
// thumb away. Hidden from tablets up (the top bar shows the doors) and on TV.

const ITEMS = [
  { to: '/', key: 'nav.live', icon: Tv, end: true },
  { to: '/programme-tv', key: 'nav.guide', icon: CalendarClock, end: false },
  { to: '/films', key: 'nav.movies', icon: Film, end: false },
  { to: '/radios', key: 'nav.radio', icon: RadioTower, end: false },
] as const;

const cell = 'relative flex min-h-[var(--cible-doigt)] flex-1 flex-col items-center justify-center gap-1 rounded-field text-min font-medium transition-colors duration-d1';

export function Dock() {
  const t = useT();
  const resetFilters = useCatalog((s) => s.resetFilters);
  const openMulti = usePlayer((s) => s.openMulti);
  const multiOpen = usePlayer((s) => s.multiOpen);
  const multiCount = usePlayer((s) => s.multi.length);
  if (isTV()) return null;

  return (
    <nav
      aria-label={t('shell.mainNav')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 px-2 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-xl md:hidden"
    >
      <div className="flex h-[68px] items-stretch gap-1 py-1.5">
        {ITEMS.map(({ to, key, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={to === '/' ? () => resetFilters() : undefined}
            className={({ isActive }) => clsx(cell, isActive ? 'text-ink' : 'text-ink-3')}
          >
            {({ isActive }) => (
              <>
                {isActive && <span aria-hidden="true" className="absolute top-0 h-[3px] w-6 rounded-full bg-[var(--identite)]" />}
                <Icon size={20} aria-hidden="true" strokeWidth={isActive ? 2.2 : 1.8} />
                <span>{t(key)}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={openMulti}
          aria-pressed={multiOpen}
          aria-label={t('nav.multi')}
          title={t('nav.multi')}
          className={clsx(cell, 'relative', multiOpen ? 'text-ink' : 'text-ink-3')}
        >
          <LayoutGrid size={20} aria-hidden="true" />
          <span aria-hidden="true">{t('nav.multi')}</span>
          {multiCount > 0 && (
            <span aria-hidden="true" className="absolute right-[calc(50%-22px)] top-0.5 font-mono text-min text-ink-2">
              {fmtNum(multiCount)}
            </span>
          )}
        </button>
      </div>
    </nav>
  );
}
