import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Crown, Play, Loader2, Info } from 'lucide-react';
import type { Channel, Filters } from '@/types';
import { fmtTime, type NowNext, type Programme } from '@/lib/epg';
import { api } from '@/lib/api';
import { useUI } from '@/store/uiStore';
import { useI18n, useT } from '@/lib/i18n';

interface Props {
  title: string;
  icon?: string;
  channels: Channel[];
  onPlay: (ch: Channel) => void;
  onSeeAll?: () => void;
  seeAllLabel?: string;
  wide?: boolean;
  variant?: 'card' | 'poster' | 'resume';
  epg?: Record<string, NowNext>;
  // When provided, the rail lazily loads more channels (Netflix-style) as you
  // scroll toward its end -- small initial payload, unlimited browsing.
  filter?: Partial<Filters>;
  total?: number;
}

const PAGE = 30;        // matches the home endpoint's per-rail page size
const MAX_LOADED = 90;  // bound DOM/memory per rail (3 pages) -- "See all" opens the full grid

function railQuery(f: Partial<Filters>, page: number, lang: string): string {
  const p = new URLSearchParams();
  if (f.category) p.set('category', f.category);
  if (f.country) p.set('country', f.country);
  if (f.language) p.set('language', f.language);
  if (f.q) p.set('q', f.q);
  if (f.foot) p.set('foot', '1');
  if (f.onlineOnly) p.set('hideOffline', '1');
  if (lang) p.set('lang', lang); // keep the same language ordering as the home
  p.set('page', String(page));
  p.set('limit', String(PAGE));
  return p.toString();
}

const MONO_COLORS = ['#22D3EE', '#FF5C8A', '#7C5CFC', '#34D399', '#F5A623', '#38BDF8', '#2DD4BF', '#FB7185'];
function qualityLabel(q: string | null | undefined): string | null {
  if (!q) return null;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 'UHD';
  if (s.includes('1080')) return 'FHD';
  if (s.includes('720')) return 'HD';
  if (s.includes('480') || s.includes('576') || s.includes('360')) return 'SD';
  return q.toUpperCase().slice(0, 4);
}
function monogram(name: string) {
  const letters = (name || '?').replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/);
  const mono = (letters[0]?.[0] || name[0] || '?') + (letters[1]?.[0] || letters[0]?.[1] || '');
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return { mono: mono.toUpperCase(), color: MONO_COLORS[h % MONO_COLORS.length] };
}

