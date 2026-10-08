import { Component, useEffect, useRef, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { Filters } from '@/types';
import { Lock, Compass } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { Dock } from './components/Dock';
import { PromoStrip } from './components/PromoStrip';
import { FilterBar } from './components/FilterBar';
import { ChannelGrid } from './components/ChannelGrid';
import { Home } from './components/Home';
import { Install } from './components/Install';
import { Settings } from './components/Settings';
import { Login } from './components/Login';
import { Pricing } from './components/Pricing';
import { ProgramSearch } from './components/ProgramSearch';
import { Preferences } from './components/Preferences';
import { Account } from './components/Account';
import { Spinner, EmptyState, ToastHost } from './components/ui';

// A deploy replaces the hashed chunks: a tab opened before it fails to load a
// lazy page ("Failed to fetch dynamically imported module"). Reload ONCE to get
// the new index (a flag in sessionStorage stops a reload loop when the server is down).
const RELOAD_FLAG = 'nw.chunkReload';
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
    } catch {
      /* storage blocked: still reload once per page */
    }
    if (Date.now() - last < 60_000) return; // already tried: the ErrorBoundary takes over
    try {
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
    } catch {
      /* storage blocked */
    }
    e.preventDefault();
    window.location.reload();
  });
}

/** Anything that throws while rendering lands here instead of a blank screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[neowatch] render error', error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-screen flex-col items-center justify-center gap-3 bg-surface px-6 text-center text-ink">
        <p translate="no" className="brand text-libelle text-ink-2">NEOWATCH</p>
        <p className="text-carte font-semibold">{tr('shell.crashTitle')}</p>
        <p className="max-w-sm text-sous text-ink-2">{tr('shell.crashBody')}</p>
        <button type="button" autoFocus onClick={() => window.location.reload()} className="btn btn-primary mt-2">
          {tr('shell.reload')}
        </button>
      </div>
    );
  }
}

// Lazy-loaded: these pull in hls.js: keep it out of the initial bundle so the
// channel grid loads fast; the player chunk loads on first play / multi-screen.
const Player = lazy(() => import('./components/Player').then((m) => ({ default: m.Player })));
const MultiView = lazy(() => import('./components/MultiView').then((m) => ({ default: m.MultiView })));
const AdminDashboard = lazy(() => import('./components/AdminDashboard').then((m) => ({ default: m.AdminDashboard })));
const ChannelDetail = lazy(() => import('./components/ChannelDetail').then((m) => ({ default: m.ChannelDetail })));
const ProgrammeTv = lazy(() => import('./components/ProgrammeTv').then((m) => ({ default: m.ProgrammeTv })));
const LinkDevice = lazy(() => import('./components/LinkDevice').then((m) => ({ default: m.LinkDevice })));
const Films = lazy(() => import('./components/Films').then((m) => ({ default: m.Films })));
const Radios = lazy(() => import('./components/Radios').then((m) => ({ default: m.Radios })));
const Legal = lazy(() => import('./components/Legal').then((m) => ({ default: m.Legal })));
import { useAuth } from './store/authStore';
import { useCatalog } from './store/catalogStore';
import { usePlayer, type PlayOptions } from './store/playerStore';
import { useUI } from './store/uiStore';
import { usePrefs } from './store/prefsStore';
import { applyTheme } from './store/settingsStore';
import { initSpatialNav, bindNavigate, focusAutofocus } from './lib/spatialNav';
import { isTV } from './lib/device';
import { applyLang, useT, t as tr } from './lib/i18n';

// Sync the catalog filters <-> the URL query string so a filtered/searched view is
// shareable and survives reload (e.g. /?q=foot&cat=sports&country=FR). Personal
// toggles (favorites, hide-geo) stay out of the URL.
function useFilterUrlSync() {
  const [params, setParams] = useSearchParams();
  const filters = useCatalog((s) => s.filters);
  const setFilters = useCatalog((s) => s.setFilters);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const patch: Partial<Filters> = {};
    const q = params.get('q'); if (q) patch.q = q;
    const cat = params.get('cat'); if (cat) patch.category = cat;
    const country = params.get('country'); if (country) patch.country = country;
    const lang = params.get('lang'); if (lang) patch.language = lang;
    const sort = params.get('sort'); if (sort === 'name' || sort === 'latency') patch.sort = sort;
    if (params.get('online') === '1') patch.onlineOnly = true;
    if (params.get('foot') === '1') patch.foot = true;
    if (Object.keys(patch).length) setFilters(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    const next = new URLSearchParams();
    if (filters.q.trim()) next.set('q', filters.q.trim());
    if (filters.category) next.set('cat', filters.category);
    if (filters.country) next.set('country', filters.country);
    if (filters.language) next.set('lang', filters.language);
    if (filters.sort && filters.sort !== 'smart') next.set('sort', filters.sort);
    if (filters.onlineOnly) next.set('online', '1');
    if (filters.foot) next.set('foot', '1');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q, filters.category, filters.country, filters.language, filters.sort, filters.onlineOnly, filters.foot]);
}

function Browse() {
  useFilterUrlSync();
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const loadChannels = useCatalog((s) => s.loadChannels);
  const f = useCatalog((s) => s.filters);
  const userId = useAuth((s) => s.user?.id ?? null);
  const premium = useAuth((s) => !!s.user?.premium);
  // The options carry the row the channel came from: zapping stays inside it.
  const onPlay = (ch: Parameters<typeof play>[0], opts?: PlayOptions) => {
    addRecent(ch);
    play(ch, opts);
  };
  // Default view = welcoming home (discover). Any filter/search switches to the grid.
  const isHome = !f.category && !f.country && !f.language && !f.q.trim() && !f.foot && !f.favoritesOnly && !f.onlineOnly && !f.hideGeoBlocked;
  // The grid list loads only when the grid shows (Home has its own rows, TV-11),
  // and again when the account or Premium changes. A filter change already
  // started its own load (setFilters): no second request then.
  const loadedFor = useRef<string | null>(null);
  const catalogKey = `${userId}|${premium}`;
  useEffect(() => {
    if (isHome || loadedFor.current === catalogKey) return;
    loadedFor.current = catalogKey;
    if (!useCatalog.getState().loading) loadChannels();
  }, [isHome, catalogKey, loadChannels]);
  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px]">
        {isHome ? (
          <Home onPlay={onPlay} />
        ) : (
          <>
            <FilterBar />
            <ProgramSearch />
            <ChannelGrid onPlay={onPlay} />
          </>
        )}
      </div>
    </main>
  );
}

function AuthWall() {
  const setLogin = useUI((s) => s.setLogin);
  const t = useT();
  useEffect(() => setLogin(true), [setLogin]);
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Lock size={28} aria-hidden="true" className="text-ink-3" />
      <h1 translate="no" className="brand text-libelle text-ink">NEOWATCH</h1>
      <p className="max-w-xs text-sous text-ink-2">{t('gate.body')}</p>
      <button type="button" data-autofocus="" onClick={() => setLogin(true)} className="btn btn-primary mt-2">
        {t('top.login')}
      </button>
    </main>
  );
}

/** Unknown address: say so, one way back. */
function NotFound() {
  const navigate = useNavigate();
  const t = useT();
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <EmptyState
        icon={<Compass size={36} />}
        title={t('shell.notFoundTitle')}
        body={t('shell.notFoundBody')}
        action={{ label: t('empty.backToChannels'), onClick: () => navigate('/', { replace: true }), variant: 'primary' }}
      />
    </main>
  );
}

