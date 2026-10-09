import { useState } from 'react';
import { X, LogOut, KeyRound, Download, SlidersHorizontal } from 'lucide-react';
import { api, ApiError, adoptToken, getToken } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import type { User } from '@/types';
import { useUI, toast } from '@/store/uiStore';
import { useCatalog } from '@/store/catalogStore';
import { Button, Overline, Pill, Spinner, useEscapeClose } from './ui';
import { useT, useI18n, fmtDate, type TFn } from '@/lib/i18n';

// Server messages are developer English: map them to our own sentences.
function errorText(t: TFn, e: unknown): string {
  const m = e instanceof ApiError ? e.message.toLowerCase() : '';
  if (m.includes('incorrect')) return t('pages.account.wrongPw');
  if (m.includes('concurrently')) return t('pages.account.pwRace');
  if (m.includes('character password') || m.includes('new ')) return t('pages.account.pwRule');
  if (m.includes('last admin')) return t('pages.account.lastAdmin');
  if (m.includes('subscription') || m.includes('stripe')) return t('pages.account.billingDown');
  return t('pages.account.failed');
}

const DATE_LONG: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };

type Section = 'plan' | 'pw' | 'data';
type Msg = { kind: 'ok' | 'err'; text: string; at: Section };

export function Account() {
  const open = useUI((s) => s.accountOpen);
  const setOpen = useUI((s) => s.setAccount);
  const user = useAuth((s) => s.user);
  useEscapeClose(open, () => setOpen(false));
  if (!open || !user) return null;
  // The form lives only while the dialog is open, and per account: typed
  // passwords and messages never survive a close or reach the next user of a
  // shared TV or browser (WEB-9).
  return <AccountDialog key={user.id} user={user} />;
}

