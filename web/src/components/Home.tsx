import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Shuffle, CloudOff } from 'lucide-react';
import { api } from '@/lib/api';
import { fetchNowNext, type NowNext } from '@/lib/epg';
import { categoryLabel } from '@/lib/format';
import { fmtAge, fmtTime, hasKey, useI18n, useT } from '@/lib/i18n';
import type { Channel, Filters, HomeData, HomeRail } from '@/types';
import { useCatalog } from '@/store/catalogStore';
import { useUI, toast } from '@/store/uiStore';
import { usePlayer } from '@/store/playerStore';
import { usePrefs } from '@/store/prefsStore';
import { effectiveTheme, useSettings } from '@/store/settingsStore';
import { Rail, ROW_MAX } from './Rail';
import { countryLabel, languageLabel, monogram, qualityLabel, type PlayFn } from './ChannelCard';
import { Button, CardSkeleton, EmptyState, LivePill, Meta } from './ui';
import { insideTvShell } from './Install';
import { imgSrc } from '@/lib/img';
import { isTV, prefersReducedMotion } from '@/lib/device';

// Home (spec 2.2, 2.3): a hero of at most 45 % of the screen so row 1 shows in
// the first screen, then rows of 8 cards + "See all", the Browse row of
// categories, and the footer. No rotation, no Ken Burns: the channel you read is
// the channel "Watch now" plays.

type Featured = HomeData['featured'][number];

// Hero artwork by the channel's OWN category, never by rail (DESIGN-1). Anything
// else gets the logo window. /hero.webp is never used here.
const AMBIANCE: Record<string, string> = {
  sports: 'sport', foot: 'sport',
  movies: 'cinema', series: 'cinema', animation: 'cinema', classic: 'cinema',
  music: 'music',
  news: 'news', business: 'news', weather: 'news', legislative: 'news', documentary: 'news',
};
function ambianceOf(ch: Featured | null): string | null {
  if (!ch) return null;
  const c0 = ch.categories?.[0];
  if (c0 && AMBIANCE[c0]) return `/ambiance/${AMBIANCE[c0]}.webp`;
  // The server's heroCategory counts only when the channel really carries it.
  const hc = ch.heroCategory;
  if (hc && ch.categories?.includes(hc) && AMBIANCE[hc]) return `/ambiance/${AMBIANCE[hc]}.webp`;
  return null;
}

// A complete filter patch, so a tile or "See all" replaces the view instead of merging.
const VIEW: Partial<Filters> = { category: null, country: null, language: null, q: '', foot: false, favoritesOnly: false, onlineOnly: false, hideGeoBlocked: false };

const TILES: { key: string; cat: string; art: string; apply: Partial<Filters> }[] = [
  { key: 'foot', cat: 'sports', art: 'foot', apply: { ...VIEW, foot: true } },
  { key: 'sports', cat: 'sports', art: 'sports', apply: { ...VIEW, category: 'sports' } },
  { key: 'news', cat: 'news', art: 'news', apply: { ...VIEW, category: 'news' } },
  { key: 'movies', cat: 'movies', art: 'movies', apply: { ...VIEW, category: 'movies' } },
  { key: 'series', cat: 'series', art: 'series', apply: { ...VIEW, category: 'series' } },
  { key: 'kids', cat: 'kids', art: 'kids', apply: { ...VIEW, category: 'kids' } },
  { key: 'music', cat: 'music', art: 'music', apply: { ...VIEW, category: 'music' } },
  { key: 'documentary', cat: 'documentary', art: 'documentary', apply: { ...VIEW, category: 'documentary' } },
];

const STALE_MS = 30 * 60 * 1000; // signed links last 2 h; the server re-signs every 90 min
let homeDefaultApplied = false; // prefs.home is applied once per page load (WEB-5)

// TV hero (spec 2.2): 600 of the 1080 design units while the focus is in it, 320
// once the focus moves into the rows. Transform + opacity only, never a height: the
// whole page slides up by the difference (the hero's top goes under the header), so
// nothing is laid out again. Back to 600 when the focus returns to the hero.
const HERO_TV_U = 600;
const HERO_TV_COLLAPSED_U = 320;
const smoothOrNot = (): ScrollBehavior =>
  prefersReducedMotion() || document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth';
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement || null; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
  return null;
}

