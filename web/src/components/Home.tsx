import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Lock, Plus, Crown, Sparkles, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { fetchNowNext, fmtTime, type NowNext } from '@/lib/epg';
import type { Channel, HomeData, Filters } from '@/types';
import { useCatalog } from '@/store/catalogStore';
import { useUI } from '@/store/uiStore';
import { usePlayer } from '@/store/playerStore';
import { useAuth } from '@/store/authStore';
import { useT, useI18n } from '@/lib/i18n';
import { Rail } from './Rail';
import { CardSkeleton } from './ui';

const TILES: { label: string; icon: string; art: string; cat: string; apply: Partial<Filters> }[] = [
  { label: 'Foot', icon: '⚽', art: 'foot', cat: 'sports', apply: { foot: true } },
  { label: 'Sport', icon: '🏆', art: 'sports', cat: 'sports', apply: { category: 'sports' } },
  { label: 'Actu', icon: '📰', art: 'news', cat: 'news', apply: { category: 'news' } },
  { label: 'Films', icon: '🎬', art: 'movies', cat: 'movies', apply: { category: 'movies' } },
  { label: 'Séries', icon: '📺', art: 'series', cat: 'series', apply: { category: 'series' } },
  { label: 'Enfants', icon: '🧸', art: 'kids', cat: 'kids', apply: { category: 'kids' } },
  { label: 'Musique', icon: '🎵', art: 'music', cat: 'music', apply: { category: 'music' } },
  { label: 'Docs', icon: '🌍', art: 'documentary', cat: 'documentary', apply: { category: 'documentary' } },
];

const AMBIANCE: Record<string, string> = {
  foot: 'sport', sports: 'sport', movies: 'cinema', series: 'cinema',
  music: 'music', news: 'news', documentary: 'news', entertainment: 'news', general: 'news',
};

