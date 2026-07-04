import { clsx } from 'clsx';
import { X, SlidersHorizontal, Crown, Eye, EyeOff, Pin, Home } from 'lucide-react';
import { useUI } from '@/store/uiStore';
import { useAuth } from '@/store/authStore';
import { useCatalog } from '@/store/catalogStore';
import { usePrefs } from '@/store/prefsStore';
import { categoryIcon, categoryLabel } from '@/lib/format';
import { useEscapeClose } from './ui';
import { useT } from '@/lib/i18n';

// Premium "watch preferences": tailor the huge catalog to your needs
// (hide categories you never watch, pin favourites, set a default home view).
export function Preferences() {
  const open = useUI((s) => s.prefsOpen);
  const setOpen = useUI((s) => s.setPrefs);
  const setPricing = useUI((s) => s.setPricing);
  const isPremium = useAuth((s) => s.isPremium());
  const meta = useCatalog((s) => s.meta);
  const { prefs, toggleHidden, togglePinned, setHome } = usePrefs();
  const t = useT();
  useEscapeClose(open, () => setOpen(false));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-white/10 bg-panel shadow-2xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/[0.06] p-4">
          <SlidersHorizontal size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-ink">{t('prefs.title')}</h2>
          <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300"><Crown size={11} /> Premium</span>
          <button onClick={() => setOpen(false)} className="ml-auto rounded-lg p-1.5 text-ink/50 hover:bg-white/5">
            <X size={18} />
          </button>
        </div>

        {!isPremium ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <Crown size={32} className="text-amber-400" />
            <p className="text-sm text-ink/70">{t('prefs.upsellBody')}</p>
            <button onClick={() => { setOpen(false); setPricing(true); }} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:opacity-90">
              {t('prefs.unlock')}
            </button>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            {/* Home defaults */}
            <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">
              <Home size={12} /> {t('prefs.homeDefault')}
            </h3>
            <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select value={prefs.home.category || ''} onChange={(e) => setHome({ category: e.target.value || null, foot: false })} className="input">
                <option value="">{t('prefs.catAll')}</option>
                {meta?.categories.map((c) => (
                  <option key={c.id} value={c.id}>{categoryLabel(c.id)}</option>
                ))}
              </select>
              <select value={prefs.home.country || ''} onChange={(e) => setHome({ country: e.target.value || null })} className="input">
                <option value="">{t('prefs.countryAll')}</option>
                {meta?.countries.slice(0, 100).map((c) => (
                  <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
                ))}
              </select>
              <select value={prefs.home.language || ''} onChange={(e) => setHome({ language: e.target.value || null })} className="input">
                <option value="">{t('prefs.langAll')}</option>
                {meta?.languages.slice(0, 80).map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
              </select>
            </div>

            {/* Category curation */}
            <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">
              <Eye size={12} /> {t('prefs.curate')}
            </h3>
            <div className="space-y-1">
              {meta?.categories.map((c) => {
                const hidden = prefs.hiddenCategories.includes(c.id);
                const pinned = prefs.pinnedCategories.includes(c.id);
                return (
                  <div key={c.id} className={clsx('flex items-center gap-2 rounded-lg border px-2 py-1.5', hidden ? 'border-white/[0.04] opacity-50' : 'border-white/[0.06]')}>
                    <span className="text-sm">{categoryIcon(c.id)}</span>
                    <span className="flex-1 truncate text-xs text-ink/80">{categoryLabel(c.id)}</span>
                    <span className="font-mono text-[9px] text-ink/30">{c.count.toLocaleString('fr')}</span>
                    <button onClick={() => togglePinned(c.id)} title={t('prefs.pin')} className={clsx('rounded p-1', pinned ? 'text-accent' : 'text-ink/40 hover:text-accent')}>
                      <Pin size={13} fill={pinned ? 'currentColor' : 'none'} />
                    </button>
                    <button onClick={() => toggleHidden(c.id)} title={hidden ? t('prefs.show') : t('prefs.hide')} className={clsx('rounded p-1', hidden ? 'text-rose-400' : 'text-ink/40 hover:text-rose-400')}>
                      {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
