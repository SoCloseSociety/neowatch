import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Search, X, Clock, User } from 'lucide-react';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer } from '@/store/playerStore';
import { useUI } from '@/store/uiStore';
import { useAuth } from '@/store/authStore';
import { useT, fmtNum, fmtTime } from '@/lib/i18n';
import { debounce } from '@/lib/format';
import { AvatarMenu } from './AvatarMenu';

// Top bar (spec 2.1, Sentinel "Barre"): brand + one status point at the left,
// the four doors (Live TV, Guide, Movies, Radio) and Multi-view, the search,
// then Sign in / the avatar. Everything else (Premium, Install, Language,
// Settings, Admin) lives in the avatar menu. Phones get the Dock at the bottom.

/** The catalog list is "old" past two TTLs (the server rebuilds every 12 h). */
const LIST_OLD_MS = 26 * 60 * 60_000;

export const NAV = [
  { to: '/', key: 'nav.live', end: true },
  { to: '/programme-tv', key: 'nav.guide', end: false },
  { to: '/films', key: 'nav.movies', end: false },
  { to: '/radios', key: 'nav.radio', end: false },
] as const;

function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Status point + one mono line: "8,510 live · list from 14:05" (spec 2.1). */
function Status() {
  const meta = useCatalog((s) => s.meta);
  const online = useOnline();
  const t = useT();
  if (!online) {
    return (
      <div className="flex items-center gap-2" role="status">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[var(--red)]" />
        <p className="meta">{t('top.offline')}</p>
      </div>
    );
  }
  if (!meta) return null;
  const old = !!meta.updatedAt && Date.now() - meta.updatedAt > LIST_OLD_MS;
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden="true" className={clsx('h-2 w-2 shrink-0 rounded-full', old ? 'bg-[var(--amber)]' : 'bg-[var(--mint)]')} />
      <p className="meta">
        {t('top.status', { n: fmtNum(meta.online ?? meta.total), time: meta.updatedAt ? fmtTime(meta.updatedAt) : '' })}
        {old && ` · ${t('top.listOld')}`}
      </p>
    </div>
  );
}

