import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { searchProgrammes, type ProgrammeResult } from '@/lib/epg';
import type { Channel } from '@/types';
import { useCatalog } from '@/store/catalogStore';
import { useAuth } from '@/store/authStore';
import { usePlayer } from '@/store/playerStore';
import { useUI } from '@/store/uiStore';
import { fmtTime, useT } from '@/lib/i18n';
import { monogram } from './ChannelCard';
import { LivePill, LogoImg, Meta } from './ui';

// Search results, second row: programmes on air (or coming) that match the
// query, across every channel with a guide (spec 4, Search). One card = one
// action: play the channel.
export function ProgramSearch() {
  const t = useT();
  const q = useCatalog((s) => s.filters.q);
  const epgEnabled = useAuth((s) => s.config?.epgEnabled);
  const play = usePlayer((s) => s.play);
  const addRecent = useCatalog((s) => s.addRecent);
  const setPricing = useUI((s) => s.setPricing);
  const [results, setResults] = useState<ProgrammeResult[]>([]);

  useEffect(() => {
    if (!epgEnabled || q.trim().length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    searchProgrammes(q).then((r) => alive && setResults(r.slice(0, 16)));
    return () => {
      alive = false;
    };
  }, [q, epgEnabled]);

  if (!results.length) return null;

  const open = async (r: ProgrammeResult) => {
    try {
      const ch = await api.get<Channel>(`/catalog/channel/${encodeURIComponent(r.channel.id)}?channelId=${encodeURIComponent(r.channelId)}`);
      if (ch.locked) {
        setPricing(true);
        return;
      }
      addRecent(ch);
      play(ch, { queue: [ch] });
    } catch {
      /* the channel is gone: nothing to play */
    }
  };

  return (
    <section className="row border-b border-line pb-2 pt-4">
      <div className="flex items-center gap-3 px-[var(--gouttiere)]">
        <h2 className="row-title m-0">{t(results.every((r) => r.live) ? 'search.onAirNow' : 'search.onAirAndNext')}</h2>
        <Meta parts={[t.n('count.shows', results.length)]} />
      </div>
      <div className="row-track scroll-pl-[var(--gouttiere)]">
        {results.map((r) => (
          <button
            key={`${r.channel.id}-${r.start}-${r.title}`}
            type="button"
            onClick={() => open(r)}
            className="lift flex w-[var(--carte-l)] shrink-0 snap-start items-center gap-3 rounded-card bg-[var(--surface-carte)] p-3 text-left shadow-[inset_0_0_0_1px_var(--line)]"
          >
            <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-field bg-[var(--plaque)]">
              <LogoImg
                src={r.channel.logo}
                w={96}
                width={56}
                height={40}
                loading="lazy"
                fallback={<span aria-hidden="true" translate="no" className="font-mono text-sous font-semibold text-[color:var(--plaque-encre)]">{monogram(r.channel.name)}</span>}
                className="h-auto max-h-[70%] w-auto max-w-[80%] object-contain"
              />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span translate="no" className="truncate text-sous font-semibold text-ink">{r.title}</span>
              <span className="flex min-w-0 items-center gap-2 text-meta text-ink-2">
                {r.live ? <LivePill /> : <span className="shrink-0 font-mono text-ink-3">{fmtTime(r.start)}</span>}
                <span translate="no" className="truncate">{r.channel.name}</span>
              </span>
            </span>
          </button>
        ))}
        <span aria-hidden="true" className="w-[var(--gouttiere)] shrink-0" />
      </div>
    </section>
  );
}
