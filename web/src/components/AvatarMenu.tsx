import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { useUI, toast } from '@/store/uiStore';
import { useAuth } from '@/store/authStore';
import { useCatalog } from '@/store/catalogStore';
import { useT, useI18n, LANGS } from '@/lib/i18n';
import { navigateFromLayers } from '@/lib/spatialNav';
import { insideTvShell } from './Install';
import { Pill } from './ui';

// The avatar menu (spec 2.1): everything that is not a door. Opened from the
// top bar; it is a layer (spatialNav): Back / Escape close it, the D-pad stays
// inside, the focus goes back to the avatar.

function Item({ children, onSelect, autoFocus, danger }: { children: ReactNode; onSelect: () => void; autoFocus?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-autofocus={autoFocus ? '' : undefined}
      onClick={onSelect}
      className={clsx(
        'flex min-h-[var(--cible-doigt)] w-full items-center gap-3 rounded-field px-3 text-left text-sous transition-colors duration-d1 hover:bg-[var(--bg-3)] focus-visible:bg-[var(--bg-3)]',
        danger ? 'text-[var(--red)]' : 'text-ink'
      )}
    >
      {children}
    </button>
  );
}

export function AvatarMenu() {
  const open = useUI((s) => s.avatarOpen);
  const setOpen = useUI((s) => s.setAvatar);
  const ui = useUI();
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const logout = useAuth((s) => s.logout);
  const setFilters = useCatalog((s) => s.setFilters);
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);
  const navigate = useNavigate();
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  // An outside click closes it (the avatar button toggles it itself).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Element | null;
      if (!ref.current || ref.current.contains(tgt) || tgt?.closest('[data-avatar]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, setOpen]);

  if (!open) return null;

  const close = () => setOpen(false);
  /** Close, then run (a modal opens on top: it takes the menu's history entry). */
  const then = (fn: () => void) => () => {
    close();
    fn();
  };
  const go = (to: string) => () => {
    navigateFromLayers(navigate, to);
    close();
  };

  return (
    <div
      ref={ref}
      data-layer="avatar"
      role="menu"
      aria-label={t('shell.menu')}
      className="absolute right-0 top-[calc(100%+10px)] z-50 w-[var(--menu-l)] min-w-[240px] rounded-card border border-line-strong bg-[var(--surface-menu)] p-1.5 shadow-menu animate-fade-in"
    >
      {user && (
        <div className="mb-1 border-b border-line px-3 pb-2.5 pt-2">
          <p translate="no" className="truncate text-sous font-semibold text-ink">
            {user.name || user.email}
          </p>
          {user.name && (
            <p translate="no" className="meta truncate">
              {user.email}
            </p>
          )}
          {user.premium && <Pill tone="ok" className="mt-2">{t('pill.premium')}</Pill>}
        </div>
      )}

      {user ? (
        <Item
          autoFocus
          onSelect={() => {
            setFilters({ favoritesOnly: true });
            navigateFromLayers(navigate, '/');
            close();
          }}
        >
          {t('menu.myList')}
        </Item>
      ) : (
        <Item autoFocus onSelect={then(() => ui.setLogin(true))}>
          {t('top.login')}
        </Item>
      )}
      {user?.premium ? (
        <Item onSelect={then(() => ui.setAccount(true))}>{t('menu.premiumOn')}</Item>
      ) : (
        <Item onSelect={then(() => ui.setPricing(true))}>{t('menu.premium')}</Item>
      )}
      {user && <Item onSelect={then(() => ui.setAccount(true))}>{t('top.account')}</Item>}
      {!insideTvShell() && <Item onSelect={then(() => ui.setInstall(true))}>{t('menu.install')}</Item>}
      <Item onSelect={then(() => ui.setSettings(true))}>{t('menu.settings')}</Item>
      {isAdmin && <Item onSelect={go('/admin')}>{t('menu.admin')}</Item>}

      <div className="mt-1 border-t border-line pt-1.5" role="group" aria-label={t('menu.language')}>
        <p className="overline px-3 pb-1">{t('menu.language')}</p>
        {LANGS.map((l) => (
          <button
            type="button"
            key={l.code}
            role="menuitemradio"
            aria-checked={lang === l.code}
            lang={l.code}
            onClick={() => setLang(l.code)}
            className="flex min-h-[var(--cible-doigt)] w-full items-center gap-3 rounded-field px-3 text-left text-sous text-ink hover:bg-[var(--bg-3)] focus-visible:bg-[var(--bg-3)]"
          >
            <span translate="no">{l.label}</span>
            {lang === l.code && <Check size={16} aria-hidden="true" className="ml-auto text-ink-2" />}
          </button>
        ))}
      </div>

      {user && (
        <div className="mt-1 border-t border-line pt-1.5">
          <Item
            onSelect={() => {
              close();
              logout();
              toast(t('shell.signedOut'), { ok: true });
            }}
          >
            {t('menu.signOut')}
          </Item>
        </div>
      )}
    </div>
  );
}
