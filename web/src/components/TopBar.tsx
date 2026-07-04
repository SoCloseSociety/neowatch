import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Search, Grip, Settings, LogIn, ShieldQuestion, Download, Crown, MonitorDown, Languages, Check, CalendarClock, Shuffle, Film, X, Clock, RadioTower } from 'lucide-react';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer } from '@/store/playerStore';
import { useUI } from '@/store/uiStore';
import { useAuth } from '@/store/authStore';
import { useT, useI18n, LANGS } from '@/lib/i18n';
import { debounce } from '@/lib/format';
import { api } from '@/lib/api';
import type { Channel } from '@/types';

// Captured beforeinstallprompt event for the PWA install button. The event can
// fire before React mounts, so we cache it and notify via a custom event.
let deferredPrompt: any = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  window.dispatchEvent(new Event('neowatch:installable'));
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  window.dispatchEvent(new Event('neowatch:installed'));
});

export function TopBar() {
  const navigate = useNavigate();
  const meta = useCatalog((s) => s.meta);
  const setFilters = useCatalog((s) => s.setFilters);
  const resetFilters = useCatalog((s) => s.resetFilters);
  const filterQ = useCatalog((s) => s.filters.q);
  const multiCount = usePlayer((s) => s.multi.length);
  const openMulti = usePlayer((s) => s.openMulti);
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const setPricing0 = useUI((s) => s.setPricing);
  const { setSettings, setLogin, setPricing, setAccount, setInstall } = useUI();
  const { user, isAdmin } = useAuth();
  const t = useT();
  const [surprising, setSurprising] = useState(false);

  // One-click "Surprise me": fetch a random online channel and play it.
  const surprise = async () => {
    if (surprising) return;
    setSurprising(true);
    try {
      const ch = await api.get<Channel>('/catalog/random');
      if (ch?.locked) { setPricing0(true); return; }
      if (ch?.url) { addRecent(ch); play(ch); }
    } catch { /* nothing available right now */ }
    finally { setSurprising(false); }
  };
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(filterQ);
  const [canInstall, setCanInstall] = useState(!!deferredPrompt);
  const debounced = useRef(debounce((q: string) => setFilters({ q }), 350)).current;
  // Search history (suggestions): a settled query is remembered after typing stops.
  const searchHistory = useCatalog((s) => s.searchHistory);
  const addSearchTerm = useCatalog((s) => s.addSearchTerm);
  const clearSearchHistory = useCatalog((s) => s.clearSearchHistory);
  const commitHistory = useRef(debounce((q: string) => addSearchTerm(q), 1200)).current;
  const [searchFocus, setSearchFocus] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Run a search now (Enter / picking a suggestion): no debounce, remember the
  // term, and make sure the results grid is showing.
  const runSearch = (term: string) => {
    const q = term.trim();
    setLocal(q);
    debounced.cancel();
    commitHistory.cancel();
    setFilters({ q });
    if (q.length >= 2) addSearchTerm(q);
    setSearchFocus(false);
    navigate('/');
  };
  const clearSearch = () => { debounced.cancel(); commitHistory.cancel(); setLocal(''); setFilters({ q: '' }); };
  const showSuggestions = searchFocus && !local.trim() && searchHistory.length > 0;

  // Close the language menu on outside click / Escape.
  useEffect(() => {
    if (!langOpen) return;
    const onDoc = (e: MouseEvent) => { if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLangOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [langOpen]);

  useEffect(() => {
    setLocal(filterQ);
  }, [filterQ]);

  // Close the search-suggestions dropdown on outside click / Escape.
  useEffect(() => {
    if (!searchFocus) return;
    const onDoc = (e: MouseEvent) => { if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchFocus(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSearchFocus(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [searchFocus]);

  // NEOWATCH logo = home = clear every filter and show all channels.
  const goHome = () => {
    resetFilters();
    navigate('/');
  };

  useEffect(() => {
    const onAvail = () => setCanInstall(true);
    const onInstalled = () => setCanInstall(false);
    window.addEventListener('neowatch:installable', onAvail);
    window.addEventListener('neowatch:installed', onInstalled);
    return () => {
      window.removeEventListener('neowatch:installable', onAvail);
      window.removeEventListener('neowatch:installed', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    setCanInstall(false);
  };

  const initials = user ? user.email.slice(0, 2).toUpperCase() : '';

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-surface/75 backdrop-blur-xl backdrop-saturate-150">
    <div className="mx-auto flex h-[60px] w-full max-w-[1760px] items-center gap-2.5 px-3 sm:gap-3 sm:px-[clamp(16px,2.6vw,38px)]">
      {/* Brand */}
      <button onClick={goHome} className="flex shrink-0 items-center gap-2.5" title="Accueil -- toutes les chaînes">
        <span className="inline-flex h-2.5 w-2.5 animate-pulse-red rounded-full bg-live shadow-live shadow-[0_0_12px_rgba(255,59,71,0.9)]" />
        <span className="hidden text-[17px] font-extrabold tracking-[0.16em] text-ink sm:inline">
          NEO<span className="text-accent">WATCH</span>
        </span>
      </button>

      {/* Search pill */}
      <div ref={searchRef} className="relative mx-0.5 flex-1 sm:mx-2 sm:max-w-[520px]">
        <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          value={local}
          onFocus={() => setSearchFocus(true)}
          onChange={(e) => {
            const v = e.target.value;
            setLocal(v);
            debounced(v);
            if (v.trim().length >= 2) commitHistory(v); // remember once typing settles
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); runSearch(local); }
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          className="h-[38px] w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] pl-9 pr-9 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
        {local && (
          <button
            onClick={clearSearch}
            aria-label={t('search.clear')}
            className="absolute right-2.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-3 hover:bg-white/10 hover:text-ink"
          >
            <X size={14} />
          </button>
        )}

        {/* Recent-searches suggestions (shown on focus when the box is empty) --
            one-tap re-search, a big help with a TV remote. */}
        {showSuggestions && (
          <div className="absolute left-0 right-0 top-[44px] z-50 overflow-hidden rounded-xl border border-white/10 bg-panel/95 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-ink-3">
              <span>{t('search.recent')}</span>
              <button onClick={clearSearchHistory} className="rounded px-1.5 py-0.5 font-semibold normal-case tracking-normal text-ink-3 hover:text-rose-400">{t('search.clear')}</button>
            </div>
            {searchHistory.map((term) => (
              <button
                key={term}
                onClick={() => runSearch(term)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-white/5 hover:text-ink focus:bg-white/5 focus:text-ink focus:outline-none"
              >
                <Clock size={13} className="shrink-0 text-ink-3" />
                <span className="truncate">{term}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Online count — click to browse online-only channels */}
      {meta && (
        <button
          onClick={() => setFilters({ onlineOnly: true })}
          title={t('filter.online')}
          className="hidden items-center gap-2 rounded-[9px] border border-white/[0.08] px-2.5 py-2 font-mono text-[10px] font-semibold text-ink-2 hover:border-ok/50 hover:text-ink lg:flex"
        >
          <span className="h-1.5 w-1.5 animate-pulse-green rounded-full bg-ok" />
          {(meta.online ?? meta.total).toLocaleString('fr')} {t('top.online')}
        </button>
      )}

      {canInstall && (
        <button onClick={install} aria-label="Installer" className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent sm:grid" title="Installer l'app">
          <Download size={16} />
        </button>
      )}

      {/* Films (public-domain VOD) */}
      <button onClick={() => navigate('/films')} aria-label={t('films.title')} title={t('films.title')} className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent sm:grid">
        <Film size={16} />
      </button>

      {/* Internet radio */}
      <button onClick={() => navigate('/radios')} aria-label={t('radio.title')} title={t('radio.title')} className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent sm:grid">
        <RadioTower size={16} />
      </button>

      {/* Programme TV (EPG grid) */}
      <button onClick={() => navigate('/programme-tv')} aria-label={t('programme.title')} title={t('programme.title')} className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent sm:grid">
        <CalendarClock size={16} />
      </button>

      {/* Surprise me -- one-click random channel */}
      <button onClick={surprise} aria-label={t('home.surprise')} title={t('home.surprise')} className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent">
        <Shuffle size={16} className={surprising ? 'animate-spin' : ''} />
      </button>

      {/* Multi-screen */}
      <button
        onClick={openMulti}
        className={clsx(
          'relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border transition-colors',
          multiCount ? 'border-accent/40 bg-accent/[0.12] text-accent' : 'border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent'
        )}
        title="Multi-écran"
      >
        <Grip size={16} />
        {multiCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-live px-1 font-mono text-[9px] font-bold text-white">
            {multiCount}
          </span>
        )}
      </button>

      {/* Premium / PRO */}
      {!user?.premium ? (
        <button
          onClick={() => setPricing(true)}
          className="flex h-[38px] items-center gap-1.5 rounded-[10px] border border-gold/40 bg-gold/[0.08] px-3 text-[12.5px] font-bold text-gold hover:bg-gold/[0.16]"
          title="Passer Premium"
        >
          <Crown size={15} /> <span className="hidden sm:inline">{t('top.premium')}</span>
        </button>
      ) : (
        <span className="hidden h-[38px] items-center gap-1.5 rounded-[10px] border border-gold/30 bg-gold/10 px-3 font-mono text-[11px] font-extrabold tracking-wider text-gold sm:flex" title="Compte Premium">
          <Crown size={13} /> PRO
        </span>
      )}

      <button onClick={() => setInstall(true)} aria-label="Installer (TV / mobile)" className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent sm:grid" title="Installer (TV / mobile)">
        <MonitorDown size={16} />
      </button>

      {/* Language switcher */}
      <div ref={langRef} className="relative">
        <button
          onClick={() => setLangOpen((o) => !o)}
          aria-label={t('set.language')}
          title={t('set.language')}
          className={clsx('grid h-[38px] w-[38px] place-items-center rounded-[10px] border transition-colors', langOpen ? 'border-accent/40 bg-accent/[0.12] text-accent' : 'border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent')}
        >
          <Languages size={16} />
        </button>
        {langOpen && (
          <div className="absolute right-0 top-[46px] z-50 w-40 overflow-hidden rounded-xl border border-white/10 bg-panel p-1 shadow-2xl animate-fade-in">
            {LANGS.map((l) => (
              <button
                key={l.code}
                onClick={() => { setLang(l.code); setLangOpen(false); }}
                className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]', lang === l.code ? 'bg-accent/10 text-accent' : 'text-ink/80 hover:bg-white/5')}
              >
                <span className="text-base">{l.flag}</span> {l.label}
                {lang === l.code && <Check size={14} className="ml-auto" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <button onClick={() => setSettings(true)} aria-label={t('top.settings')} className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent" title={t('top.settings')}>
        <Settings size={16} />
      </button>

      {isAdmin() && (
        <button onClick={() => navigate('/admin')} aria-label="Admin" className="hidden h-[38px] w-[38px] place-items-center rounded-[10px] border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent sm:grid" title="Admin">
          <ShieldQuestion size={16} />
        </button>
      )}

      {user ? (
        <button
          onClick={() => setAccount(true)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-[#7C5CFC] text-[13px] font-extrabold text-[#06151a]"
          title={`Mon compte (${user.email})`}
        >
          {initials}
        </button>
      ) : (
        <button
          onClick={() => setLogin(true)}
          className="flex h-[38px] items-center gap-1.5 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-[12.5px] text-ink-2 hover:border-accent hover:text-accent"
        >
          <LogIn size={15} /> <span className="hidden sm:inline">{t('top.login')}</span>
        </button>
      )}
    </div>
    </header>
  );
}
