import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useSettings, THEMES, type ThemeName, type Density } from '@/store/settingsStore';
import { useUI } from '@/store/uiStore';
import { useCatalog } from '@/store/catalogStore';
import type { Filters } from '@/types';
import { isTV } from '@/lib/device';
import { useI18n, useT, LANGS } from '@/lib/i18n';
import { Button, Overline, useEscapeClose } from './ui';

const STYLES: { id: ThemeName; key: string }[] = [
  { id: 'lunaire', key: 'set.lunaire' },
  { id: 'doux', key: 'set.doux' },
];
const SORTS: { id: Filters['sort']; key: string }[] = [
  { id: 'smart', key: 'pages.settings.sortSmart' },
  { id: 'name', key: 'pages.settings.sortName' },
  { id: 'latency', key: 'pages.settings.sortLatency' },
];
const DENSITIES: { id: Density; key: string }[] = [
  { id: 'cozy', key: 'pages.settings.large' },
  { id: 'comfortable', key: 'pages.settings.normal' },
  { id: 'compact', key: 'pages.settings.compact' },
];

export function Settings() {
  const open = useUI((s) => s.settingsOpen);
  const setOpen = useUI((s) => s.setSettings);
  const s = useSettings();
  const sort = useCatalog((c) => c.filters.sort);
  const setFilters = useCatalog((c) => c.setFilters);
  const t = useT();
  const lang = useI18n((st) => st.lang);
  const setLang = useI18n((st) => st.setLang);
  const tv = isTV();
  useEscapeClose(open, () => setOpen(false));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim-panneau)] p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-card border border-line bg-[var(--surface-panneau)] p-[var(--pad-panneau)] shadow-menu animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Overline>{t('menu.settings')}</Overline>
            <h2 id="settings-title" className="m-0 mt-1 text-titre2 font-semibold text-ink">{t('set.title')}</h2>
          </div>
          <Button variant="quiet" iconOnly onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('common.close')} icon={<X size={18} aria-hidden="true" />} />
        </div>

        {/* Language */}
        <Group label={t('set.language')}>
          <div role="radiogroup" aria-label={t('set.language')} className="grid grid-cols-3 gap-2">
            {LANGS.map((l) => (
              <Choice key={l.code} checked={lang === l.code} onClick={() => setLang(l.code)}>
                <span translate="no" lang={l.code}>{l.label}</span>
              </Choice>
            ))}
          </div>
        </Group>

        {/* Style: Lunaire (dark) or Doux (light). A TV is always Lunaire. */}
        <Group label={t('set.theme')}>
          {tv ? (
            <p className="m-0 text-sous text-ink-2">{t('pages.settings.tvStyle')}</p>
          ) : (
            <div role="radiogroup" aria-label={t('set.theme')} className="grid grid-cols-2 gap-2">
              {STYLES.map((st) => (
                <Choice key={st.id} checked={s.theme === st.id} onClick={() => s.set({ theme: st.id })}>
                  <span
                    aria-hidden="true"
                    className="h-5 w-5 shrink-0 rounded-pill border border-line-strong"
                    style={{ background: `rgb(${THEMES[st.id].surface.join(',')})` }}
                  />
                  {t(st.key)}
                </Choice>
              ))}
            </div>
          )}
        </Group>

        {/* Channel order in the grid and the search results (left the filter bar, spec 2.3). */}
        <Group label={t('pages.settings.sort')}>
          <div role="radiogroup" aria-label={t('pages.settings.sort')} className="grid grid-cols-3 gap-2">
            {SORTS.map((o) => (
              <Choice key={o.id} checked={sort === o.id} onClick={() => setFilters({ sort: o.id })}>
                {t(o.key)}
              </Choice>
            ))}
          </div>
        </Group>

        {/* Grid size */}
        <Group label={t('set.density')}>
          <div role="radiogroup" aria-label={t('set.density')} className="grid grid-cols-3 gap-2">
            {DENSITIES.map((d) => (
              <Choice key={d.id} checked={s.density === d.id} onClick={() => s.set({ density: d.id })}>
                {t(d.key)}
              </Choice>
            ))}
          </div>
        </Group>

        {/* Playback */}
        <Group label={t('set.playback')} last>
          <div className="space-y-1">
            <Switch label={t('pages.settings.muted')} checked={s.defaultMuted} onChange={(v) => s.set({ defaultMuted: v })} />
            <Switch label={t('pages.settings.autoplay')} checked={s.autoplay} onChange={(v) => s.set({ autoplay: v })} />
            <Switch label={t('pages.settings.relay')} hint={t('pages.settings.relayHint')} checked={s.preferProxy} onChange={(v) => s.set({ preferProxy: v })} />
            <Switch label={t('pages.settings.offAir')} checked={s.showOffline} onChange={(v) => s.set({ showOffline: v })} />
            <Switch label={t('pages.settings.motion')} checked={s.reduceMotion} onChange={(v) => s.set({ reduceMotion: v })} />
          </div>
        </Group>
      </div>
    </div>
  );
}

function Group({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <section className={clsx(!last && 'mb-5')}>
      <h3 className="m-0 mb-2 text-libelle font-semibold text-ink-2">{label}</h3>
      {children}
    </section>
  );
}

function Choice({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={clsx(
        'flex min-h-[var(--btn-h)] items-center justify-center gap-2 rounded-field border px-2 text-sous',
        checked ? 'border-ink bg-[var(--bg-3)] font-semibold text-ink' : 'border-line text-ink-2'
      )}
    >
      {children}
    </button>
  );
}

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-[var(--btn-h)] w-full items-center gap-3 rounded-field px-1 py-2 text-left"
    >
      <span aria-hidden="true" className={clsx('relative h-6 w-10 shrink-0 rounded-pill border transition-colors duration-d1', checked ? 'border-mint bg-mint' : 'border-line-strong bg-[var(--bg-3)]')}>
        <span className={clsx('absolute top-[3px] h-4 w-4 rounded-pill bg-[var(--t1)] transition-transform duration-d1', checked ? 'translate-x-[19px]' : 'translate-x-[3px]')} />
      </span>
      <span className="min-w-0">
        <span className="block text-sous text-ink">{label}</span>
        {hint && <span className="block text-meta text-ink-3">{hint}</span>}
      </span>
    </button>
  );
}
