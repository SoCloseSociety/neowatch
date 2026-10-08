import { clsx } from 'clsx';
import { X, Eye, EyeOff, Pin } from 'lucide-react';
import { useUI } from '@/store/uiStore';
import { useAuth } from '@/store/authStore';
import { useCatalog } from '@/store/catalogStore';
import { usePrefs } from '@/store/prefsStore';
import { categoryIcon, categoryLabel } from '@/lib/format';
import { Button, EmptyState, Overline, useEscapeClose } from './ui';
import { countryLabel, languageLabel } from './ChannelCard';
import { useT, fmtNum } from '@/lib/i18n';

// Premium viewing preferences: tailor the huge catalog (hide categories you never
// watch, pin favourites, set the page the app opens on). Stored on the account.
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

  const categories = meta?.categories || [];

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-[var(--scrim-panneau)] p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prefs-title"
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-line bg-[var(--surface-panneau)] shadow-menu animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 border-b border-line p-[var(--pad-panneau)]">
          <div className="min-w-0 flex-1">
            <Overline>{t('pill.premium')}</Overline>
            <h2 id="prefs-title" className="m-0 mt-1 text-titre2 font-semibold text-ink">{t('pages.prefs.title')}</h2>
          </div>
          <Button variant="quiet" iconOnly onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('common.close')} icon={<X size={18} aria-hidden="true" />} />
        </div>

        {!isPremium ? (
          <EmptyState
            className="px-6 py-10"
            icon={<Pin size={30} />}
            title={t('pages.prefs.lockedTitle')}
            body={t('pages.prefs.lockedBody')}
            action={{ label: t('promo.discover'), onClick: () => { setOpen(false); setPricing(true); }, variant: 'primary' }}
          />
        ) : (
          <div className="flex-1 overflow-y-auto p-[var(--pad-panneau)]">
            <h3 className="m-0 mb-2 text-libelle font-semibold text-ink-2">{t('pages.prefs.home')}</h3>
            <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select aria-label={t('prefs.catAll')} value={prefs.home.category || ''} onChange={(e) => setHome({ category: e.target.value || null, foot: false })} className="input">
                <option value="">{t('prefs.catAll')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{categoryLabel(c.id)}</option>
                ))}
              </select>
              <select aria-label={t('prefs.countryAll')} value={prefs.home.country || ''} onChange={(e) => setHome({ country: e.target.value || null })} className="input">
                <option value="">{t('prefs.countryAll')}</option>
                {meta?.countries.map((c) => (
                  <option key={c.code} value={c.code} translate="no">{c.flag} {countryLabel({ country: c.code, countryName: c.name }, t.lang)}</option>
                ))}
              </select>
              <select aria-label={t('prefs.langAll')} value={prefs.home.language || ''} onChange={(e) => setHome({ language: e.target.value || null })} className="input">
                <option value="">{t('prefs.langAll')}</option>
                {meta?.languages.map((l) => (
                  <option key={l.code} value={l.code} translate="no">{languageLabel({ languages: [l.code], languageNames: [l.name] }, t.lang)}</option>
                ))}
              </select>
            </div>

            <h3 className="m-0 mb-1 text-libelle font-semibold text-ink-2">{t('pages.prefs.curate')}</h3>
            <p className="meta m-0 mb-3">{t('pages.prefs.curateHint')}</p>
            <ul className="m-0 list-none space-y-1.5 p-0">
              {categories.map((c) => {
                const hidden = prefs.hiddenCategories.includes(c.id);
                const pinned = prefs.pinnedCategories.includes(c.id);
                const name = categoryLabel(c.id);
                return (
                  <li key={c.id} className={clsx('flex items-center gap-2 rounded-field border border-line px-2.5 py-1.5', hidden && 'opacity-60')}>
                    <span className="text-sous" aria-hidden="true">{categoryIcon(c.id)}</span>
                    <span className="min-w-0 flex-1 truncate text-sous text-ink">{name}</span>
                    <span className="meta">{fmtNum(c.count)}</span>
                    <Button
                      variant="quiet"
                      iconOnly
                      onClick={() => togglePinned(c.id)}
                      aria-pressed={pinned}
                      aria-label={`${t('prefs.pin')} · ${name}`}
                      title={t('prefs.pin')}
                      className={pinned ? 'text-ink' : undefined}
                      icon={<Pin size={15} fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />}
                    />
                    <Button
                      variant="quiet"
                      iconOnly
                      onClick={() => toggleHidden(c.id)}
                      aria-pressed={hidden}
                      aria-label={`${hidden ? t('prefs.show') : t('prefs.hide')} · ${name}`}
                      title={hidden ? t('prefs.show') : t('prefs.hide')}
                      icon={hidden ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
