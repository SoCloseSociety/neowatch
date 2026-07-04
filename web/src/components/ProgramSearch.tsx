import { useEffect, useState } from 'react';
import { Tv2, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { searchProgrammes, fmtTime, type ProgrammeResult } from '@/lib/epg';
import type { Channel } from '@/types';
import { useCatalog } from '@/store/catalogStore';
import { useAuth } from '@/store/authStore';
import { usePlayer } from '@/store/playerStore';
import { useUI } from '@/store/uiStore';
import { useT } from '@/lib/i18n';

// Shows TV programmes (now / upcoming) matching the search query, across all
// channels that have EPG data. Clicking a result opens the channel.
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
    searchProgrammes(q).then((r) => alive && setResults(r));
    return () => {
      alive = false;
    };
  }, [q, epgEnabled]);

  if (!results.length) return null;

  const open = async (r: ProgrammeResult) => {
    try {
      const ch = await api.get<Channel>(`/catalog/channel/${r.channel.id}`);
      if (ch.locked) {
        setPricing(true);
        return;
      }
      addRecent(ch);
      play(ch);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="border-b border-white/[0.06] bg-panel/40 px-4 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">
        <Tv2 size={12} /> {t('progsearch.onAir')} « {q} »
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {results.map((r) => (
          <button
            key={`${r.channel.id}-${r.start}-${r.title}`}
            onClick={() => open(r)}
            className="group flex w-56 shrink-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2 text-left hover:border-accent/40 focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-black/40">
              {r.channel.logo ? (
                <img src={r.channel.logo} alt="" className="max-h-full max-w-full object-contain" referrerPolicy="no-referrer" />
              ) : (
                <Play size={14} className="text-ink/30" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                {r.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse-live rounded-full bg-emerald-400" />}
                <span className="truncate text-[11px] font-medium text-ink">{r.title}</span>
              </div>
              <div className="truncate text-[10px] text-ink/40">
                {r.channel.flag} {r.channel.name} · {fmtTime(r.start)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