/** After a search, OK / Enter should play: move the focus to the first result. */
function focusFirstResult(deadline = Date.now() + 4000) {
  const card = [...document.querySelectorAll<HTMLElement>('main [data-card]')].find((el) => el.getClientRects().length > 0);
  if (card) {
    const target = card.matches('a[href],button,[tabindex]') ? card : card.querySelector<HTMLElement>('a[href],button,[tabindex]');
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  if (Date.now() < deadline) setTimeout(() => focusFirstResult(deadline), 150);
}

function useNarrow() {
  const q = '(max-width: 480px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

export function TopBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setFilters = useCatalog((s) => s.setFilters);
  const resetFilters = useCatalog((s) => s.resetFilters);
  const filterQ = useCatalog((s) => s.filters.q);
  const multiCount = usePlayer((s) => s.multi.length);
  const multiOpen = usePlayer((s) => s.multiOpen);
  const openMulti = usePlayer((s) => s.openMulti);
  const setLogin = useUI((s) => s.setLogin);
  const avatarOpen = useUI((s) => s.avatarOpen);
  const setAvatar = useUI((s) => s.setAvatar);
  const user = useAuth((s) => s.user);
  const t = useT();
  const narrow = useNarrow();

  const [local, setLocal] = useState(filterQ);
  const debounced = useRef(debounce((q: string) => setFilters({ q }), 350)).current;
  // Search history (suggestions): a settled query is remembered after typing stops.
  const searchHistory = useCatalog((s) => s.searchHistory);
  const addSearchTerm = useCatalog((s) => s.addSearchTerm);
  const clearSearchHistory = useCatalog((s) => s.clearSearchHistory);
  const commitHistory = useRef(debounce((q: string) => addSearchTerm(q), 1200)).current;
  const [searchFocus, setSearchFocus] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Run a search now (Enter / a suggestion): no debounce, remember the term, show results.
  const runSearch = (term: string) => {
    const q = term.trim();
    setLocal(q);
    debounced.cancel();
    commitHistory.cancel();
    setFilters({ q });
    if (q.length >= 2) addSearchTerm(q);
    setSearchFocus(false);
    if (pathname !== '/') navigate('/');
    // Every device: the focus leaves the box for the first result, so the next
    // OK / Enter plays it (and a phone keyboard closes over the results).
    if (q) {
      inputRef.current?.blur();
      setTimeout(() => focusFirstResult(), 300);
    }
  };
  const clearSearch = () => {
    debounced.cancel();
    commitHistory.cancel();
    setLocal('');
    setFilters({ q: '' });
    inputRef.current?.focus();
  };
  const showSuggestions = searchFocus && !local.trim() && searchHistory.length > 0;

  useEffect(() => setLocal(filterQ), [filterQ]);

  // "/" (or Ctrl/Cmd+K) focuses the search from anywhere outside a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const tgt = e.target as HTMLElement | null;
      const typing = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
      const open = (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k');
      if (!open || usePlayer.getState().current || usePlayer.getState().multiOpen) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close the suggestions on an outside click.
  useEffect(() => {
    if (!searchFocus) return;
    const onDoc = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchFocus(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [searchFocus]);

  // Brand = home = every filter cleared.
  const goHome = () => {
    resetFilters();
    navigate('/');
  };

  const initials = user ? (user.name || user.email).trim().slice(0, 2).toUpperCase() : '';

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-xl">
      <div className="mx-auto flex h-[var(--entete-h)] w-full max-w-[1760px] items-center gap-3 px-[var(--gouttiere)]">
        {/* Brand + status point */}
        <button type="button" onClick={goHome} className="flex shrink-0 items-center gap-2 rounded-field py-1" aria-label={t('shell.home')} title={t('shell.home')}>
          <span translate="no" className="brand text-libelle text-ink">
            NEOWATCH
          </span>
        </button>
        <div className="hidden xl:block">
          <Status />
        </div>

        {/* The doors (tablet, computer, TV); phones use the Dock */}
        <nav aria-label={t('shell.mainNav')} className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={n.to === '/' ? () => resetFilters() : undefined}
              className={({ isActive }) =>
                clsx(
                  'relative rounded-field px-3 py-2 text-sous font-medium transition-colors duration-d1',
                  isActive ? 'text-ink after:absolute after:inset-x-3 after:-bottom-[2px] after:h-[3px] after:rounded-full after:bg-[var(--t1)]' : 'text-ink-3 hover:text-ink'
                )
              }
            >
              {t(n.key)}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={openMulti}
            aria-pressed={multiOpen}
            aria-label={t('nav.multi')}
            title={t('nav.multi')}
            className={clsx('flex items-center gap-2 rounded-field px-3 py-2 text-sous font-medium transition-colors duration-d1', multiOpen ? 'text-ink' : 'text-ink-3 hover:text-ink')}
          >
            {t('nav.multi')}
            {multiCount > 0 && (
              <span className="meta text-ink-2" aria-hidden="true">
                {fmtNum(multiCount)}
              </span>
            )}
          </button>
        </nav>

        {/* Search */}
        <div ref={searchRef} className="relative ml-auto min-w-0 flex-1 md:max-w-[420px]">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            ref={inputRef}
            type="search"
            value={local}
            onFocus={() => setSearchFocus(true)}
            onChange={(e) => {
              const v = e.target.value;
              setLocal(v);
              debounced(v);
              if (v.trim().length >= 2) commitHistory(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(local);
              } else if (e.key === 'Escape' && (showSuggestions || local)) {
                e.preventDefault();
                if (showSuggestions) setSearchFocus(false);
                else clearSearch();
              }
            }}
            placeholder={narrow ? t('nav.search') : t('search.placeholder')}
            aria-label={t('search.placeholder')}
            enterKeyHint="search"
            className="input h-[var(--btn-h)] min-h-0 w-full rounded-pill pl-10 pr-10 [&::-webkit-search-cancel-button]:hidden"
          />
          {local && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label={t('search.clear')}
              title={t('search.clear')}
              className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:text-ink"
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}

          {/* Recent searches (focus on an empty box): one press re-searches, a big help on a remote. */}
          {showSuggestions && (
            <div className="absolute inset-x-0 top-[calc(100%+8px)] z-50 overflow-hidden rounded-card border border-line-strong bg-[var(--surface-menu)] py-1 shadow-menu">
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="overline">{t('search.recent')}</span>
                <button type="button" onClick={clearSearchHistory} className="btn btn-quiet min-h-[32px] px-2 text-meta">
                  {t('search.clear')}
                </button>
              </div>
              {searchHistory.map((term) => (
                <button
                  type="button"
                  key={term}
                  onClick={() => runSearch(term)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sous text-ink-2 hover:bg-[var(--bg-3)] hover:text-ink focus-visible:bg-[var(--bg-3)]"
                >
                  <Clock size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
                  <span translate="no" className="truncate">
                    {term}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Account */}
        {!user && (
          <button type="button" onClick={() => setLogin(true)} className="btn btn-secondary shrink-0 px-3 sm:px-[18px]">
            {t('top.login')}
          </button>
        )}
        <div className="relative shrink-0">
          <button
            type="button"
            data-avatar=""
            onClick={() => setAvatar(!avatarOpen)}
            aria-haspopup="menu"
            aria-expanded={avatarOpen}
            aria-label={user ? t('shell.menuFor', { name: user.name || user.email }) : t('shell.menu')}
            title={user ? t('shell.menuFor', { name: user.name || user.email }) : t('shell.menu')}
            className="grid h-[var(--avatar)] w-[var(--avatar)] place-items-center rounded-full border border-line-strong bg-[var(--bg-2)] text-meta font-semibold text-ink"
          >
            {user ? <span translate="no">{initials}</span> : <User size={16} aria-hidden="true" />}
          </button>
          <AvatarMenu />
        </div>
      </div>
    </header>
  );
}
