import { clsx } from 'clsx';
import { X, Palette, MonitorPlay, Languages } from 'lucide-react';
import { useSettings, ACCENTS, THEMES } from '@/store/settingsStore';
import { useUI } from '@/store/uiStore';
import { useI18n, useT, LANGS } from '@/lib/i18n';
import { useEscapeClose } from './ui';

export function Settings() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettings);
  const s = useSettings();
  const t = useT();
  const lang = useI18n((st) => st.lang);
  const setLang = useI18n((st) => st.setLang);
  useEscapeClose(open, () => setOpen(false));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-panel p-5 shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <Palette size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-ink">{t('set.title')}</h2>
          <button onClick={() => setOpen(false)} className="ml-auto rounded-lg p-1.5 text-ink/50 hover:bg-white/5">
            <X size={18} />
          </button>
        </div>

        {/* Language */}
        <Label icon={<Languages size={13} />}>{t('set.language')}</Label>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {LANGS.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={clsx('flex items-center justify-center gap-1.5 rounded-lg border py-2 text-[12px]', lang === l.code ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-ink/60 hover:text-ink')}
            >
              <span>{l.flag}</span> {l.label}
            </button>
          ))}
        </div>

        {/* Accent */}
        <Label>{t('set.accent')}</Label>
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(ACCENTS).map(([name, rgb]) => (
            <button
              key={name}
              onClick={() => s.set({ accent: name as keyof typeof ACCENTS })}
              className={clsx('h-8 w-8 rounded-full border-2 transition-transform hover:scale-110', s.accent === name ? 'border-white' : 'border-transparent')}
              style={{ background: `rgb(${rgb.join(',')})` }}
              aria-label={name}
            />
          ))}
        </div>

        {/* Theme */}
        <Label>{t('set.theme')}</Label>
        <div className="mb-4 grid grid-cols-4 gap-2">
          {Object.entries(THEMES).map(([name, t]) => (
            <button
              key={name}
              onClick={() => s.set({ theme: name as keyof typeof THEMES })}
              className={clsx('rounded-lg border-2 p-2 text-[10px] capitalize', s.theme === name ? 'border-accent text-accent' : 'border-white/10 text-ink/50')}
            >
              <span className="mb-1 block h-6 w-full rounded" style={{ background: `rgb(${t.surface.join(',')})` }} />
              {name}
            </button>
          ))}
        </div>

        {/* Density */}
        <Label>{t('set.density')}</Label>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {(['cozy', 'comfortable', 'compact'] as const).map((d) => (
            <button
              key={d}
              onClick={() => s.set({ density: d })}
              className={clsx('rounded-lg border py-2 text-[11px]', s.density === d ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-ink/60')}
            >
              {d === 'cozy' ? 'Large' : d === 'comfortable' ? 'Normal' : 'Dense'}
            </button>
          ))}
        </div>

        {/* Playback toggles */}
        <Label icon={<MonitorPlay size={13} />}>{t('set.playback')}</Label>
        <div className="space-y-1">
          <Switch label={t('set.defaultMuted')} checked={s.defaultMuted} onChange={(v) => s.set({ defaultMuted: v })} />
          <Switch label={t('set.autoplay')} checked={s.autoplay} onChange={(v) => s.set({ autoplay: v })} />
          <Switch label={t('set.preferProxy')} hint={t('set.preferProxyHint')} checked={s.preferProxy} onChange={(v) => s.set({ preferProxy: v })} />
          <Switch label={t('set.showOffline')} checked={s.showOffline} onChange={(v) => s.set({ showOffline: v })} />
          <Switch label={t('set.reduceMotion')} checked={s.reduceMotion} onChange={(v) => s.set({ reduceMotion: v })} />
        </div>
      </div>
    </div>
  );
}

function Label({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">{icon}{children}</p>;
}

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-white/[0.03]">
      <div className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-white/10')}>
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </div>
      <div>
        <span className="text-xs text-ink/80">{label}</span>
        {hint && <span className="block text-[10px] text-ink/40">{hint}</span>}
      </div>
    </button>
  );
}
