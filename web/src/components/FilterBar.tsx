import { clsx } from 'clsx';
import { Wifi, Globe2, RefreshCw, LayoutGrid } from 'lucide-react';
import { useCatalog } from '@/store/catalogStore';
import { useSettings, type Density } from '@/store/settingsStore';
import { categoryLabel } from '@/lib/format';
import { useT } from '@/lib/i18n';

export function FilterBar() {
  // Field selectors so the bar re-renders only on the slices it uses.
  const filters = useCatalog((s) => s.filters);
  const setFilters = useCatalog((s) => s.setFilters);
  const total = useCatalog((s) => s.total);
  const channels = useCatalog((s) => s.channels);
  const checkHealth = useCatalog((s) => s.checkHealth);
  const meta = useCatalog((s) => s.meta);
  const { density, set: setSettings } = useSettings();
  const t = useT();

  const title = filters.favoritesOnly
    ? t('home.favorites')
    : filters.foot
    ? '⚽ Football & Sport'
    : filters.category
    ? categoryLabel(filters.category)
    : filters.q
    ? `Résultats pour « ${filters.q} »`
    : t('filter.allChannels');

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-surface/95 px-4 py-2 backdrop-blur-xl">
      <div className="flex items-baseline gap-2">
        <h1 className="text-sm font-semibold text-ink">{title}</h1>
        {!filters.favoritesOnly && <span className="font-mono text-[11px] text-ink/40">{total.toLocaleString('fr')}</span>}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {meta && (
          <>
            <select
              value={filters.category || ''}
              onChange={(e) => setFilters({ category: e.target.value || null, foot: false, favoritesOnly: false })}
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-black/30 px-2 text-[11px] text-ink/70 focus:border-accent/40 focus:outline-none sm:w-auto"
              title="Catégorie"
            >
              <option value="">{t('filter.allCategories')}</option>
              {meta.categories.map((c) => (
                <option key={c.id} value={c.id}>{categoryLabel(c.id)} ({c.count})</option>
              ))}
            </select>
            <select
              value={filters.country || ''}
              onChange={(e) => setFilters({ country: e.target.value || null, favoritesOnly: false })}
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-black/30 px-2 text-[11px] text-ink/70 focus:border-accent/40 focus:outline-none sm:w-auto sm:max-w-[140px]"
              title="Pays"
            >
              <option value="">🌐 {t('filter.allCountries')}</option>
              {meta.countries.map((c) => (
                <option key={c.code} value={c.code}>{c.flag} {c.name} ({c.count})</option>
              ))}
            </select>
            <select
              value={filters.language || ''}
              onChange={(e) => setFilters({ language: e.target.value || null, favoritesOnly: false })}
              className="h-8 w-full rounded-lg border border-white/[0.06] bg-black/30 px-2 text-[11px] text-ink/70 focus:border-accent/40 focus:outline-none sm:w-auto sm:max-w-[130px]"
              title="Langue"
            >
              <option value="">{t('filter.allLanguages')}</option>
              {meta.languages.slice(0, 80).map((l) => (
                <option key={l.code} value={l.code}>{l.name} ({l.count})</option>
              ))}
            </select>
          </>
        )}
        <Toggle active={filters.onlineOnly} onClick={() => setFilters({ onlineOnly: !filters.onlineOnly })} icon={<Wifi size={13} />}>
          {t('filter.online')}
        </Toggle>
        <Toggle active={filters.hideGeoBlocked} onClick={() => setFilters({ hideGeoBlocked: !filters.hideGeoBlocked })} icon={<Globe2 size={13} />}>
          {t('filter.noGeo')}
        </Toggle>
        <button
          onClick={() => checkHealth(channels, true)}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.06] px-2.5 text-[11px] text-ink/60 hover:border-accent/30 hover:text-accent"
          title="Re-vérifier l'état des chaînes"
        >
          <RefreshCw size={13} /> <span className="hidden sm:inline">{t('filter.check')}</span>
        </button>

        <select
          value={filters.sort}
          onChange={(e) => setFilters({ sort: e.target.value as 'smart' | 'name' | 'latency' })}
          className="h-8 rounded-lg border border-white/[0.06] bg-black/30 px-2 text-[11px] text-ink/70 focus:border-accent/40 focus:outline-none"
          title="Trier"
        >
          <option value="smart">{t('filter.sortSmart')}</option>
          <option value="name">{t('filter.sortName')}</option>
          <option value="latency">{t('filter.sortLatency')}</option>
        </select>

        <div className="flex items-center overflow-hidden rounded-lg border border-white/[0.06]">
          <LayoutGrid size={13} className="ml-2 text-ink/40" />
          <select
            value={density}
            onChange={(e) => setSettings({ density: e.target.value as Density })}
            className="bg-transparent py-1.5 pl-1.5 pr-2 text-[11px] text-ink/70 focus:outline-none"
          >
            <option value="cozy">Large</option>
            <option value="comfortable">Normal</option>
            <option value="compact">Dense</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors',
        active ? 'border-accent/40 bg-accent/15 text-accent' : 'border-white/[0.06] text-ink/60 hover:text-ink'
      )}
    >
      {icon}
      <span className="hidden sm:inline">{children}</span>
    </button>
  );
}
