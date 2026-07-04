import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Play, Lock, Plus, Check, Grip, Share2, Radio, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { fetchNowNext, fmtTime, type NowNext } from '@/lib/epg';
import type { Channel } from '@/types';
import { usePlayer } from '@/store/playerStore';
import { useCatalog } from '@/store/catalogStore';
import { useUI } from '@/store/uiStore';
import { useT } from '@/lib/i18n';

interface Programme { start: number; stop: number | null; title: string; desc?: string | null }

export function ChannelDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const addToMulti = usePlayer((s) => s.addToMulti);
  const isInMulti = usePlayer((s) => s.isInMulti);
  const toggleFavorite = useCatalog((s) => s.toggleFavorite);
  const isFavorite = useCatalog((s) => s.isFavorite);
  const setPricing = useUI((s) => s.setPricing);

  const [ch, setCh] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [epg, setEpg] = useState<NowNext | null>(null);
  const [day, setDay] = useState<Programme[]>([]);
  const [similar, setSimilar] = useState<Channel[]>([]);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setCh(null); setEpg(null); setDay([]); setSimilar([]);
    window.scrollTo?.(0, 0);
    document.querySelector('main')?.scrollTo({ top: 0 });
    api.get<Channel>(`/catalog/channel/${id}`).then((c) => {
      if (!alive) return;
      setCh(c); setLoading(false);
      document.title = `${c.name} -- NEOWATCH`; // nicer tab title + share/PWA label
      if (c.channelId) {
        fetchNowNext([c.channelId]).then((m) => alive && setEpg(m[c.channelId!] || null));
        api.get<{ programmes: Programme[] }>(`/epg/day?id=${encodeURIComponent(c.channelId)}`).then((r) => alive && setDay(r.programmes || [])).catch(() => {});
      }
      // Similar: same category (fallback country), excluding self.
      const cat = c.categories?.[0];
      const qs = cat && cat !== 'undefined' ? `category=${cat}` : c.country ? `country=${c.country}` : '';
      if (qs) api.get<{ items: Channel[] }>(`/catalog/channels?${qs}&limit=18`).then((r) => alive && setSimilar((r.items || []).filter((x) => x.id !== c.id).slice(0, 14))).catch(() => {});
    }).catch(() => { if (alive) { setLoading(false); } });
    return () => { alive = false; document.title = 'NEOWATCH -- Toutes les chaînes en direct'; };
  }, [id]);

  const start = (c: Channel) => { if (c.locked) return setPricing(true); addRecent(c); play(c); };
  const share = async () => {
    const url = `${location.origin}/chaine/${ch?.id}`;
    try {
      if (navigator.share) await navigator.share({ title: ch?.name, url });
      else { await navigator.clipboard?.writeText(url); setShared(true); setTimeout(() => setShared(false), 1500); }
    } catch { /* cancelled */ }
  };

  if (loading) return <div className="flex flex-1 items-center justify-center"><Loader2 className="animate-spin text-accent" size={32} /></div>;
  if (!ch) return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink/50">
      <p>{t('detail.notFound')}</p>
      <button onClick={() => navigate('/')} className="rounded-lg border border-white/10 px-4 py-2 text-sm hover:text-accent">{t('detail.back')}</button>
    </div>
  );

  const online = ch.online === true;
  const meta = [ch.countryName, ch.languageNames?.[0], ch.categoryNames?.[0], ch.quality].filter(Boolean);
  const now = epg?.now;
  const progress = now && now.stop ? Math.min(100, Math.max(0, ((Date.now() - now.start) / (now.stop - now.start)) * 100)) : null;

  return (
    <div className="mx-auto w-full max-w-[1760px] pb-12">
      {/* Hero header */}
      <div className="relative overflow-hidden">
        <div className="animate-kenburns absolute inset-0 bg-cover bg-center opacity-40" style={{ backgroundImage: 'url(/hero.webp)' }} />
        <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/85 to-surface/40" />
        <div className="relative flex flex-col gap-5 px-[clamp(16px,2.6vw,40px)] pb-7 pt-5">
          <button onClick={() => navigate(-1)} className="flex w-fit items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent hover:text-accent">
            <ArrowLeft size={14} /> {t('detail.back')}
          </button>
          <div className="flex flex-wrap items-end gap-5">
            <div className="grid h-28 w-44 shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.06] to-black/40">
              {ch.logo ? <img src={ch.logo} alt="" referrerPolicy="no-referrer" className="max-h-[70%] max-w-[80%] object-contain" /> : <Radio className="text-ink/30" size={40} />}
            </div>
            <div className="flex flex-1 flex-col gap-2.5">
              <div className="flex items-center gap-2.5">
                {ch.locked ? (
                  <span className="inline-flex items-center gap-1 rounded-[5px] bg-gold/[0.16] px-2 py-1 font-mono text-[10px] font-bold text-gold"><Lock size={11} /> {t('common.premium')}</span>
                ) : online ? (
                  <span className="inline-flex items-center gap-1.5 rounded-[5px] bg-live px-2 py-1 font-mono text-[10px] font-bold tracking-wider text-white"><span className="h-[6px] w-[6px] animate-pulse-red rounded-full bg-white" /> LIVE</span>
                ) : null}
                <span className="text-[28px]">{ch.flag || '🌐'}</span>
              </div>
              <h1 className="m-0 text-[clamp(26px,4vw,44px)] font-extrabold leading-tight tracking-[-0.02em] text-ink">{ch.name}</h1>
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
                {meta.map((m, i) => <span key={i} className="rounded-md border border-white/[0.08] px-2 py-1">{m}</span>)}
              </div>
              {/* Actions */}
              <div className="mt-1 flex flex-wrap items-center gap-2.5">
                <button onClick={() => start(ch)} className="flex h-12 items-center gap-2.5 rounded-[11px] bg-accent px-6 text-[15px] font-extrabold text-[#06151a] shadow-[0_12px_30px_-10px_rgba(34,211,238,.55)] hover:brightness-110">
                  {ch.locked ? <Lock size={18} /> : <Play size={18} fill="currentColor" />} {ch.locked ? t('common.premium') : t('home.watch')}
                </button>
                <Action onClick={() => toggleFavorite(ch)} active={isFavorite(ch.url)} icon={isFavorite(ch.url) ? <Check size={17} /> : <Plus size={17} />} label={isFavorite(ch.url) ? t('home.inMyList') : t('home.myList')} />
                {!ch.locked && <Action onClick={() => addToMulti(ch)} active={isInMulti(ch.url)} icon={<Grip size={16} />} label={t('top.multi')} />}
                <Action onClick={share} icon={shared ? <Check size={16} className="text-emerald-400" /> : <Share2 size={16} />} label={t('detail.share')} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Programme (EPG) */}
      <div className="px-[clamp(16px,2.6vw,40px)]">
        <h2 className="mb-3 mt-4 text-[18px] font-bold text-ink">{t('detail.programme')}</h2>
        {now ? (
          <div className="mb-4 rounded-2xl border border-white/[0.08] bg-panel/50 p-4">
            <div className="flex items-center gap-2.5 font-mono text-[11px]"><span className="font-bold text-accent">{t('detail.onNow')}</span><span className="text-ink-3">{fmtTime(now.start)}{now.stop ? `–${fmtTime(now.stop)}` : ''}</span></div>
            <div className="mt-1 text-[15px] font-semibold text-ink">{now.title}</div>
            {now.desc && <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{now.desc}</p>}
            {progress != null && <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-gradient-to-r from-accent to-[#7C5CFC]" style={{ width: `${progress}%` }} /></div>}
          </div>
        ) : null}
        {day.length > 0 ? (
          <div className="divide-y divide-white/[0.05] overflow-hidden rounded-2xl border border-white/[0.08] bg-panel/40">
            {day.map((p, i) => {
              const isNow = now && p.start === now.start;
              return (
                <div key={i} className={clsx('flex items-start gap-4 px-4 py-2.5', isNow && 'bg-accent/[0.06]')}>
                  <span className="w-14 shrink-0 font-mono text-[12px] text-accent">{fmtTime(p.start)}</span>
                  <span className={clsx('text-[13px]', isNow ? 'font-semibold text-ink' : 'text-ink-2')}>{p.title}</span>
                </div>
              );
            })}
          </div>
        ) : !now ? (
          <div className="rounded-2xl border border-white/[0.08] bg-panel/40 px-4 py-6 text-center text-[13px] text-ink-3">{t('detail.noProgramme')}</div>
        ) : null}
      </div>

      {/* Similar channels */}
      {similar.length > 0 && (
        <div className="mt-7 px-[clamp(16px,2.6vw,40px)]">
          <h2 className="mb-3 text-[18px] font-bold text-ink">{t('detail.similar')}</h2>
          <div className="nw-scroll flex gap-4 overflow-x-auto pb-2">
            {similar.map((s) => (
              <button key={s.url} onClick={() => navigate(`/chaine/${s.id}`)} className="lift group w-[180px] shrink-0 overflow-hidden rounded-[14px] border border-white/[0.08] bg-panel text-left">
                <div className="grid aspect-video place-items-center bg-[radial-gradient(120%_120%_at_50%_0%,rgba(255,255,255,.06),rgba(8,11,17,.4))]">
                  {s.logo ? <img src={s.logo} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-[60%] max-w-[72%] object-contain" /> : <Radio className="text-ink/30" />}
                </div>
                <div className="truncate px-3 py-2 text-[13px] font-semibold text-ink">{s.name}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Action({ onClick, icon, label, active }: { onClick: () => void; icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <button onClick={onClick} className={clsx('flex h-12 items-center gap-2 rounded-[11px] border px-4 text-[13px] font-bold', active ? 'border-accent/40 bg-accent/[0.12] text-accent' : 'border-white/[0.08] bg-white/[0.06] text-ink hover:bg-white/[0.12]')}>
      {icon} <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