function AccountDialog({ user }: { user: User }) {
  const setOpen = useUI((s) => s.setAccount);
  const setPricing = useUI((s) => s.setPricing);
  const setPrefs = useUI((s) => s.setPrefs);
  const { logout, refresh } = useAuth();
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState<null | 'pw' | 'plan' | 'export' | 'delete'>(null);
  // One message, shown in the section of the action that set it (QA-10).
  const [msg, setMsg] = useState<Msg | null>(null);
  const [cancelAsk, setCancelAsk] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState('');

  const close = () => setOpen(false);
  const isAdmin = user.role === 'admin';
  const expiry = user.planExpires ? fmtDate(user.planExpires, DATE_LONG) : null;
  const pending = !!user.cancelAtPeriodEnd;
  const source = user.planSource === 'admin' ? t('pages.account.srcAdmin') : user.planSource === 'mock' ? t('pages.account.srcTest') : user.planSource === 'stripe' ? t('pages.account.srcCard') : null;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('pw');
    setMsg(null);
    try {
      // The change signs every other device out; this one receives a fresh token.
      const r = await api.put<{ ok: boolean; token?: string }>('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      adoptToken(r.token);
      setPw({ current: '', next: '' });
      setMsg({ kind: 'ok', text: t('pages.account.pwDone'), at: 'pw' });
    } catch (e2) {
      setMsg({ kind: 'err', text: errorText(t, e2), at: 'pw' });
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('delete');
    setMsg(null);
    try {
      await api.del('/auth/me', { password: delPw });
      logout();
      close();
      toast(t('pages.account.deleted'), { ok: true });
    } catch (e2) {
      setMsg({ kind: 'err', text: errorText(t, e2), at: 'data' });
    } finally {
      setBusy(null);
    }
  };

  const cancelPremium = async () => {
    setBusy('plan');
    setMsg(null);
    try {
      // Premium stays on until the end of the paid period.
      const r = await api.post<{ endsAt?: number | null }>(`/billing/cancel?lang=${lang}`);
      await refresh();
      await useCatalog.getState().loadChannels();
      setCancelAsk(false);
      // With an end date, the plan note above already says it (same sentence): once is enough.
      const u = useAuth.getState().user;
      const noted = !!(r.endsAt && u?.premium && u.cancelAtPeriodEnd && u.planExpires);
      if (!noted) setMsg({ kind: 'ok', text: r.endsAt ? t('pages.account.cancelled', { date: fmtDate(r.endsAt, DATE_LONG) }) : t('pages.account.cancelledNow'), at: 'plan' });
    } catch (e2) {
      setMsg({ kind: 'err', text: errorText(t, e2), at: 'plan' });
    } finally {
      setBusy(null);
    }
  };

  const resumePremium = async () => {
    setBusy('plan');
    setMsg(null);
    try {
      await api.post(`/billing/checkout?lang=${lang}`, { plan: 'premium' });
      await refresh();
      setMsg({ kind: 'ok', text: t('pages.pricing.resumed'), at: 'plan' });
    } catch (e2) {
      setMsg({ kind: 'err', text: errorText(t, e2), at: 'plan' });
    } finally {
      setBusy(null);
    }
  };

  // GDPR access + portability: GET /api/auth/me/export as a file.
  const exportData = async () => {
    setBusy('export');
    setMsg(null);
    try {
      const res = await fetch('/api/auth/me/export', { headers: { Authorization: `Bearer ${getToken() || ''}` } });
      if (!res.ok) throw new ApiError(res.statusText, res.status, null);
      adoptToken(res.headers.get('X-Renewed-Token'));
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = 'neowatch-my-data.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      toast(t('pages.account.exported'), { ok: true });
    } catch {
      setMsg({ kind: 'err', text: t('pages.account.failed'), at: 'data' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center overflow-y-auto bg-[var(--scrim-panneau)] p-4 backdrop-blur-sm" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        className="my-auto w-full max-w-md rounded-card border border-line bg-[var(--surface-panneau)] p-[var(--pad-panneau)] shadow-menu animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Overline>{t('pages.account.overline')}</Overline>
            <h2 id="account-title" className="m-0 mt-1 truncate text-titre2 font-semibold text-ink" translate="no">{user.name || user.email}</h2>
          </div>
          <Button variant="quiet" iconOnly onClick={close} aria-label={t('common.close')} title={t('common.close')} icon={<X size={18} aria-hidden="true" />} />
        </div>

        <dl className="m-0 mb-4 space-y-2 rounded-field border border-line bg-[var(--bg-2)] p-3 text-sous">
          <Row label={t('account.email')}><span translate="no">{user.email}</span></Row>
          <Row label={t('account.plan')}>
            <span className="flex flex-wrap items-center justify-end gap-2">
              {user.premium ? <Pill tone="ok">{t('pill.premium')}</Pill> : <span className="text-ink">{t('account.free')}</span>}
            </span>
          </Row>
          {user.premium && source && <Row label={t('pages.account.source')}>{source}</Row>}
          {user.premium && expiry && !isAdmin && (
            <Row label={pending ? t('pages.account.endsOn') : t('pages.account.renewsOn')}>{expiry}</Row>
          )}
        </dl>

        {pending && user.premium && expiry && (
          <p className="mb-3 mt-0 text-sous text-ink-2">{t('pages.account.pendingNote', { date: expiry })}</p>
        )}

        {/* Plan actions: one primary in this dialog at most */}
        {!isAdmin && (
          user.premium ? (
            pending ? (
              <Button variant="primary" onClick={resumePremium} disabled={!!busy} className="mb-3 w-full">
                {busy === 'plan' && <Spinner className="h-4 w-4" />}
                {t('pages.pricing.resume')}
              </Button>
            ) : cancelAsk ? (
              <div className="mb-3 rounded-field border border-line p-3">
                <p className="m-0 mb-2 text-sous text-ink">{expiry ? t('pages.account.cancelAsk', { date: expiry }) : t('pages.account.cancelAskNow')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="danger" onClick={cancelPremium} disabled={!!busy}>
                    {busy === 'plan' && <Spinner className="h-4 w-4" />}
                    {t('pages.account.cancelConfirm')}
                  </Button>
                  <Button variant="quiet" onClick={() => setCancelAsk(false)}>{t('pages.account.keepPremium')}</Button>
                </div>
              </div>
            ) : (
              <Button onClick={() => setCancelAsk(true)} className="mb-3 w-full">{t('account.cancel')}</Button>
            )
          ) : (
            <Button variant="primary" onClick={() => { close(); setPricing(true); }} className="mb-3 w-full">{t('account.upgrade')}</Button>
          )
        )}
        <Note msg={msg} at="plan" />

        {user.premium && (
          <Button onClick={() => { close(); setPrefs(true); }} className="mb-4 w-full" icon={<SlidersHorizontal size={16} aria-hidden="true" />}>
            {t('account.prefs')}
          </Button>
        )}

        {/* Change password */}
        <form onSubmit={changePassword} className="space-y-2 border-t border-line pt-4">
          <h3 className="m-0 flex items-center gap-1.5 text-libelle font-semibold text-ink"><KeyRound size={14} aria-hidden="true" /> {t('account.password')}</h3>
          <input type="password" required autoComplete="current-password" placeholder={t('account.currentPw')} aria-label={t('account.currentPw')} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className="input w-full" />
          <input type="password" required minLength={6} autoComplete="new-password" placeholder={t('pages.account.newPw')} aria-label={t('pages.account.newPw')} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className="input w-full" />
          <p className="meta m-0">{t('pages.account.pwHint')}</p>
          <Button type="submit" disabled={!!busy} className="w-full">
            {busy === 'pw' && <Spinner className="h-4 w-4" />}
            {t('pages.account.changePw')}
          </Button>
          <Note msg={msg} at="pw" />
        </form>

        {/* My data (GDPR) */}
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          <h3 className="m-0 text-libelle font-semibold text-ink">{t('pages.account.dataTitle')}</h3>
          <Button onClick={exportData} disabled={!!busy} className="w-full" icon={busy === 'export' ? <Spinner className="h-4 w-4" /> : <Download size={16} aria-hidden="true" />}>
            {t('pages.account.export')}
          </Button>
          <Button variant="quiet" onClick={() => { logout(); close(); }} className="w-full" icon={<LogOut size={16} aria-hidden="true" />}>
            {t('account.logout')}
          </Button>
          {delOpen ? (
            <form onSubmit={deleteAccount} className="space-y-2 rounded-field border border-[var(--red)] p-3">
              <p className="m-0 text-sous text-ink">{t('pages.account.deleteWarn')}</p>
              <input type="password" required autoComplete="current-password" placeholder={t('account.currentPw')} aria-label={t('account.currentPw')} value={delPw} onChange={(e) => setDelPw(e.target.value)} className="input w-full" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="danger" disabled={!!busy}>
                  {busy === 'delete' && <Spinner className="h-4 w-4" />}
                  {t('account.deleteConfirm')}
                </Button>
                <Button variant="quiet" onClick={() => setDelOpen(false)}>{t('pages.account.keepAccount')}</Button>
              </div>
            </form>
          ) : (
            <Button variant="quiet" onClick={() => setDelOpen(true)} className="w-full text-red">{t('account.delete')}</Button>
          )}
          <Note msg={msg} at="data" />
        </div>
      </div>
    </div>
  );
}

function Note({ msg, at }: { msg: Msg | null; at: Section }) {
  if (!msg || msg.at !== at) return null;
  return (
    <p role={msg.kind === 'err' ? 'alert' : 'status'} className={msg.kind === 'ok' ? 'mb-3 mt-2 text-sous text-mint' : 'mb-3 mt-2 text-sous text-red'}>
      {msg.text}
    </p>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-2">{label}</dt>
      <dd className="m-0 text-right text-ink">{children}</dd>
    </div>
  );
}
