import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Radio, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { categoryLabel } from '@/lib/format';
import type { Channel } from '@/types';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer, guideStub } from '@/store/playerStore';
import { useUI } from '@/store/uiStore';
import { useT, fmtTime } from '@/lib/i18n';
import { EmptyState, LogoImg, Spinner, btnClass } from './ui';
import { countryLabel } from './ChannelCard';

interface GP { start: number; stop: number | null; title: string }
interface GC { id: string; name: string; logo: string | null; flag: string | null; channelId: string; locked: boolean; programmes: GP[] }

const PX_PER_MIN = 5;   // 1h = 300px
const LABEL_W = 180;
const LABEL_W_PHONE = 120; // a phone keeps more of the time axis in view
const ROW_H = 60;
const HOURS = 14;       // visible window length (scrollable)
const MIN_W = 24;       // narrower blocks are not drawn (no readable text fits)

interface Block { p: GP; left: number; width: number; end: number }

// Lay one channel's programmes on the time axis. Feeds overlap (two sources, a late
// stop): sort by start and clamp each block so it starts where the previous ends.
function layout(programmes: GP[], xOf: (ms: number) => number, gridW: number): Block[] {
  const out: Block[] = [];
  let edge = 0;
  for (const p of [...programmes].sort((a, b) => a.start - b.start)) {
    const end = p.stop && p.stop > p.start ? p.stop : p.start + 3600000;
    const left = Math.max(0, xOf(p.start), edge);
    const right = Math.min(gridW, xOf(end));
    const width = right - left - 2;
    // At the row start a block abuts the channel label: its DRAWN width must reach
    // the 24 px target itself (WCAG 2.5.8); mid-row the 2 px gaps give the spacing.
    if (right - left < MIN_W || (left === 0 && width < MIN_W)) continue;
    out.push({ p, left, width, end });
    edge = right;
  }
  return out;
}