// Horizontal, scrollable rail of channels in the NeoWatch card style.
export function Rail({ title, icon, channels, onPlay, onSeeAll, seeAllLabel, wide, variant = 'card', epg, filter, total }: Props) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const setPricing = useUI((s) => s.setPricing);
  const lang = useI18n((s) => s.lang);
  const [extra, setExtra] = useState<Channel[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingRef = useRef(false);
  const pageRef = useRef(1);
  const doneRef = useRef(false);

  // De-duplicated initial channels + lazily-loaded pages.
  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: Channel[] = [];
    for (const c of [...channels, ...extra]) if (c && !seen.has(c.url)) { seen.add(c.url); out.push(c); }
    return out;
  }, [channels, extra]);

  // Reset pagination when the rail's base list changes (home refetch).
  useEffect(() => { setExtra([]); pageRef.current = 1; doneRef.current = false; loadingRef.current = false; }, [channels]);

  const canPaginate = !!filter && typeof total === 'number';
  const loadMore = useCallback(async () => {
    if (!canPaginate || loadingRef.current || doneRef.current) return;
    if (all.length >= Math.min(total as number, MAX_LOADED)) { doneRef.current = true; return; }
    loadingRef.current = true;
    setLoadingMore(true);
    try {
      const next = pageRef.current + 1;
      const r = await api.get<{ items: Channel[] }>(`/catalog/channels?${railQuery(filter as Partial<Filters>, next, lang)}`);
      pageRef.current = next;
      const items = r.items || [];
      if (items.length < PAGE) doneRef.current = true;
      if (items.length) setExtra((p) => [...p, ...items]);
    } catch {
      /* transient -- will retry on next scroll */
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [canPaginate, all.length, total, filter, lang]);

  const onScroll = () => {
    const sc = scroller.current;
    if (sc && sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 800) loadMore();
  };

  const scrollBy = (dir: number) => {
    const sc = scroller.current;
    if (sc) sc.scrollBy({ left: dir * Math.min(720, sc.clientWidth * 0.82), behavior: 'smooth' });
    if (dir > 0) loadMore();
  };

  // D-pad / keyboard: ArrowLeft/Right move focus between cards (TV remotes).
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const cards = Array.from(scroller.current?.querySelectorAll<HTMLElement>('[role="button"]') || []);
    const idx = cards.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;
    const next = cards[idx + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
    if (e.key === 'ArrowRight' && idx >= cards.length - 4) loadMore();
  };

  if (!channels.length) return null;

  return (
    <section className="mt-[30px]">
      <div className="mb-3.5 flex items-baseline gap-3 px-[clamp(16px,2.6vw,40px)]">
        <h2 className="m-0 text-[19px] font-bold tracking-[-0.01em] text-ink">
          {icon && <span className="mr-1.5">{icon}</span>}
          {title}
        </h2>
        {onSeeAll && (
          <button onClick={onSeeAll} className="text-[12px] font-semibold text-ink-2 transition-colors hover:text-accent">
            {seeAllLabel || 'Tout voir'} ›
          </button>
        )}
        <div className="ml-auto hidden items-center gap-2 sm:flex">
          <button onClick={() => scrollBy(-1)} aria-label={t('common.prev')} className="grid h-11 w-11 place-items-center rounded-full border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent"><ChevronLeft size={17} /></button>
          <button onClick={() => scrollBy(1)} aria-label={t('common.next')} className="grid h-11 w-11 place-items-center rounded-full border border-white/[0.08] bg-white/[0.04] text-ink-2 hover:border-accent hover:text-accent"><ChevronRight size={17} /></button>
        </div>
      </div>
      <div ref={scroller} onScroll={onScroll} onKeyDown={onKey} className="nw-scroll flex gap-4 overflow-x-auto px-[clamp(16px,2.6vw,40px)] pb-2.5 pt-1">
        {all.map((ch) =>
          variant === 'poster' ? (
            <PosterCard key={ch.url} ch={ch} onPlay={onPlay} onLocked={() => setPricing(true)} />
          ) : (
            <RailCard
              key={ch.url}
              ch={ch}
              wide={wide}
              resume={variant === 'resume'}
              now={ch.channelId ? epg?.[ch.channelId]?.now ?? null : null}
              onPlay={onPlay}
              onLocked={() => setPricing(true)}
            />
          )
        )}
        {loadingMore && (
          <div className="flex w-16 shrink-0 items-center justify-center"><Loader2 className="animate-spin text-accent" size={20} /></div>
        )}
      </div>
    </section>
  );
}

function RailCard({ ch, wide, resume, now, onPlay, onLocked }: { ch: Channel; wide?: boolean; resume?: boolean; now?: Programme | null; onPlay: (c: Channel) => void; onLocked: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { mono, color } = monogram(ch.name);
  const online = ch.online === true;
  const cat = ch.categoryNames?.[0] || '';
  const q = qualityLabel(ch.quality);

  const activate = () => (ch.locked ? onLocked() : onPlay(ch));
  const openInfo = (e: React.MouseEvent) => { e.stopPropagation(); navigate(`/chaine/${ch.id}`); };
  return (
    <article
      // Pointer click = quick play; remote/keyboard OK = open the detail page (the
      // reliable TV action hub), since hover quick-actions can't be reached by D-pad.
      onClick={(e) => { if (e.detail !== 0) activate(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ch.locked ? onLocked() : navigate(`/chaine/${ch.id}`); } }}
      tabIndex={0}
      role="button"
      aria-label={ch.name}
      className={clsx(
        'lift group shrink-0 cursor-pointer overflow-hidden rounded-[14px] border border-white/[0.08] bg-panel focus:outline-none focus-visible:border-accent',
        wide ? 'w-[clamp(220px,80vw,300px)]' : 'w-[clamp(150px,44vw,208px)]'
      )}
    >
      <div className="relative grid aspect-video place-items-center overflow-hidden bg-[radial-gradient(120%_120%_at_50%_0%,rgba(255,255,255,.06),rgba(8,11,17,.4))]">
        {ch.flag && <span className="pointer-events-none absolute -bottom-4 -right-3 text-[74px] opacity-[0.06] grayscale">{ch.flag}</span>}
        {ch.logo ? (
          <img src={ch.logo} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-[64%] max-w-[72%] object-contain drop-shadow" />
        ) : (
          <span className="grid h-[54px] w-[54px] place-items-center rounded-[14px] text-[17px] font-extrabold text-[#06151a] shadow-[0_8px_22px_-8px_rgba(0,0,0,.6)]" style={{ background: color }}>{mono}</span>
        )}
        {/* badges */}
        {ch.locked ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-[5px] bg-gold/[0.16] px-1.5 py-1 font-mono text-[9px] font-bold tracking-wider text-gold">
            <Crown size={10} fill="currentColor" /> PREMIUM
          </span>
        ) : online ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-[5px] bg-live px-2 py-1 font-mono text-[9px] font-bold tracking-[0.1em] text-white">
            <span className="h-[5px] w-[5px] animate-pulse-red rounded-full bg-white" /> LIVE
          </span>
        ) : null}
        {q && <span className="absolute right-2 top-2 rounded-[5px] bg-black/55 px-1.5 py-1 font-mono text-[9px] font-bold text-accent">{q}</span>}
        {/* play overlay — always shown for resume cards, on hover otherwise */}
        <span className={clsx('absolute inset-0 grid place-items-center bg-black/30 transition-opacity', resume ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
          <span className="grid h-11 w-11 place-items-center rounded-full bg-accent/90 text-[#06151a] shadow-lg">
            {ch.locked ? <Crown size={17} /> : <Play size={17} fill="currentColor" className="ml-0.5" />}
          </span>
        </span>
        {/* Info -> channel detail page (infos + programme). Stops the card's play. */}
        <button onClick={openInfo} aria-label={t('common.info')} className="absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white/80 opacity-0 backdrop-blur transition-opacity hover:text-accent group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100">
          <Info size={15} />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 px-3 pb-3 pt-2.5">
        <div className="truncate text-[13px] font-bold text-ink">{ch.name}</div>
        {now ? (
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="shrink-0 font-mono text-[10px] text-accent">{fmtTime(now.start)}</span>
            <span className="truncate text-ink-2">{now.title}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-2">
            {ch.flag && <span>{ch.flag}</span>}
            <span className="truncate">{cat || ch.countryName || 'International'}</span>
          </div>
        )}
      </div>
    </article>
  );
}

// Portrait 2:3 poster card (design: "Films à l'affiche").
function PosterCard({ ch, onPlay, onLocked }: { ch: Channel; onPlay: (c: Channel) => void; onLocked: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { mono, color } = monogram(ch.name);
  const activate = () => (ch.locked ? onLocked() : onPlay(ch));
  const openInfo = (e: React.MouseEvent) => { e.stopPropagation(); navigate(`/chaine/${ch.id}`); };
  return (
    <article
      onClick={(e) => { if (e.detail !== 0) activate(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ch.locked ? onLocked() : navigate(`/chaine/${ch.id}`); } }}
      tabIndex={0}
      role="button"
      aria-label={ch.name}
      className="lift group w-[clamp(130px,40vw,176px)] shrink-0 cursor-pointer focus:outline-none"
    >
      <div className="relative grid aspect-[2/3] place-items-center overflow-hidden rounded-[13px] border border-white/[0.08] bg-[radial-gradient(120%_90%_at_50%_0%,rgba(124,92,252,.18),rgba(8,11,17,.5))]">
        {ch.flag && <span className="pointer-events-none absolute -bottom-5 -right-3 text-[88px] opacity-[0.06] grayscale">{ch.flag}</span>}
        {ch.logo
          ? <img src={ch.logo} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-[44%] max-w-[74%] object-contain drop-shadow" />
          : <span className="grid h-16 w-16 place-items-center rounded-2xl text-xl font-extrabold text-[#06151a]" style={{ background: color }}>{mono}</span>}
        {ch.locked && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 backdrop-blur-[1.5px]">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-gold text-[#1a1407]"><Crown size={16} fill="currentColor" /></span>
            <span className="font-mono text-[9px] font-bold tracking-[0.16em] text-gold">PREMIUM</span>
          </div>
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-accent/90 text-[#06151a]"><Play size={17} fill="currentColor" className="ml-0.5" /></span>
        </span>
        <button onClick={openInfo} aria-label={t('common.info')} className="absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white/80 opacity-0 backdrop-blur transition-opacity hover:text-accent group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100">
          <Info size={15} />
        </button>
      </div>
      <div className="px-0.5 pt-2.5">
        <div className="truncate text-[13px] font-bold text-ink">{ch.name}</div>
        <div className="truncate font-mono text-[11px] text-ink-3">{ch.categoryNames?.[0] || ch.countryName || 'International'}</div>
      </div>
    </article>
  );
}
