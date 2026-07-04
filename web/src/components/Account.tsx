import { useState } from 'react';
import { clsx } from 'clsx';
import { X, User as UserIcon, Crown, LogOut, KeyRound, Loader2, Check, SlidersHorizontal } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { useCatalog } from '@/store/catalogStore';
import { useEscapeClose } from './ui';
import { useT } from '@/lib/i18n';

export function Account() {
  const open = useUI((s) => s.accountOpen);
  const setOpen = useUI((s) => s.setAccount);
  const setPricing = useUI((s) => s.setPricing);
  const setPrefs = useUI((s) => s.setPrefs);
  const { user, logout, refresh } = useAuth();
  const t = useT();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState('');
  useEscapeClose(open, () => setOpen(false));

  if (!open || !user) return null;

  const expiry = user.planExpires ? new Date(user.planExpires).toLocaleDateString('fr') : null;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.put('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '' });
      setMsg({ kind: 'ok', text: 'Mot de passe mis à jour.' });
    } catch (e2) {
      setMsg({ kind: 'err', text: e2 instanceof ApiError ? e2.message : 'Échec' });
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.del('/auth/me', { password: delPw });
      logout();
      setOpen(false);
    } catch (e2) {
      setMsg({ kind: 'err', text: e2 instanceof ApiError ? e2.message : 'Échec' });
    } finally {
      setBusy(false);
    }
  };

  const cancelPremium = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/billing/cancel');
      await refresh();
      await useCatalog.getState().loadChannels();
      setMsg({ kind: 'ok', text: 'Abonnement Premium résilié.' });
    } catch {
      setMsg({ kind: 'err', text: 'Échec de la résiliation' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-panel p-5 shadow-2xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center gap-2">
          <UserIcon size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-ink">{t('top.account')}</h2>
          <button onClick={() => setOpen(false)} aria-label={t('common.close')} className="ml-auto rounded-lg p-1.5 text-ink/50 hover:bg-white/5">
            <X size={18} />
          </button>
        </div>

        <div className="mb-4 space-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-sm">
          <div className="flex justify-between"><span className="text-ink/50">{t('account.email')}</span><span className="text-ink/90">{user.email}</span></div>
          <div className="flex justify-between"><span className="text-ink/50">{t('account.role')}</span><span className="text-ink/90">{user.role}</span></div>
          <div className="flex justify-between">
            <span className="text-ink/50">{t('account.plan')}</span>
            <span className={clsx('flex items-center gap-1 font-semibold', user.premium ? 'text-amber-300' : 'text-ink/70')}>
              {user.premium && <Crown size={13} />}{user.premium ? t('common.premium') : t('account.free')}
            </span>
          </div>
          {user.premium && expiry && (
            <div className="flex justify-between"><span className="text-ink/50">{t('account.expires')}</span><span className="text-ink/90">{expiry}</span></div>
          )}
        </div>

        {/* Plan actions */}
        {user.role !== 'admin' && (
          user.premium ? (
            <button onClick={cancelPremium} disabled={busy} className="mb-4 w-full rounded-lg border border-white/10 py-2 text-sm text-ink/70 hover:border-rose-500/30 hover:text-rose-400 disabled:opacity-50">
              {t('account.cancel')}
            </button>
          ) : (
            <button onClick={() => { setOpen(false); setPricing(true); }} className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-sm font-semibold text-black hover:opacity-90">
              <Crown size={15} /> {t('account.upgrade')}
            </button>
          )
        )}

        {/* Viewing preferences (premium: hide/pin categories, default home). The
            panel existed but had no entry point -- wire it here for premium users. */}
        {user.premium && (
          <button onClick={() => { setOpen(false); setPrefs(true); }} className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-2 text-sm text-ink/70 hover:border-accent/30 hover:text-accent">
            <SlidersHorizontal size={15} /> {t('account.prefs')}
          </button>
        )}

        {/* Change password */}
        <form onSubmit={changePassword} className="space-y-2">
          <p className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40"><KeyRound size={12} /> {t('account.password')}</p>
          <input type="password" required placeholder={t('account.currentPw')} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className="input w-full" />
          <input type="password" required minLength={6} placeholder={t('account.newPw')} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className="input w-full" />
          <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 py-2 text-sm text-accent hover:bg-accent/20 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t('account.update')}
          </button>
        </form>

        {msg && <p className={clsx('mt-3 rounded-lg px-3 py-2 text-center text-xs', msg.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400')}>{msg.text}</p>}

        <button onClick={() => { logout(); setOpen(false); }} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-2 text-sm text-ink/60 hover:text-rose-400">
          <LogOut size={15} /> {t('account.logout')}
        </button>

        {/* GDPR: self-service deletion. Two-step: reveal a password confirm. */}
        {delOpen ? (
          <form onSubmit={deleteAccount} className="mt-3 space-y-2 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3">
            <p className="text-[11px] text-rose-300">{t('account.deleteWarn')}</p>
            <input type="password" required placeholder={t('account.currentPw')} value={delPw} onChange={(e) => setDelPw(e.target.value)} className="input w-full" />
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-rose-500/80 py-2 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50">{t('account.deleteConfirm')}</button>
              <button type="button" onClick={() => setDelOpen(false)} className="rounded-lg border border-white/10 px-3 text-xs text-ink/60 hover:text-ink">{t('common.close')}</button>
            </div>
          </form>
        ) : (
          <button onClick={() => setDelOpen(true)} className="mt-2 w-full py-1 text-center text-[11px] text-ink/30 hover:text-rose-400">
            {t('account.delete')}
          </button>
        )}
      </div>
    </div>
  );
}