export function Home({ onPlay }: { onPlay: (ch: Channel) => void }) {
  const setFilters = useCatalog((s) => s.setFilters);
  const favorites = useCatalog((s) => s.favorites);
  const recents = useCatalog((s) => s.recents);
  const meta = useCatalog((s) => s.meta);
  const toggleFavorite = useCatalog((s) => s.toggleFavorite);
  const isFavorite = useCatalog((s) => s.isFavorite);
  const setPricing = useUI((s) => s.setPricing);
  const setInstall = useUI((s) => s.setInstall);
  const openMulti = usePlayer((s) => s.openMulti);
  const homeVersion = useUI((s) => s.homeVersion);
  const isPremium = useAuth((s) => s.isPremium());
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const navigate = useNavigate();
  const [data, setData] = useState<HomeData | null>(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [featEpg, setFeatEpg] = useState<Record<string, NowNext>>({});

  // Language-aware home: channels in the viewer's language are boosted to the top.
  useEffect(() => {
    let alive = true;
    api.get<HomeData>(`/catalog/home?lang=${lang}`).then((d) => alive && setData(d)).catch(() => alive && setData({ rails: [], featured: [] }));
    return () => { alive = false; };
  }, [homeVersion, lang]);

  useEffect(() => {
    if (!data?.featured?.length) return;
    const t = setInterval(() => setHeroIdx((i) => (i + 1) % data.featured.length), 7000);
    return () => clearInterval(t);
  }, [data]);

  // Now/next for the featured "live now" channels (enriches their rail cards).
  useEffect(() => {
    const ids = (data?.featured || []).map((c) => c.channelId).filter(Boolean) as string[];
    if (!ids.length) { setFeatEpg({}); return; }
    let alive = true;
    fetchNowNext(ids).then((m) => alive && setFeatEpg(m));
    return () => { alive = false; };
  }, [data]);

  const feat = data?.featured || [];
  const hero = feat.length ? feat[heroIdx % feat.length] : null;

  // Now/next for the spotlighted channel, reused from the featured EPG batch
  // (no extra fetch on hero rotation).
  const heroEpg = hero?.channelId ? featEpg[hero.channelId] : null;
  const now = heroEpg?.now ?? null;
  const progress = now && now.stop ? Math.min(100, Math.max(0, ((Date.now() - now.start) / (now.stop - now.start)) * 100)) : null;
  const amb = hero?.railKey && AMBIANCE[hero.railKey] ? `/ambiance/${AMBIANCE[hero.railKey]}.webp` : null;
  const heroBg = amb ? `url(${amb}), url(/hero.webp)` : 'url(/hero.webp)';
  const catCount = (id: string) => meta?.categories.find((c) => c.id === id)?.count;

  return (
    <div className="pb-0">
      {/* ============ HERO ============ */}
      <section className="relative flex min-h-[clamp(460px,72vh,680px)] overflow-hidden">
        <div key={amb || 'hero'} className="animate-kenburns absolute inset-0 animate-fade-in bg-cover bg-center" style={{ backgroundImage: heroBg }} />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(10,14,20,.97)_0%,rgba(10,14,20,.82)_30%,rgba(10,14,20,.3)_64%,rgba(10,14,20,.6)_100%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,rgb(var(--surface))_1%,transparent_46%)]" />

        <div className="relative flex w-full flex-wrap items-end gap-7 px-[clamp(16px,2.6vw,40px)] pb-[clamp(28px,4vh,52px)] pt-[clamp(40px,9vh,96px)]">
          <div className="flex max-w-[620px] flex-1 basis-full flex-col gap-4 sm:basis-[380px]">
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-[6px] bg-live px-2.5 py-1.5 font-mono text-[11px] font-bold tracking-[0.12em] text-white">
                <span className="h-[7px] w-[7px] animate-pulse-red rounded-full bg-white" /> EN DIRECT
              </span>
              {hero && <span className="text-[13px] text-ink-2">{hero.railIcon} {hero.railTitle}</span>}
            </div>
            <h1 className="m-0 text-[clamp(34px,5.4vw,68px)] font-extrabold leading-[0.98] tracking-[-0.025em] text-ink">
              {hero ? hero.name : <>{t('home.heroTitle1')} <span className="text-accent">{t('home.heroTitle2')}</span></>}
            </h1>
            <p className="m-0 max-w-[520px] text-[clamp(14px,1.4vw,16px)] text-ink-2">
              {hero
                ? `${hero.flag || '🌐'} ${hero.countryName || t('home.international')} · ${hero.categoryNames?.[0] || t('home.live')} · ${t('home.heroClip')}`
                : t('home.heroTagline')}
            </p>
            {/* Now / next programme (when EPG is available for this channel) */}
            {now && (
              <div className="flex max-w-[520px] flex-col gap-2">
                <div className="flex items-center gap-2.5 font-mono text-[10.5px] tracking-wide">
                  <span className="font-bold text-accent">EN COURS</span>
                  <span className="truncate text-ink-3">{fmtTime(now.start)}{now.stop ? `–${fmtTime(now.stop)}` : ''} · {now.title}</span>
                </div>
                {progress != null && (
                  <div className="relative h-1 overflow-hidden rounded-full bg-white/15">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-[#7C5CFC]" style={{ width: `${progress}%` }} />
                  </div>
                )}
                {heroEpg?.next && <div className="truncate font-mono text-[11px] text-ink-3">À {fmtTime(heroEpg.next.start)} · {heroEpg.next.title}</div>}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2.5 sm:gap-3">
              <button
                onClick={() => (hero ? (hero.locked ? setPricing(true) : onPlay(hero)) : setFilters({}))}
                className="flex h-12 items-center gap-2.5 rounded-[11px] bg-accent px-4 text-[13px] font-extrabold text-[#06151a] shadow-[0_12px_30px_-10px_rgba(34,211,238,.55)] hover:brightness-110 sm:px-6 sm:text-[15px]"
              >
                {hero?.locked ? <Lock size={18} /> : <Play size={18} fill="currentColor" />}
                {hero?.locked ? t('common.premium') : t('home.watch')}
              </button>
              {hero && (
                <>
                  <button
                    onClick={() => toggleFavorite(hero)}
                    className="flex h-12 items-center gap-2 rounded-[11px] border border-white/[0.08] bg-white/[0.06] px-4 text-[13px] font-bold text-ink hover:bg-white/[0.12] sm:px-5 sm:text-[14px]"
                  >
                    <Plus size={17} /> {isFavorite(hero.url) ? t('home.inMyList') : t('home.myList')}
                  </button>
                  <button
                    onClick={() => navigate(`/chaine/${hero.id}`)}
                    aria-label={t('detail.info')}
                    title={t('detail.info')}
                    className="grid h-12 w-12 place-items-center rounded-[11px] border border-white/[0.08] bg-white/[0.06] text-ink hover:bg-white/[0.12]"
                  >
                    <Info size={18} />
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ============ CATEGORY TILES ============ */}
      <div className="pt-[clamp(22px,3.5vh,34px)]">
        <h2 className="mb-3.5 px-[clamp(16px,2.6vw,40px)] text-[19px] font-bold tracking-[-0.01em] text-ink">{t('home.browseCategories')}</h2>
        <div className="nw-scroll flex gap-3.5 overflow-x-auto px-[clamp(16px,2.6vw,40px)] pb-1.5">
          {TILES.map((tile) => {
            const count = catCount(tile.cat);
            return (
              <button
                key={tile.label}
                onClick={() => setFilters(tile.apply)}
                className="lift group relative h-[108px] w-[190px] shrink-0 overflow-hidden rounded-[14px] border border-white/[0.08] text-left"
              >
                <img src={`/tiles/${tile.art}.webp`} alt="" loading="lazy" decoding="async" width={190} height={108} className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-110" />
                <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,11,17,.85)_4%,rgba(8,11,17,0)_55%)]" />
                <div className="absolute bottom-2.5 left-3 right-3 flex items-end gap-2">
                  <span className="text-[23px] leading-none drop-shadow">{tile.icon}</span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[15px] font-bold text-white drop-shadow">{tile.label}</span>
                    {count != null && <span className="font-mono text-[10px] tracking-wide text-white/60">{count.toLocaleString('fr')} {t('home.channelsCount')}</span>}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ============ EN DIRECT MAINTENANT (cross-category featured) ============ */}
      {feat.length > 0 && (
        <Rail title={t('home.liveNow')} icon="🔴" channels={feat as Channel[]} onPlay={onPlay} wide epg={featEpg} />
      )}

      {/* ============ CLIENT RAILS ============ */}
      {favorites.length > 0 && (
        <Rail title={t('home.favorites')} icon="❤️" channels={favorites.slice(0, 30)} onPlay={onPlay} onSeeAll={() => { setFilters({ favoritesOnly: true }); useCatalog.getState().loadChannels(); }} />
      )}
      {recents.length > 0 && <Rail title={t('home.resume')} icon="↩️" channels={recents.slice(0, 30)} onPlay={onPlay} variant="resume" wide />}

      {/* ============ SERVER RAILS ============ */}
      {!data ? (
        <div className="mt-[30px] space-y-7">
          {[0, 1, 2].map((r) => (
            <div key={r}>
              <div className="mb-3 px-[clamp(16px,2.6vw,40px)]"><div className="h-4 w-44 rounded bg-white/[0.06]" /></div>
              <div className="flex gap-4 px-[clamp(16px,2.6vw,40px)]">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="w-[208px] shrink-0"><CardSkeleton /></div>)}</div>
            </div>
          ))}
        </div>
      ) : (
        data.rails.map((rail, i) => (
          <div key={rail.key}>
            <Rail
              title={rail.title}
              icon={rail.icon}
              channels={rail.channels}
              filter={rail.filter}
              total={rail.total}
              onPlay={onPlay}
              wide={i === 0}
              variant={rail.key === 'movies' || rail.key === 'series' ? 'poster' : 'card'}
              seeAllLabel={`${t('home.seeAll')} (${rail.total.toLocaleString('fr')})`}
              onSeeAll={() => setFilters(rail.filter)}
            />
            {/* Free-tier upsell, slotted after the first rail */}
            {i === 0 && !isPremium && (
              <div className="relative mx-[clamp(16px,2.6vw,40px)] mt-[30px] flex items-center gap-4 overflow-hidden rounded-[14px] border border-gold/30 bg-[linear-gradient(100deg,rgba(245,196,81,.1),rgba(245,196,81,.03))] px-5 py-4">
                <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] bg-gold/[0.16] text-gold"><Crown size={20} fill="currentColor" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-bold text-ink">{t('home.freeBannerTitle')}</div>
                  <div className="text-[12.5px] text-ink-2">{t('home.freeBannerSub')}</div>
                </div>
                <button onClick={() => setPricing(true)} className="flex h-[42px] shrink-0 items-center gap-2 rounded-[11px] bg-gold px-5 font-extrabold text-[13px] text-[#1a1407] hover:brightness-105">{t('home.goPremium')}</button>
                <span className="absolute right-3 top-2 font-mono text-[8px] tracking-[0.14em] text-ink-3">{t('home.adLabel')}</span>
              </div>
            )}
          </div>
        ))
      )}

      {data && !data.rails.length && (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-ink-3">
          <Sparkles size={32} /> <span className="text-sm">{t('home.loading')}</span>
        </div>
      )}

      {/* ============ FOOTER ============ */}
      <footer className="mt-12 border-t border-white/[0.08] bg-black/40 px-[clamp(16px,2.6vw,40px)] pb-12 pt-10">
        <div className="flex flex-wrap gap-x-16 gap-y-10">
          <div className="max-w-[280px]">
            <div className="mb-3 flex items-center gap-2.5">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-live shadow-live shadow-[0_0_10px_rgba(255,59,71,0.9)]" />
              <span className="text-[16px] font-extrabold tracking-[0.16em] text-ink">NEO<span className="text-accent">WATCH</span></span>
            </div>
            <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">{t('footer.tagline')}</p>
          </div>
          <FooterCol title={t('footer.explore')} links={[
            { label: t('footer.liveNow'), onClick: () => { navigate('/'); setFilters({ onlineOnly: true, favoritesOnly: false, category: null, country: null, language: null, q: '', foot: false }); } },
            { label: t('footer.programmeTv'), onClick: () => navigate('/programme-tv') },
            { label: t('top.multi'), onClick: openMulti },
            { label: t('footer.favorites'), onClick: () => { navigate('/'); setFilters({ favoritesOnly: true }); } },
          ]} />
          <FooterCol title={t('footer.account')} links={[
            { label: t('footer.favorites'), onClick: () => { navigate('/'); setFilters({ favoritesOnly: true }); } },
            { label: t('top.premium'), onClick: () => setPricing(true) },
            { label: t('footer.importPlaylist'), onClick: () => setPricing(true) },
            { label: t('footer.installApp'), onClick: () => setInstall(true) },
          ]} />
          <FooterCol title={t('footer.legal')} links={[
            { label: t('footer.terms'), onClick: () => navigate('/legal#cgu') },
            { label: t('footer.privacy'), onClick: () => navigate('/legal#confidentialite') },
            { label: t('footer.source'), href: 'https://iptv-org.github.io' },
          ]} />
        </div>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-5 font-mono text-[11px] tracking-wide text-ink-3">
          <span>© {new Date().getFullYear()} NEOWATCH · Flux librement accessibles via iptv-org</span>
          {meta && <span>{meta.countries.length} pays · {meta.total.toLocaleString('fr')} chaînes</span>}
        </div>
      </footer>
    </div>
  );
}

type FooterLink = { label: string; onClick?: () => void; href?: string };
function FooterCol({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div className="flex flex-col items-start gap-2.5">
      <div className="mb-0.5 font-mono text-[10px] font-bold tracking-[0.18em] text-ink-3">{title}</div>
      {links.map((l) =>
        l.href ? (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="text-left text-[12.5px] text-ink-2 transition-colors hover:text-accent">{l.label}</a>
        ) : (
          <button key={l.label} onClick={l.onClick} className="text-left text-[12.5px] text-ink-2 transition-colors hover:text-accent focus-visible:text-accent focus-visible:outline-none">{l.label}</button>
        )
      )}
    </div>
  );
}