const railCategory = (r: HomeRail) => (r.filter?.category as string | null) || (r.filter?.foot ? 'sports' : null);

export function Home({ onPlay }: { onPlay: PlayFn }) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const navigate = useNavigate();
  const setFilters = useCatalog((s) => s.setFilters);
  const favorites = useCatalog((s) => s.favorites);
  const recents = useCatalog((s) => s.recents);
  const meta = useCatalog((s) => s.meta);
  const setPricing = useUI((s) => s.setPricing);
  const setInstall = useUI((s) => s.setInstall);
  const homeVersion = useUI((s) => s.homeVersion);
  const openMulti = usePlayer((s) => s.openMulti);
  const prefs = usePrefs((s) => s.prefs);
  const prefsLoaded = usePrefs((s) => s.loaded);

  const [data, setData] = useState<HomeData | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [epg, setEpg] = useState<Record<string, NowNext>>({});
  const [heroKey, setHeroKey] = useState<string | null>(null);
  const loadedAt = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(false);

  // TV: collapse the hero when the focus enters the rows, expand it when the focus
  // comes back to the hero, or goes up to the header while the page is at its top
  // (spatialNav often picks the header from a row-1 card that is not under the
  // buttons). Anything else outside Home (player, dialogs) leaves it as it is.
  useEffect(() => {
    const root = rootRef.current;
    if (!isTV() || !root) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      const hero = root.querySelector<HTMLElement>('section[data-hero]');
      const sc = scrollerOf(root);
      if (!target || !hero || !sc) return;
      let expand: boolean;
      if (root.contains(target)) expand = hero.contains(target);
      else if (!sc.contains(target) && sc.scrollTop < 2 && target.getBoundingClientRect().bottom <= sc.getBoundingClientRect().top + 1) expand = true;
      else return;
      if (expand === !collapsedRef.current) return;
      collapsedRef.current = !expand;
      setCollapsed(!expand);
      // After spatialNav's own scrollIntoView (computed on the expanded layout): the
      // page top is where the hero lives, and the first row fits under the collapsed one.
      requestAnimationFrame(() => {
        if (expand) return sc.scrollTo({ top: 0, behavior: smoothOrNot() });
        const shift = (hero.offsetHeight * (HERO_TV_U - HERO_TV_COLLAPSED_U)) / HERO_TV_U;
        const tf = getComputedStyle(root).transform;
        const m = new DOMMatrixReadOnly(tf === 'none' ? undefined : tf);
        const r = target.getBoundingClientRect();
        const bottomAtTop = r.bottom - sc.getBoundingClientRect().top + sc.scrollTop - m.m42 - shift;
        if (bottomAtTop <= sc.clientHeight) sc.scrollTo({ top: 0, behavior: smoothOrNot() });
      });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // Home payload (localized rail titles via ?lang). A failed refresh keeps the
  // rows already shown; a failed first load shows one honest state + Retry.
  useEffect(() => {
    let alive = true;
    api
      .get<HomeData>(`/catalog/home?lang=${lang}`)
      .then((d) => {
        if (!alive) return;
        loadedAt.current = Date.now();
        setData({ rails: d.rails || [], featured: d.featured || [] });
        setFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [homeVersion, lang, reload]);

  // WEB-22: a TV left on Home refetches before its signed links expire, and
  // when it comes back to the foreground with an old payload.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible' && loadedAt.current && Date.now() - loadedAt.current > STALE_MS) setReload((n) => n + 1);
    };
    const iv = setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  // WEB-5: premium curation. Hidden categories drop rows, tiles and cards;
  // pinned categories come first (in the order the user pinned them).
  const hidden = useMemo(() => new Set(prefs.hiddenCategories), [prefs.hiddenCategories]);
  const pinRank = useCallback(
    (cat: string | null) => {
      const i = cat ? prefs.pinnedCategories.indexOf(cat) : -1;
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    },
    [prefs.pinnedCategories]
  );
  const keep = useCallback((c: Channel) => !(c.categories?.length && c.categories.every((x) => hidden.has(x))), [hidden]);

  const featured = useMemo(() => (data?.featured || []).filter(keep), [data, keep]);
  const rails = useMemo(() => {
    const list = (data?.rails || [])
      .filter((r) => {
        const cat = railCategory(r);
        return !(cat && hidden.has(cat));
      })
      .map((r) => ({ ...r, channels: r.channels.filter(keep) }))
      .filter((r) => r.channels.length);
    return list.map((r, i) => ({ r, i })).sort((a, b) => pinRank(railCategory(a.r)) - pinRank(railCategory(b.r)) || a.i - b.i).map((x) => x.r);
  }, [data, hidden, keep, pinRank]);
  const tiles = useMemo(
    () => TILES.filter((x) => !hidden.has(x.cat)).map((x, i) => ({ x, i })).sort((a, b) => pinRank(a.x.cat) - pinRank(b.x.cat) || a.i - b.i).map((v) => v.x),
    [hidden, pinRank]
  );

  // WEB-5: the premium "default home" (a category / country / language), once.
  useEffect(() => {
    if (!prefsLoaded || homeDefaultApplied) return;
    homeDefaultApplied = true;
    const h = prefs.home;
    if (!(h.category || h.country || h.language || h.foot)) return;
    if (/[?&](q|cat|country|lang|foot|online|sort)=/.test(window.location.search)) return;
    setFilters({ ...VIEW, category: h.category, country: h.country, language: h.language, foot: !!h.foot });
  }, [prefsLoaded, prefs.home, setFilters]);

  // The hero channel: the first featured with artwork, else the first one. It
  // stays the same across refreshes while it is still featured (no swap under a
  // focused "Watch now").
  const hero: Featured | null = useMemo(() => {
    if (!featured.length) return null;
    const kept = heroKey ? featured.find((f) => f.url === heroKey) : undefined;
    return kept || featured.find((f) => ambianceOf(f)) || featured[0];
  }, [featured, heroKey]);
  useEffect(() => {
    if (hero && hero.url !== heroKey) setHeroKey(hero.url);
  }, [hero, heroKey]);

  // Now / next for the featured channels (hero sentence + Live now cards),
  // refetched when the hero programme ends (capped at 30 min).
  const featIds = useMemo(() => featured.map((c) => c.channelId).filter(Boolean).join(','), [featured]);
  const [epgTick, setEpgTick] = useState(0);
  useEffect(() => {
    if (!featIds) {
      setEpg({});
      return;
    }
    let alive = true;
    fetchNowNext(featIds.split(',')).then((m) => alive && setEpg(m));
    return () => {
      alive = false;
    };
  }, [featIds, epgTick]);
  const heroNow = hero?.channelId ? epg[hero.channelId]?.now ?? null : null;
  useEffect(() => {
    if (!heroNow?.stop) return;
    const wait = Math.min(Math.max(heroNow.stop - Date.now() + 5000, 15000), STALE_MS);
    const id = setTimeout(() => setEpgTick((n) => n + 1), wait);
    return () => clearTimeout(id);
  }, [heroNow?.stop]);

  const play: PlayFn = (ch, opts) => (ch.locked ? setPricing(true) : onPlay(ch, opts));
  const surprise = async () => {
    try {
      const ch = await api.get<Channel>('/catalog/random');
      // Zapping goes on through the picks of the moment (the grid is not loaded on Home).
      if (ch?.url) play(ch, { queue: [ch, ...featured] });
      else toast(t('home.surpriseNone'));
    } catch {
      toast(t('home.surpriseNone'));
    }
  };

  const openFavorites = () => {
    setFilters({ ...VIEW, favoritesOnly: true }); // reloads the list (WEB-6)
  };

  const catCount = (id: string) => meta?.categories.find((c) => c.id === id)?.count;
  const footTotal = data?.rails.find((r) => r.key === 'foot')?.total;
  const liveNowMeta = [t.n('count.channels', featured.length), t('row.pickedNow')];

  return (
    <div
      ref={rootRef}
      // Only the transform changes (reduced motion: index.css zeroes the transition).
      // flow-root keeps the footer's static negative margin inside this box, so the
      // scroll length ends at the footer whether the page is slid up or not.
      className="[:root[data-tv]_&]:flow-root [:root[data-tv]_&]:transition-transform [:root[data-tv]_&]:duration-300 [:root[data-tv]_&]:ease-out"
      style={collapsed ? { transform: 'translateY(calc(-280 * var(--u)))' } : undefined}
    >
      <Hero hero={hero} now={heroNow} collapsed={collapsed} onWatch={() => (hero ? play(hero, { queue: featured }) : surprise())} onSurprise={surprise} />

      {/* Rows. A failed first load: one state with Retry (WEB-24). */}
      {!data && failed ? (
        <EmptyState
          icon={<CloudOff size={40} strokeWidth={1.5} />}
          title={t('home.error')}
          body={t('home.errorBody')}
          action={{ label: t('empty.tryAgain'), onClick: () => setReload((n) => n + 1) }}
        />
      ) : !data ? (
        <RowSkeletons />
      ) : (
        <>
          {featured.length > 0 && <Rail title={t('home.liveNow')} meta={liveNowMeta} channels={featured} onPlay={play} wide epg={epg} />}
          {recents.length > 0 && <Rail title={t('home.resume')} meta={[t.n('count.channels', recents.length)]} channels={recents} onPlay={play} wide />}
          {favorites.length > 0 && (
            <Rail
              title={t('home.myListTitle')}
              meta={[t.n('count.channels', favorites.length)]}
              channels={favorites}
              total={favorites.length}
              onPlay={play}
              onSeeAll={favorites.length > ROW_MAX ? openFavorites : undefined}
            />
          )}
          <Rail title={t('home.browseCategories')} meta={[t.n('count.categories', tiles.length)]}>
            {tiles.map((tile) => (
              <MediaTile
                key={tile.key}
                art={tile.art}
                label={tile.key === 'foot' ? t('cat.foot') : categoryLabel(tile.cat)}
                count={tile.key === 'foot' ? footTotal : catCount(tile.cat)}
                onClick={() => setFilters(tile.apply)}
              />
            ))}
          </Rail>
          {rails.map((rail) => (
            <Rail
              key={rail.key}
              title={hasKey(`rail.${rail.key}`) ? t(`rail.${rail.key}`) : rail.title}
              meta={[t.n('count.channels', rail.total)]}
              channels={rail.channels}
              total={rail.total}
              onPlay={play}
              onSeeAll={() => setFilters({ ...VIEW, ...rail.filter })}
            />
          ))}
        </>
      )}

      <footer className="mt-[calc(var(--ecart-rangees)*2)] border-t [:root[data-tv]_&]:mb-[calc(-280*var(--u))] border-line px-[var(--gouttiere)] pb-12 pt-10">
        <div className="flex flex-wrap gap-x-16 gap-y-10">
          <div className="max-w-[300px]">
            <div className="mb-3 flex items-center gap-2.5">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--red)]" />
              <span translate="no" className="brand text-sous text-ink">NeoWatch</span>
            </div>
            <p className="m-0 text-sous text-ink-2">{t('footer.tagline')}</p>
          </div>
          <FooterCol
            title={t('footer.explore')}
            links={[
              { label: t('footer.liveNow'), onClick: () => setFilters({ ...VIEW, onlineOnly: true }) },
              { label: t('footer.programmeTv'), onClick: () => navigate('/programme-tv') },
              { label: t('top.multi'), onClick: openMulti },
              { label: t('footer.favorites'), onClick: openFavorites },
            ]}
          />
          <FooterCol
            title={t('footer.account')}
            links={[
              { label: t('top.premium'), onClick: () => setPricing(true) },
              // Inside the Android app the app is already installed.
              ...(insideTvShell() ? [] : [{ label: t('footer.installApp'), onClick: () => setInstall(true) }]),
            ]}
          />
          <FooterCol
            title={t('footer.legal')}
            links={[
              { label: t('footer.terms'), onClick: () => navigate('/legal#cgu') },
              { label: t('footer.privacy'), onClick: () => navigate('/legal#confidentialite') },
              { label: t('footer.source'), href: 'https://iptv-org.github.io' },
            ]}
          />
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <span className="text-sous text-ink-3">{t('footer.copyright', { year: String(new Date().getFullYear()) })}</span>
          {meta && <Meta parts={[t.n('count.countries', meta.countries.length), t.n('count.channels', meta.total)]} />}
        </div>
      </footer>
    </div>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────
function Hero({ hero, now, collapsed, onWatch, onSurprise }: { hero: Featured | null; now: NowNext['now']; collapsed: boolean; onWatch: () => void; onSurprise: () => void }) {
  const t = useT();
  useSettings((s) => s.theme); // re-render on a style switch
  // The scrim tokens stay dark in Doux too: doubling them under the art keeps the
  // text column dark, and the primary and the focus ring flip to light so they
  // still stand out on it.
  const heroStyle = {
    background: 'var(--voile-hero), var(--voile-hero), var(--bg-0)',
    ...(effectiveTheme() === 'doux'
      ? { '--primaire-fond': 'var(--encre-image)', '--primaire-encre': 'var(--t1)', '--focus-anneau': 'var(--encre-image)', '--focus-halo': 'var(--t1)' }
      : {}),
  } as React.CSSProperties;
  const amb = ambianceOf(hero);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [hero?.url]);
  const cat = hero?.categories?.find((c) => c !== 'undefined');
  const q = qualityLabel(hero?.quality);
  const country = hero ? countryLabel(hero, t.lang) : null;
  const heroLang = hero ? languageLabel(hero, t.lang) : null;
  const sentence = !hero
    ? t('home.heroEmptyBody')
    : now?.stop
    ? t('hero.until', { title: now.title, time: fmtTime(now.stop) })
    : country
    ? t('hero.liveFrom', { country })
    : t('hero.onAir');

  // Collapsed (TV): the band left is the hero's lower 320 u. The title and the two
  // buttons slide down into it (measured on the untransformed layout), everything
  // else fades. Offsets come from offsetTop, which transforms never change.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<HTMLParagraphElement>(null);
  const [shift, setShift] = useState<{ title: number; actions: number }>({ title: 0, actions: 0 });
  useLayoutEffect(() => {
    if (!collapsed) return;
    const h1 = titleRef.current, actions = actionsRef.current, meta = metaRef.current;
    if (!h1 || !actions) return;
    const col = h1.parentElement as HTMLElement;
    const gap = parseFloat(getComputedStyle(col).rowGap) || 0;
    const end = (el: HTMLElement) => el.offsetTop + el.offsetHeight;
    const toBottom = meta ? end(meta) - end(actions) : 0;
    const toActions = actions.offsetTop - gap - end(h1);
    setShift((s) => (s.title === toActions + toBottom && s.actions === toBottom ? s : { title: toActions + toBottom, actions: toBottom }));
  }, [collapsed, hero?.url, sentence, q, heroLang, t.lang]);
  // Inline, so it wins over each element's own opacity class; index.css zeroes the
  // transitions under reduced motion (OS or in-app setting).
  const fade: React.CSSProperties | undefined = collapsed ? { opacity: 0 } : undefined;
  const slide = (px: number): React.CSSProperties | undefined => (collapsed ? { transform: `translateY(${px}px)` } : undefined);

  return (
    <section
      data-hero=""
      className="relative flex h-[min(60vh,480px)] overflow-hidden sm:h-[min(45vh,420px)] [:root[data-tv]_&]:h-[calc(600*var(--u))]"
      style={heroStyle}
    >
      {/* Visual: the category artwork in the right 62 % ("window"), else the logo window */}
      <div aria-hidden="true" className="absolute inset-0 sm:left-[38%]">
        {amb ? (
          <div key={amb} className="absolute inset-0 animate-fade-in bg-cover bg-center" style={{ backgroundImage: `url(${amb})` }} />
        ) : hero ? (
          <div key={hero.url} className="absolute inset-0 flex animate-fade-in items-start justify-end p-4 transition-opacity duration-300 sm:items-center sm:justify-center sm:p-8" style={fade}>
            <div className="flex aspect-[520/320] w-[46%] max-w-[520px] items-center justify-center rounded-card bg-[var(--surface-carte)] shadow-[inset_0_0_0_1px_var(--line)] sm:w-[78%]">
              {hero.logo && !logoFailed ? (
                <img src={imgSrc(hero.logo)} alt="" width={260} height={160} decoding="async" referrerPolicy="no-referrer" onError={() => setLogoFailed(true)} className="h-auto max-h-[56%] w-auto max-w-[64%] object-contain" />
              ) : (
                <span translate="no" className="font-mono text-titre font-semibold text-ink-2">{monogram(hero.name)}</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div aria-hidden="true" className="scrim-hero pointer-events-none absolute inset-0" />

      {/* Text column on the scrim: no chips behind text laid on the photo */}
      <div className="relative flex w-full max-w-[calc(620px_+_var(--gouttiere))] flex-col justify-end gap-3 px-[var(--gouttiere)] pb-[clamp(16px,3.5vh,36px)]">
        <div className="flex min-w-0 items-center gap-3 transition-opacity duration-300" style={fade} aria-hidden={collapsed || undefined}>
          {hero?.online === true && <LivePill pulse />}
          {hero && (
            <p className="overline m-0 min-w-0 truncate text-on-image opacity-80">
              {cat && <span>{categoryLabel(cat)}</span>}
              {cat && country && <span aria-hidden="true"> · </span>}
              {country && <span translate="no">{country}</span>}
            </p>
          )}
        </div>
        <h1 ref={titleRef} className="text-on-image m-0 line-clamp-2 text-titre font-semibold transition-transform duration-300 ease-out [text-wrap:balance]" style={slide(shift.title)} translate={hero ? 'no' : undefined}>
          {hero ? hero.name : t('home.heroEmptyTitle')}
        </h1>
        <p className="text-on-image m-0 line-clamp-2 max-w-[520px] text-corps opacity-90 transition-opacity duration-300" style={fade} aria-hidden={collapsed || undefined}>{sentence}</p>
        {hero && <span aria-hidden="true" className="thread transition-opacity duration-300" style={fade} />}
        <div ref={actionsRef} className="mt-1 flex flex-wrap items-center gap-2.5 transition-transform duration-300 ease-out" style={slide(shift.actions)}>
          <Button variant="primary" data-autofocus="" icon={<Play size={18} fill="currentColor" aria-hidden="true" />} onClick={onWatch}>
            {t('home.watch')}
          </Button>
          <Button variant="secondary" icon={<Shuffle size={17} aria-hidden="true" />} onClick={onSurprise}>
            {t('home.surprise')}
          </Button>
        </div>
        {hero && (q || heroLang || hero.checkedAt) && (
          <p ref={metaRef} className="meta text-on-image m-0 opacity-75 transition-opacity duration-300" style={fade} aria-hidden={collapsed || undefined}>
            {q && <span translate="no">{q}</span>}
            {heroLang && <span translate="no">{heroLang}</span>}
            {hero.checkedAt ? <span>{t('meta.checked', { age: fmtAge(hero.checkedAt) })}</span> : null}
          </p>
        )}
      </div>
    </section>
  );
}

// ── Browse row: one media card per category (art under --voile-image, no emoji) ──
function MediaTile({ art, label, count, onClick }: { art: string; label: string; count?: number; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" onClick={onClick} className="lift card-surface w-[var(--carte-l)] shrink-0 snap-start self-start text-left">
      <img src={`/tiles/${art}.webp`} alt="" width={288} height={162} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
      <span aria-hidden="true" className="absolute inset-0" style={{ background: 'var(--voile-image)' }} />
      <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-[var(--pad-carte)]">
        <span className="text-on-image text-carte font-semibold">{label}</span>
        {count != null && <span className="text-on-image font-mono text-meta opacity-80">{t.n('count.channels', count)}</span>}
      </span>
    </button>
  );
}

function RowSkeletons() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((r) => (
        <div key={r} className="mt-[var(--ecart-rangees)]">
          <div className="mb-3 px-[var(--gouttiere)]">
            <div className="h-4 w-44 rounded bg-[var(--bg-2)]" />
          </div>
          <div className="flex gap-[var(--ecart-cartes)] overflow-hidden pl-[var(--gouttiere)]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-[var(--carte-l)] shrink-0">
                <CardSkeleton />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type FooterLink = { label: string; onClick?: () => void; href?: string };
function FooterCol({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div className="flex flex-col items-start gap-2.5">
      <p className="overline m-0 mb-0.5">{title}</p>
      {links.map((l) =>
        l.href ? (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="text-sous text-ink-2 hover:text-ink">
            {l.label}
          </a>
        ) : (
          <button key={l.label} type="button" onClick={l.onClick} className="text-left text-sous text-ink-2 hover:text-ink">
            {l.label}
          </button>
        )
      )}
    </div>
  );
}
