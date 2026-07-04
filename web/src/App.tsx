import { useEffect, useRef, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import type { Filters } from '@/types';
import { Radio, Lock } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { PromoStrip } from './components/PromoStrip';
import { FilterBar } from './components/FilterBar';
import { ChannelGrid } from './components/ChannelGrid';
import { Home } from './components/Home';
import { Install } from './components/Install';
import { Settings } from './components/Settings';
import { Login } from './components/Login';
import { Pricing } from './components/Pricing';
import { AdBanner } from './components/AdBanner';
import { ProgramSearch } from './components/ProgramSearch';
import { Preferences } from './components/Preferences';
import { Account } from './components/Account';
import { Spinner } from './components/ui';

// Lazy-loaded: these pull in hls.js — keep it out of the initial bundle so the
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
import { usePlayer } from './store/playerStore';
import { useUI } from './store/uiStore';
import { usePrefs } from './store/prefsStore';
import { applyTheme } from './store/settingsStore';
import { initSpatialNav } from './lib/spatialNav';
import { applyLang, useT } from './lib/i18n';

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
  const f = useCatalog((s) => s.filters);
  const onPlay = (ch: Parameters<typeof play>[0]) => {
    addRecent(ch);
    play(ch);
  };
  // Default view = welcoming home (discover). Any filter/search switches to the grid.
  const isHome = !f.category && !f.country && !f.language && !f.q.trim() && !f.foot && !f.favoritesOnly && !f.onlineOnly && !f.hideGeoBlocked;
  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px]">
        <AdBanner />
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
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <Lock size={24} />
      </div>
      <h2 className="font-mono text-lg font-bold tracking-widest text-ink">NEO<span className="text-accent">WATCH</span></h2>
      <p className="max-w-xs text-sm text-ink/50">{t('gate.body')}</p>
    </div>
  );
}

export default function App() {
  const { init, ready, config, user } = useAuth();
  const loadMeta = useCatalog((s) => s.loadMeta);
  const loadChannels = useCatalog((s) => s.loadChannels);
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
  const gated = config?.requireAuth && !user;
  useEffect(() => {
    if (!ready || gated) return;
    loadMeta();
    if (user) usePrefs.getState().load();
    else usePrefs.getState().reset();
    loadChannels();
  }, [ready, gated, user, loadMeta, loadChannels]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-3">
          <Radio className="animate-pulse-live text-accent" size={32} />
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col bg-surface text-ink">
        <TopBar />
        <PromoStrip />
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
          <Route path="*" element={gated ? <AuthWall /> : <Browse />} />
        </Routes>
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
    </BrowserRouter>
  );
}