// 24h guide grid: channels (rows) x time (columns) with a "now" line. OK on the
// programme that is on now plays the channel; any other block opens its page.
export function ProgrammeTv() {
  const navigate = useNavigate();
  const t = useT();
  const meta = useCatalog((s) => s.meta);
  const addRecent = useCatalog((s) => s.addRecent);
  const play = usePlayer((s) => s.play);
  const setPricing = useUI((s) => s.setPricing);
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? 'FR';
  const category = params.get('category') ?? '';
  const [channels, setChannels] = useState<GC[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [labelW, setLabelW] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? LABEL_W_PHONE : LABEL_W));
  useEffect(() => {
    const onResize = () => setLabelW(window.innerWidth < 640 ? LABEL_W_PHONE : LABEL_W);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  const setFilter = (key: string, val: string) => {
    const next = new URLSearchParams(params);
    // "All countries" is an explicit choice (empty value), not the FR default.
    if (key === 'country') next.set(key, val);
    else if (val) next.set(key, val);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    let alive = true;
    setState('loading');
    const qs = new URLSearchParams();
    if (country) qs.set('country', country);
    if (category) qs.set('category', category);
    api.get<{ channels: GC[]; enabled?: boolean }>(`/epg/grid?${qs.toString()}`)
      .then((r) => { if (alive) { setChannels(r.channels || []); setEnabled(r.enabled !== false); setState('ready'); } })
      .catch(() => { if (alive) { setChannels([]); setState('error'); } });
    return () => { alive = false; };
  }, [country, category, reload]);

  const now = Date.now();
  const windowStart = useMemo(() => { const d = new Date(); d.setMinutes(0, 0, 0); return d.getTime() - 3600000; }, []);
  const gridW = HOURS * 60 * PX_PER_MIN;
  const xOf = (ms: number) => ((ms - windowStart) / 60000) * PX_PER_MIN;
  const hourMarks = Array.from({ length: HOURS }, (_, i) => windowStart + i * 3600000);
  const nowX = xOf(now);

  // The window starts an hour back: open on now (the now line near the left
  // edge, the programme on air in view), not on the past hour (QA-13).
  useEffect(() => {
    if (state !== 'ready' || !channels.length) return;
    const sc = scrollerRef.current;
    if (sc) sc.scrollLeft = Math.max(0, xOf(Date.now()) - 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, channels]);

  // The grid carries a short projection: fetch the playable channel, then play it.
  const playChannel = async (g: GC) => {
    if (g.locked) return setPricing(true);
    if (busy) return;
    setBusy(g.id);
    try {
      const c = await api.get<Channel>(`/catalog/channel/${encodeURIComponent(g.id)}?channelId=${encodeURIComponent(g.channelId)}`);
      if (c.locked) setPricing(true);
      else {
        addRecent(c);
        // Zapping follows the guide's rows (resolved as it reaches them, WEB-17).
        const queue = channels.filter((r) => !r.locked).map((r) => (r.id === g.id ? c : guideStub(r)));
        play(c, { queue });
      }
    } catch {
      navigate(`/chaine/${g.id}`);
    } finally {
      setBusy(null);
    }
  };

  const countries = meta?.countries || [];
  const categories = meta?.categories.filter((c) => c.id !== 'undefined') || [];

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px] px-[var(--gouttiere)] pb-12 pt-4">
        <button type="button" onClick={back} className={btnClass('quiet', { className: 'mb-3 px-3' })} aria-label={t('detail.back')}>
          <ArrowLeft size={16} aria-hidden="true" /> {t('detail.back')}
        </button>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 flex items-center gap-2.5 text-titre font-semibold text-ink">
              <CalendarClock className="text-ink-2" size={26} aria-hidden="true" /> {t('programme.title')}
            </h1>
            <p className="mb-0 mt-1 text-sous text-ink-2">{t('pages.guide.subtitle')}</p>
          </div>
          {enabled && <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <label className="sr-only" htmlFor="guide-country">{t('pages.guide.country')}</label>
            <select id="guide-country" value={country} onChange={(e) => setFilter('country', e.target.value)} className="input w-full sm:w-56">
              <option value="">{t('programme.allCountries')}</option>
              {countries.map((c) => <option key={c.code} value={c.code} translate="no">{c.flag} {countryLabel({ country: c.code, countryName: c.name }, t.lang)}</option>)}
            </select>
            <label className="sr-only" htmlFor="guide-category">{t('pages.guide.category')}</label>
            <select id="guide-category" value={category} onChange={(e) => setFilter('category', e.target.value)} className="input w-full sm:w-52">
              <option value="">{t('programme.allCategories')}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{categoryLabel(c.id)}</option>)}
            </select>
          </div>}
        </div>

        {state === 'loading' ? (
          <div className="flex items-center justify-center py-20"><Spinner /></div>
        ) : state === 'error' ? (
          <EmptyState icon={<CalendarClock size={32} />} title={t('pages.guide.errorTitle')} body={t('pages.guide.errorBody')} action={{ label: t('empty.tryAgain'), onClick: () => setReload((n) => n + 1), variant: 'primary' }} />
        ) : !channels.length ? (
          !enabled ? (
            <EmptyState icon={<CalendarClock size={32} />} title={t('pages.guide.offTitle')} body={t('pages.guide.offBody')} action={{ label: t('empty.browseChannels'), onClick: () => navigate('/'), variant: 'primary' }} />
          ) : country ? (
            <EmptyState icon={<CalendarClock size={32} />} title={t('programme.empty')} body={t('pages.guide.emptyBody')} action={{ label: t('empty.allCountries'), onClick: () => setFilter('country', ''), variant: 'primary' }} />
          ) : (
            <EmptyState icon={<CalendarClock size={32} />} title={t('pages.guide.emptyAllTitle')} body={t('pages.guide.emptyBody')} action={{ label: t('empty.browseChannels'), onClick: () => navigate('/'), variant: 'primary' }} />
          )
        ) : (
          <div ref={scrollerRef} className="nw-thin overflow-x-auto rounded-card border border-line bg-card">
            <div className="relative" style={{ width: labelW + gridW }}>
              {/* Time header */}
              <div className="sticky top-0 z-20 flex h-9 border-b border-line bg-[var(--bg-1)]">
                <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-[var(--bg-1)]" style={{ width: labelW }} />
                <div className="relative" style={{ width: gridW }}>
                  {hourMarks.map((h) => (
                    <span key={h} className="meta absolute top-2" style={{ left: xOf(h) + 6 }}>{fmtTime(h)}</span>
                  ))}
                </div>
              </div>

              {/* Channel rows */}
              {channels.map((ch) => (
                <div key={ch.id} data-prog-row="" className="flex border-b border-[var(--line-soft)]" style={{ height: ROW_H }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/chaine/${ch.id}`)}
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-2.5 border-r border-line bg-[var(--bg-1)] px-3 text-left"
                    style={{ width: labelW }}
                    aria-label={ch.name}
                  >
                    <span className="grid h-8 w-10 shrink-0 place-items-center overflow-hidden rounded-field bg-[var(--plaque-mini)]" aria-hidden="true">
                      <LogoImg src={ch.logo} w={96} width={40} height={32} loading="lazy" fallback={<Radio size={14} className="text-[color:var(--plaque-encre-3)]" />} className="max-h-[80%] max-w-[85%] object-contain" />
                    </span>
                    <span className="truncate text-sous font-semibold text-ink" translate="no">{ch.name}</span>
                  </button>
                  <div className="relative" style={{ width: gridW }}>
                    {layout(ch.programmes, xOf, gridW).map(({ p, left, width, end }) => {
                      const isNow = p.start <= now && now < end;
                      return (
                        <button
                          key={`${p.start}-${p.title}`}
                          type="button"
                          data-prog=""
                          onClick={() => (isNow ? playChannel(ch) : navigate(`/chaine/${ch.id}`))}
                          title={`${fmtTime(p.start)} ${p.title}`}
                          aria-label={`${fmtTime(p.start)} ${p.title}`}
                          aria-busy={busy === ch.id || undefined}
                          className={clsx(
                            'absolute bottom-1.5 top-1.5 overflow-hidden rounded-field border px-2 text-left leading-tight',
                            isNow ? 'border-line-strong bg-[var(--bg-4)] text-ink' : 'border-line bg-[var(--bg-2)] text-ink-2'
                          )}
                          style={{ left, width }}
                        >
                          <span className="meta block">{fmtTime(p.start)}</span>
                          <span className="block truncate text-libelle font-medium" translate="no">{p.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Now line */}
              {nowX >= 0 && nowX <= gridW && (
                <div className="pointer-events-none absolute bottom-0 top-0 z-[15] w-[2px] bg-red" style={{ left: labelW + nowX }} aria-hidden="true" />
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
