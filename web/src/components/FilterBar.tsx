import { useState } from 'react';
import { clsx } from 'clsx';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useCatalog } from '@/store/catalogStore';
import { categoryLabel } from '@/lib/format';
import { fmtAge, fmtNum, fmtTime, useT } from '@/lib/i18n';
import { Meta } from './ui';
import { countryLabel, languageLabel } from './ChannelCard';

// One row (spec section 5, Lot A): title + mono count + list age on the left;
// Category, Country, Language, "Online only", "Playable here" and "Check again"
// on the right. On a phone the controls fold behind one "Filters" button so the
// first card stays near the top (UX-20). Sort and grid size live in Settings.
export function FilterBar() {
  const t = useT();
  const filters = useCatalog((s) => s.filters);
  const setFilters = useCatalog((s) => s.setFilters);
  const total = useCatalog((s) => s.total);
  const channels = useCatalog((s) => s.channels);
  const checkHealth = useCatalog((s) => s.checkHealth);
  const meta = useCatalog((s) => s.meta);
  const [open, setOpen] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  const q = filters.q.trim();
  const title = filters.favoritesOnly
    ? t('home.myListTitle')
    : q
    ? t('search.resultsFor', { q })
    : filters.foot
    ? t('cat.foot')
    : filters.category
    ? categoryLabel(filters.category)
    : t('filter.allChannels');

  const active = [filters.category && !filters.foot, filters.country, filters.language, filters.onlineOnly, filters.hideGeoBlocked].filter(Boolean).length;

  const check = async () => {
    setChecking(true);
    try {
      await checkHealth(channels, true);
    } finally {
      setChecking(false);
      setCheckedAt(Date.now());
    }
  };

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line bg-surface/95 px-[var(--gouttiere)] py-3 backdrop-blur-xl [:root[data-tv]_&]:backdrop-blur-none">
      <div className="min-w-0 flex-1 sm:flex-none">
        <h1 className="m-0 truncate text-rangee font-semibold text-ink" translate={q ? 'no' : undefined}>
          {title}
        </h1>
        <Meta
          parts={[
            filters.favoritesOnly ? t.n('count.channels', channels.length) : t.n('count.channels', total),
            meta?.updatedAt ? t('filterbar.listFrom', { time: fmtTime(meta.updatedAt) }) : null,
          ]}
        />
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="btn btn-secondary sm:hidden"
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        {t('filterbar.filters')}
        {active > 0 && <span className="font-mono text-meta text-ink-2">{fmtNum(active)}</span>}
      </button>

      <div className={clsx('w-full flex-wrap items-center gap-2 sm:ml-auto sm:flex sm:w-auto', open ? 'flex' : 'hidden')}>
        {meta && (
          <>
            <select
              value={filters.foot ? '' : filters.category || ''}
              onChange={(e) => setFilters({ category: e.target.value || null, foot: false, favoritesOnly: false })}
              className="input w-full pr-8 sm:w-auto sm:max-w-[200px]"
              aria-label={t('filterbar.category')}
              title={t('filterbar.category')}
            >
              <option value="">{t('filter.allCategories')}</option>
              {meta.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryLabel(c.id)} ({fmtNum(c.count)})
                </option>
              ))}
            </select>
            <select
              value={filters.country || ''}
              onChange={(e) => setFilters({ country: e.target.value || null, favoritesOnly: false })}
              className="input w-full pr-8 sm:w-auto sm:max-w-[200px]"
              aria-label={t('filterbar.country')}
              title={t('filterbar.country')}
            >
              <option value="">{t('filter.allCountries')}</option>
              {meta.countries.map((c) => (
                <option key={c.code} value={c.code} translate="no">
                  {c.flag} {countryLabel({ country: c.code, countryName: c.name }, t.lang)} ({fmtNum(c.count)})
                </option>
              ))}
            </select>
            <select
              value={filters.language || ''}
              onChange={(e) => setFilters({ language: e.target.value || null, favoritesOnly: false })}
              className="input w-full pr-8 sm:w-auto sm:max-w-[180px]"
              aria-label={t('filterbar.language')}
              title={t('filterbar.language')}
            >
              <option value="">{t('filter.allLanguages')}</option>
              {meta.languages.slice(0, 80).map((l) => (
                <option key={l.code} value={l.code} translate="no">
                  {languageLabel({ languages: [l.code], languageNames: [l.name] }, t.lang)} ({fmtNum(l.count)})
                </option>
              ))}
            </select>
          </>
        )}
        <Toggle active={filters.onlineOnly} onClick={() => setFilters({ onlineOnly: !filters.onlineOnly })}>
          {t('filter.online')}
        </Toggle>
        <Toggle active={filters.hideGeoBlocked} onClick={() => setFilters({ hideGeoBlocked: !filters.hideGeoBlocked })}>
          {t('filter.noGeo')}
        </Toggle>
        <span className="flex items-center gap-1">
          <button type="button" onClick={check} disabled={checking || !channels.length} className="btn btn-quiet px-3">
            <RefreshCw size={16} aria-hidden="true" />
            {t('filter.checkAgain')}
          </button>
          {(checking || checkedAt) && (
            <span className="meta">{checking ? t('filterbar.checking') : t('meta.checked', { age: fmtAge(checkedAt as number) })}</span>
          )}
        </span>
      </div>
    </div>
  );
}

// A two-state switch: the word + a check glyph, bone frame when on (never mint).
function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx('btn btn-secondary px-3.5', active && 'border-[color:var(--t1)] bg-[var(--bg-3)]')}
    >
      <span aria-hidden="true" className={clsx('font-mono', !active && 'text-ink-3')}>
        {active ? '✓' : '○'}
      </span>
      {children}
    </button>
  );
}
