import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, Radio, Loader2, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtTime } from '@/lib/epg';
import { useCatalog } from '@/store/catalogStore';
import { useT } from '@/lib/i18n';

interface GP { start: number; stop: number | null; title: string }
interface GC { id: number; name: string; logo: string | null; flag: string | null; channelId: string; locked: boolean; programmes: GP[] }

const PX_PER_MIN = 5;   // 1h = 300px
const LABEL_W = 168;
const ROW_H = 56;
const HOURS = 14;       // visible window length (scrollable)

// Netflix/Molotov-style 24h EPG grid: channels (rows) x time (columns), aligned to a
// shared time scale, with a "now" marker. Click any cell -> the channel detail page.
export function ProgrammeTv() {
  const navigate = useNavigate();
  const t = useT();
  const meta = useCatalog((s) => s.meta);
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? 'FR';
  const category = params.get('category') ?? '';
  const [channels, setChannels] = useState<GC[]>([]);
  const [loading, setLoading] = useState(true);

  const setFilter = (key: string, val: string) => {
    const next = new URLSearchParams(params);
    if (val) next.set(key, val); else next.delete(key);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    let alive = true; setLoading(true);
    const qs = new URLSearchParams();
    if (country) qs.set('country', country);
    if (category) qs.set('category', category);
    api.get<{ channels: GC[] }>(`/epg/grid?${qs.toString()}`)
      .then((r) => { if (alive) { setChannels(r.channels || []); setLoading(false); } })
      .catch(() => { if (alive) { setChannels([]); setLoading(false); } });
    return () => { alive = false; };
  }, [country, category]);

  const now = Date.now();
  const windowStart = useMemo(() => { const d = new Date(); d.setMinutes(0, 0, 0); return d.getTime() - 3600000; }, []);
  const gridW = HOURS * 60 * PX_PER_MIN;
  const xOf = (ms: number) => ((ms - windowStart) / 60000) * PX_PER_MIN;
  const hourMarks = Array.from({ length: HOURS + 1 }, (_, i) => windowStart + i * 3600000);
  const nowX = xOf(now);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1760px] px-[clamp(16px,2.6vw,40px)] pb-12 pt-4">
        {/* Header + filters */}
        <button onClick={() => navigate('/')} className="mb-3 flex w-fit items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent hover:text-accent">
          <ArrowLeft size={14} /> {t('detail.back')}
        </button>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 flex items-center gap-2 text-[clamp(22px,3vw,32px)] font-extrabold tracking-[-0.02em] text-ink"><CalendarClock className="text-accent" size={26} /> {t('programme.title')}</h1>
            <p className="mt-0.5 text-[13px] text-ink-3">{t('programme.subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={country} onChange={(e) => setFilter('country', e.target.value)} className="input w-full sm:w-auto">
              <option value="">{t('programme.allCountries')}</option>
              {meta?.countries.slice(0, 100).map((c) => <option key={c.code} value={c.code}>{c.flag} {c.name}</option>)}
            </select>
            <select value={category} onChange={(e) => setFilter('category', e.target.value)} className="input w-full sm:w-auto">
              <option value="">{t('programme.allCategories')}</option>
              {meta?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="animate-spin text-accent" size={30} /></div>
        ) : !channels.length ? (
          <div className="rounded-2xl border border-white/[0.08] bg-panel/40 px-4 py-16 text-center text-[14px] text-ink-3">{t('programme.empty')}</div>
        ) : (
          <div className="nw-scroll overflow-x-auto rounded-2xl border border-white/[0.06] bg-panel/30">
            <div className="relative" style={{ width: LABEL_W + gridW }}>
              {/* Time header */}
              <div className="sticky top-0 z-20 flex h-7 border-b border-white/[0.08] bg-surface/95 backdrop-blur">
                <div className="sticky left-0 z-10 shrink-0 bg-surface/95" style={{ width: LABEL_W }} />
                <div className="relative" style={{ width: gridW }}>
                  {hourMarks.map((h) => (
                    <span key={h} className="absolute top-1 font-mono text-[10px] text-ink-3" style={{ left: xOf(h) + 4 }}>{fmtTime(h)}</span>
                  ))}
                </div>
              </div>

              {/* Channel rows */}
              {channels.map((ch) => (
                <div key={ch.id} className="flex border-b border-white/[0.04]" style={{ height: ROW_H }}>
                  <button onClick={() => navigate(`/chaine/${ch.id}`)} className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-white/[0.08] bg-surface/95 px-2.5 text-left hover:bg-white/[0.04]" style={{ width: LABEL_W }}>
                    <span className="grid h-8 w-10 shrink-0 place-items-center overflow-hidden rounded bg-white/[0.05]">
                      {ch.logo ? <img src={ch.logo} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-[80%] max-w-[85%] object-contain" /> : <Radio size={14} className="text-ink/30" />}
                    </span>
                    <span className="truncate text-[12px] font-semibold text-ink">{ch.flag} {ch.name}</span>
                  </button>
                  <div className="relative" style={{ width: gridW }}>
                    {ch.programmes.map((p, i) => {
                      const end = p.stop || p.start + 3600000;
                      const left = xOf(p.start);
                      const right = xOf(end);
                      if (right <= 0 || left >= gridW) return null;
                      const cl = Math.max(0, left);
                      const w = Math.max(10, Math.min(gridW, right) - cl);
                      const isNow = p.start <= now && now < end;
                      return (
                        <button
                          key={i}
                          onClick={() => navigate(`/chaine/${ch.id}`)}
                          title={`${fmtTime(p.start)} ${p.title}`}
                          className={clsx('absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 text-left text-[11px] leading-tight', isNow ? 'border-accent/50 bg-accent/[0.14] text-ink' : 'border-white/[0.06] bg-white/[0.03] text-ink-2 hover:bg-white/[0.07]')}
                          style={{ left: cl, width: w }}
                        >
                          <span className="block font-mono text-[9px] text-accent/80">{fmtTime(p.start)}</span>
                          <span className="block truncate font-medium">{p.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Now marker */}
              {nowX >= 0 && nowX <= gridW && (
                <div className="pointer-events-none absolute z-[15] w-[2px] bg-live shadow-[0_0_8px_rgba(255,59,71,0.8)]" style={{ left: LABEL_W + nowX, top: 0, bottom: 0 }}>
                  <span className="absolute -top-0 left-1 rounded bg-live px-1 py-[1px] font-mono text-[8px] font-bold text-white">{t('programme.now')}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
