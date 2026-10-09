import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Play, Lock, Plus, Check, Grip, Share2, Flag, Radio } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fetchNowNext, type NowNext } from '@/lib/epg';
import { categoryLabel } from '@/lib/format';
import type { Channel } from '@/types';
import { usePlayer } from '@/store/playerStore';
import { useCatalog } from '@/store/catalogStore';
import { useUI, toast } from '@/store/uiStore';
import { useT, fmtTime, fmtAge } from '@/lib/i18n';
import { AmbianceImg, Button, Data, EmptyState, HealthPill, LogoImg, Meta, Overline, Pill, Spinner, btnClass } from './ui';
import { LEGAL_CONTACT } from './Legal';
import { countryLabel, languageLabel } from './ChannelCard';
import { isTV } from '@/lib/device';

interface Programme { start: number; stop: number | null; title: string; desc?: string | null }

const MULTI_MAX = 9;

// Ambiance art per category, the same map as the home hero (spec 2.2). Any other
// category: no picture (the logo frame carries the page), never the stadium.
const AMBIANCE: Record<string, string> = {
  sports: 'sport', foot: 'sport',
  movies: 'cinema', series: 'cinema', animation: 'cinema', classic: 'cinema',
  music: 'music',
  news: 'news', business: 'news', weather: 'news', legislative: 'news', documentary: 'news',
};

/** Back that never leaves the app: history inside NEOWATCH, else the home. */
export function useSmartBack() {
  const navigate = useNavigate();
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };
}

/** Rewrite the address bar without a navigation (react-router keeps its own state). */
function replaceUrl(path: string) {
  try {
    window.history.replaceState(window.history.state, '', path);
  } catch {
    /* sandboxed */
  }
}