/** Gives spatialNav the router (Back from a deep link) and focuses the page's main action on TV. */
function RouterBridge() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    bindNavigate((to, o) => navigate(to, o));
    return () => bindNavigate(null);
  }, [navigate]);
  // A new page on TV: its main action ([data-autofocus]) takes the focus once it renders.
  useEffect(() => {
    if (!isTV()) return;
    const a = document.activeElement;
    if (a && a !== document.body && document.body.contains(a) && a.closest('main')) (a as HTMLElement).blur();
    focusAutofocus(4000);
  }, [pathname]);
  // Same page, new view (a category tile opens the grid, Back returns Home): the
  // element that had the focus is gone. Only when nothing holds it (never steal it
  // from a filter or the search box): the page's main action, else its first card.
  const lastSearch = useRef(search);
  useEffect(() => {
    if (lastSearch.current === search) return; // first render: the effect above owns it
    lastSearch.current = search;
    if (!isTV()) return;
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement) return;
    focusAutofocus(4000, '[data-card]');
  }, [search]);
  return null;
}

function AppShell() {
  const { init, ready, config, user, authPending } = useAuth();
  const loadMeta = useCatalog((s) => s.loadMeta);
  const current = usePlayer((s) => s.current);
  const multiOpen = usePlayer((s) => s.multiOpen);

  useEffect(() => {
    applyTheme();
    applyLang();
    init();
    initSpatialNav();
  }, [init]);

  // On sign-in (incl. QR pairing on a TV), pick up the multi-screen config saved on
  // the account so the mosaic set up on a computer is ready on the TV.
  useEffect(() => {
    if (user) usePlayer.getState().hydrateMulti(user.multi);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Returning from Stripe checkout: poll for the webhook-granted premium, then
  // refresh the catalog + home so unlocked channels appear. Own effect + cleanup.
  useEffect(() => {
    if (typeof window === 'undefined' || !/[?&]upgraded=1/.test(window.location.search)) return;
    window.history.replaceState({}, '', window.location.pathname);
    let tries = 0;
    const iv = setInterval(async () => {
      await useAuth.getState().refresh();
      if (useAuth.getState().user?.premium || ++tries >= 6) {
        clearInterval(iv);
        useCatalog.getState().loadChannels();
        useUI.getState().bumpHome();
      }
    }, 2500);
    return () => clearInterval(iv);
  }, []);

  // Load catalog once we're allowed to (public, or authenticated in SaaS mode).
  // The discover Home is the consistent default; premium prefs (hidden/pinned
  // categories) still apply to the home/grid.
  // Keyed on what changes the catalog (the gate, the account, Premium), never on
  // the user object itself: /auth/me hands a new object on every refresh, and a
  // favorite or a renewal must not reload the whole catalog (WEB-9).
  // A held token whose /auth/me has not answered yet (502 during a deploy, an
  // offline TV) is not "signed out": wait for it instead of showing the wall.
  const locked = !!config?.requireAuth && !user;
  const gated = locked && !authPending;
  const userId = user?.id ?? null;
  const premium = !!user?.premium;
  useEffect(() => {
    if (!ready || locked) return;
    loadMeta();
    if (userId) usePrefs.getState().load();
    else usePrefs.getState().reset();
  }, [ready, locked, userId, premium, loadMeta]);

  if (!ready || (locked && authPending)) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface" aria-busy="true">
        <p translate="no" className="brand text-libelle text-ink-2">NEOWATCH</p>
        <Spinner />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <RouterBridge />
      <div className="flex h-screen flex-col bg-surface text-ink">
        <TopBar />
        <PromoStrip />
        <div className="flex min-h-0 flex-1 flex-col pb-[var(--dock-h)] md:pb-0">
        <Routes>
          <Route path="/" element={gated ? <AuthWall /> : <Browse />} />
          <Route
            path="/admin"
            element={
              !ready ? (
                <div className="flex flex-1 items-center justify-center"><Spinner /></div>
              ) : user?.role === 'admin' ? (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                  <AdminDashboard />
                </Suspense>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/chaine/:id"
            element={
              gated ? <AuthWall /> : (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                  <ChannelDetail />
                </Suspense>
              )
            }
          />
          <Route
            path="/programme-tv"
            element={
              gated ? <AuthWall /> : (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                  <ProgrammeTv />
                </Suspense>
              )
            }
          />
          <Route
            path="/link"
            element={
              <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                <LinkDevice />
              </Suspense>
            }
          />
          <Route
            path="/films"
            element={
              gated ? <AuthWall /> : (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                  <Films />
                </Suspense>
              )
            }
          />
          <Route
            path="/radios"
            element={
              gated ? <AuthWall /> : (
                <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                  <Radios />
                </Suspense>
              )
            }
          />
          <Route
            path="/legal"
            element={
              <Suspense fallback={<div className="flex flex-1 items-center justify-center"><Spinner /></div>}>
                <Legal />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </div>
        <Dock />
      </div>

      {/* Global overlays (lazy: load hls.js only when first used) */}
      <Suspense fallback={null}>
        {current && <Player key={current.url} channel={current} />}
        {multiOpen && <MultiView />}
      </Suspense>
      <Settings />
      <Login />
      <Pricing />
      <Preferences />
      <Account />
      <Install />
      <ToastHost />
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