export function ChannelDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const back = useSmartBack();
  const tv = isTV();
  const t = useT();
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const addToMulti = usePlayer((s) => s.addToMulti);
  const multiCount = usePlayer((s) => s.multi.length);
  const isInMulti = usePlayer((s) => s.isInMulti);
  const toggleFavorite = useCatalog((s) => s.toggleFavorite);
  const favorite = useCatalog((s) => s.favorites);
  const setPricing = useUI((s) => s.setPricing);

  const [ch, setCh] = useState<Channel | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'gone' | 'error'>('loading');
  const [epg, setEpg] = useState<NowNext | null>(null);
  const [day, setDay] = useState<Programme[]>([]);
  const [similar, setSimilar] = useState<Channel[]>([]);
  const [reload, setReload] = useState(0);
  const watchRef = useRef<HTMLButtonElement>(null);
  const autoplayed = useRef(false);

  useEffect(() => {
    let alive = true;
    const prevTitle = document.title;
    setState('loading'); setCh(null); setEpg(null); setDay([]); setSimilar([]);
    document.querySelector('main')?.scrollTo({ top: 0 });
    api.get<Channel>(`/catalog/channel/${encodeURIComponent(id || '')}`).then((c) => {
      if (!alive) return;
      setCh(c);
      setState('ready');
      document.title = t('detail.docTitle', { name: c.name });
      // An old id resolved through an alias: show the current address (no reload).
      const params = new URLSearchParams(window.location.search);
      const wantsPlay = params.get('play') === '1';
      params.delete('play');
      const qs = params.toString();
      const canonical = c.canonicalId && c.canonicalId !== id ? c.canonicalId : id;
      if (canonical !== id || wantsPlay) replaceUrl(`/chaine/${canonical}${qs ? `?${qs}` : ''}`);
      // ?play=1 (Sentinel, shared links): start once, always muted (a page that
      // starts with sound is refused by the browser anyway).
      if (wantsPlay && !c.locked && !autoplayed.current) {
        autoplayed.current = true;
        addRecent(c);
        play(c, { muted: true });
      }
      if (c.channelId) {
        fetchNowNext([c.channelId]).then((m) => alive && setEpg(m[c.channelId!] || null));
        api.get<{ programmes: Programme[] }>(`/epg/day?id=${encodeURIComponent(c.channelId)}`).then((r) => alive && setDay(r.programmes || [])).catch(() => {});
      }
      // Similar: same category (fallback country), excluding self.
      const cat = c.categories?.[0];
      const q = cat && cat !== 'undefined' ? `category=${encodeURIComponent(cat)}` : c.country ? `country=${encodeURIComponent(c.country)}` : '';
      if (q) api.get<{ items: Channel[] }>(`/catalog/channels?${q}&limit=18`).then((r) => alive && setSimilar((r.items || []).filter((x) => x.url !== c.url).slice(0, 14))).catch(() => {});
    }).catch((e) => {
      if (alive) setState(e instanceof ApiError && e.status === 404 ? 'gone' : 'error');
    });
    return () => { alive = false; document.title = prevTitle; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reload]);

  // The remote lands on "Watch now" (spec: one primary, focused on arrival).
  useEffect(() => {
    if (state === 'ready') watchRef.current?.focus({ preventScroll: true });
  }, [state]);

  if (state === 'loading') {
    return <main className="flex flex-1 items-center justify-center"><Spinner /></main>;
  }
  if (!ch) {
    return (
      <main className="flex flex-1 items-center justify-center px-4">
        {state === 'gone' ? (
          <EmptyState icon={<Radio size={32} />} title={t('detail.notFound')} body={t('pages.detail.goneBody')} action={{ label: t('empty.backToChannels'), onClick: () => navigate('/'), variant: 'primary' }} />
        ) : (
          <EmptyState icon={<Radio size={32} />} title={t('pages.detail.errorTitle')} body={t('pages.detail.errorBody')} action={{ label: t('empty.tryAgain'), onClick: () => setReload((n) => n + 1), variant: 'primary' }} />
        )}
      </main>
    );
  }

  const isFav = favorite.some((f) => f.url === ch.url);
  const inMulti = isInMulti(ch.url);
  const cat = ch.categories?.find((c) => c && c !== 'undefined') || null;
  const ambCat = ch.categories?.find((c) => AMBIANCE[c]);
  const now = epg?.now;
  const next = epg?.next;
  const progress = now && now.stop ? Math.min(100, Math.max(0, ((Date.now() - now.start) / (now.stop - now.start)) * 100)) : null;
  const country = countryLabel(ch, t.lang);
  const language = languageLabel(ch, t.lang);
  const checked = ch.checkedAt ? t('meta.checked', { age: fmtAge(ch.checkedAt) }) : t('meta.notChecked');
  const pageUrl = `${location.origin}/chaine/${ch.canonicalId || ch.id}`;

  const start = () => {
    if (ch.locked) return setPricing(true);
    addRecent(ch);
    play(ch, { queue: [ch, ...similar], originKey: ch.url });
  };
  const toggleList = () => {
    toggleFavorite(ch);
    toast(t(isFav ? 'toast.removedList' : 'toast.addedList'), { undo: () => toggleFavorite(ch) });
  };
  const multi = () => {
    if (!inMulti && multiCount < MULTI_MAX) toast(t('toast.addedMulti', { n: multiCount + 1, max: MULTI_MAX }), { ok: true });
    addToMulti(ch);
  };
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: ch.name, url: pageUrl });
        return;
      }
      await navigator.clipboard?.writeText(pageUrl);
      toast(t('toast.copied'), { ok: true });
    } catch {
      /* cancelled */
    }
  };
  const reportHref = `mailto:${LEGAL_CONTACT}?subject=${encodeURIComponent(t('pages.detail.reportSubject', { name: ch.name }))}&body=${encodeURIComponent(t('pages.detail.reportBody', { name: ch.name, url: ch.url, page: pageUrl }))}`;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px] pb-12">
        {/* Hero (spec 2.2): picture, scrim, one primary */}
        {/* The picture and its scrim stay dark in both styles (spec): the primary
            keeps a light fill here so it reads on the image in Doux too. */}
        <section
          data-hero=""
          className="relative overflow-hidden bg-[var(--fond-image)]"
          style={{
            ['--primaire-fond' as string]: 'var(--encre-image)',
            ['--primaire-encre' as string]: '#0a0d10',
          }}
        >
          {/* The category artwork (an <img>: the page's largest paint, PERF-4), under its scrim. */}
          {ambCat && <AmbianceImg name={AMBIANCE[ambCat]} sizes="(min-width: 1760px) 1760px, 100vw" className="absolute inset-0" />}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'var(--voile-hero)' }} />
          <div className="relative flex flex-col gap-6 px-[var(--gouttiere)] pb-8 pt-5">
            <button type="button" onClick={back} className={btnClass('quiet', { className: 'w-fit px-3 text-on-image' })} aria-label={t('detail.back')}>
              <ArrowLeft size={16} aria-hidden="true" /> {t('detail.back')}
            </button>
            <div className="flex flex-wrap items-end gap-6">
              <div className="grid h-20 w-32 shrink-0 sm:h-28 sm:w-44 place-items-center overflow-hidden rounded-card border border-line bg-[var(--plaque)]" aria-hidden="true">
                <LogoImg key={ch.logo || ''} src={ch.logo} w={640} width={176} height={112} fallback={<Radio className="text-[color:var(--plaque-encre-3)]" size={40} />} className="max-h-[70%] max-w-[80%] object-contain" />
              </div>
              <div className="flex min-w-0 flex-1 basis-[320px] flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  {ch.locked ? (
                    <Pill><Lock size={12} aria-hidden="true" /> {t('pill.premium')}</Pill>
                  ) : ch.online === true ? (
                    <HealthPill status="online" />
                  ) : ch.online === false ? (
                    <HealthPill status="offline" />
                  ) : null}
                  {cat && <Overline className="text-on-image">{categoryLabel(cat)}</Overline>}
                </div>
                <h1 className="m-0 text-titre font-semibold text-on-image" translate="no">{ch.name}</h1>
                <Meta
                  className="text-on-image"
                  parts={[
                    country ? <Data>{`${ch.flag ? `${ch.flag} ` : ''}${country}`}</Data> : null,
                    language ? <Data>{language}</Data> : null,
                    ch.quality ? <Data>{ch.quality}</Data> : null,
                    checked,
                  ]}
                />
                {now && (
                  <p className="m-0 max-w-[620px] text-corps text-on-image">
                    {now.stop ? t('hero.until', { title: now.title, time: fmtTime(now.stop) }) : <Data>{now.title}</Data>}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2.5">
                  <button
                    ref={watchRef}
                    type="button"
                    data-autofocus=""
                    data-key={ch.url}
                    onClick={start}
                    className={btnClass('primary', { className: 'px-6' })}
                    aria-label={ch.locked ? t('promo.discover') : t('home.watch')}
                  >
                    {ch.locked ? <Lock size={18} aria-hidden="true" /> : <Play size={18} fill="currentColor" aria-hidden="true" />}
                    {ch.locked ? t('promo.discover') : t('home.watch')}
                  </button>
                  <Button
                    onClick={toggleList}
                    aria-pressed={isFav}
                    icon={isFav ? <Check size={17} aria-hidden="true" /> : <Plus size={17} aria-hidden="true" />}
                    aria-label={isFav ? t('home.inMyList') : t('home.myList')}
                  >
                    {isFav ? t('home.inMyList') : t('home.myList')}
                  </Button>
                  {!ch.locked && (
                    <Button variant="quiet" onClick={multi} aria-pressed={inMulti} icon={<Grip size={16} aria-hidden="true" />} aria-label={t('nav.multi')} className="text-on-image">
                      {t('nav.multi')}
                    </Button>
                  )}
                  <Button variant="quiet" onClick={share} icon={<Share2 size={16} aria-hidden="true" />} aria-label={t('detail.share')} className="text-on-image">
                    {t('detail.share')}
                  </Button>
                  {!tv && <a href={reportHref} className={btnClass('quiet', { className: 'text-on-image' })} aria-label={t('pages.detail.report')} title={t('pages.detail.report')}>
                    <Flag size={16} aria-hidden="true" /> {t('pages.detail.report')}
                  </a>}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Today's guide */}
        <section className="px-[var(--gouttiere)]">
          <h2 className="row-title mb-3 mt-6">{t('detail.programme')}</h2>
          {now && (
            <div className="mb-4 rounded-card border border-line bg-card p-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <Pill tone="live">{t('pill.onNow')}</Pill>
                <span className="meta">{fmtTime(now.start)}{now.stop ? ` · ${fmtTime(now.stop)}` : ''}</span>
              </div>
              <p className="mb-0 mt-2 text-carte font-semibold text-ink" translate="no">{now.title}</p>
              {now.desc && <p className="mb-0 mt-1 max-w-[760px] text-sous text-ink-2" translate="no">{now.desc}</p>}
              {progress != null && (
                <div className="mt-3 h-1 overflow-hidden rounded-pill bg-[var(--bg-3)]" aria-hidden="true">
                  <div className="h-full rounded-pill bg-ink-2" style={{ width: `${progress}%` }} />
                </div>
              )}
              {next && <p className="meta mb-0 mt-2">{t('card.nextAt', { time: fmtTime(next.start), title: next.title })}</p>}
            </div>
          )}
          {day.length > 0 ? (
            <ol className="m-0 list-none divide-y divide-[var(--line-soft)] overflow-hidden rounded-card border border-line bg-card p-0">
              {day.map((p, i) => {
                const isNow = !!now && p.start === now.start;
                return (
                  <li key={i} className={clsx('flex items-start gap-4 px-4 py-2.5', isNow && 'bg-[var(--bg-3)]')}>
                    <span className="meta w-14 shrink-0">{fmtTime(p.start)}</span>
                    <span className={clsx('text-sous', isNow ? 'font-semibold text-ink' : 'text-ink-2')} translate="no">{p.title}</span>
                  </li>
                );
              })}
            </ol>
          ) : !now ? (
            <p className="m-0 rounded-card border border-line bg-card px-4 py-5 text-sous text-ink-2">{t('detail.noProgramme')}</p>
          ) : null}
        </section>

        {/* Similar channels: one card, one action */}
        {similar.length > 0 && (
          <section className="row mt-8">
            <h2 className="row-title mb-0 px-[var(--gouttiere)]">{t('detail.similar')}</h2>
            <div className="row-track">
              {similar.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  data-card=""
                  data-key={s.url}
                  onClick={() => navigate(`/chaine/${s.id}`)}
                  className="lift w-[200px] shrink-0 overflow-hidden rounded-card border border-line bg-card text-left"
                  aria-label={s.name}
                >
                  {/* Positioned plate: the logo's % caps resolve against the 16:9 box, so a
                      tall logo can never stretch one card above its row. */}
                  <span className="relative block aspect-video bg-[var(--plaque-mini)]" aria-hidden="true">
                    <LogoImg src={s.logo} w={320} width={144} height={81} loading="lazy" fallback={<Radio className="absolute inset-0 m-auto text-[color:var(--plaque-encre-3)]" />} className="absolute inset-0 m-auto max-h-[60%] max-w-[72%] object-contain" />
                  </span>
                  <span className="block truncate px-3 py-2 text-sous font-semibold text-ink" translate="no">{s.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
