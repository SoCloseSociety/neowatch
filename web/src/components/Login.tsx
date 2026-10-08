import { useState, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import QRCode from 'qrcode';
import { X, Mail, Lock, User as UserIcon, Eye, EyeOff, Smartphone } from 'lucide-react';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { api } from '@/lib/api';
import { isTV } from '@/lib/device';
import { useT, type TFn } from '@/lib/i18n';
import type { User } from '@/types';
import { Button, Overline, Spinner, useEscapeClose } from './ui';
import { PREMIUM_INTENT_KEY } from './Pricing';

/** Set after a successful sign-in on this device: the next visit says "welcome back". */
const RETURNING_KEY = 'nw.returning';
function isReturning() {
  try { return localStorage.getItem(RETURNING_KEY) === '1'; } catch { return false; }
}
function markReturning() {
  try { localStorage.setItem(RETURNING_KEY, '1'); } catch { /* storage blocked */ }
}
function finePointer() {
  try { return window.matchMedia('(pointer: fine)').matches; } catch { return false; }
}
function premiumIntent() {
  try { return sessionStorage.getItem(PREMIUM_INTENT_KEY) === '1'; } catch { return false; }
}

// Server messages are English developer text: show our own sentence instead.
function errorText(t: TFn, raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.toLowerCase();
  if (m.includes('invalid credentials')) return t('login.wrong');
  if (m.includes('already registered')) return t('pages.login.taken');
  if (m.includes('registration disabled')) return t('pages.login.noRegister');
  if (m.includes('disabled')) return t('pages.login.disabled');
  if (m.includes('password')) return t('pages.login.pwRule');
  if (m.includes('too many')) return t('pages.login.tooMany');
  return t('pages.login.failed');
}

export function Login() {
  const open = useUI((s) => s.loginOpen);
  const setOpen = useUI((s) => s.setLogin);
  const { login, register, loginWithToken, error, config } = useAuth();
  const t = useT();
  const tv = isTV();
  const [mode, setMode] = useState<'login' | 'register' | 'qr'>(tv ? 'qr' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(isReturning);
  const [forPremium, setForPremium] = useState(false);
  const signedIn = useAuth((s) => !!s.user);
  useEscapeClose(open, () => setOpen(false));

  // Signed in from elsewhere while open (the held token resolved, another tab,
  // a phone approving this TV): the dialog has nothing left to do (WEB-10).
  useEffect(() => {
    if (open && signedIn) setOpen(false);
  }, [open, signedIn, setOpen]);

  // Each opening starts on the right step: QR on a TV, email elsewhere.
  useEffect(() => {
    if (!open) return;
    setMode(tv ? 'qr' : 'login');
    setReturning(isReturning());
    setForPremium(premiumIntent());
    setPassword('');
    useAuth.setState({ error: null });
  }, [open, tv]);

  if (!open) return null;
  const canRegister = config?.allowRegister !== false;
  const isLogin = mode === 'login';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isLogin) await login(email, password);
      else await register(email, password, name);
      markReturning();
      setOpen(false);
    } catch {
      /* error shown via store */
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'qr' ? t('login.tvTitle') : mode === 'register' ? t('pages.login.createTitle') : returning ? t('login.welcomeBack') : t('pages.login.title');
  const lead = forPremium ? t('pages.login.forPremium') : mode === 'qr' ? null : mode === 'register' ? t('login.tagline') : returning ? null : t('login.welcomeNew');
  const err = errorText(t, error);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim-panneau)] p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        className="relative w-full max-w-sm overflow-hidden rounded-card border border-line bg-[var(--surface-panneau)] shadow-menu animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-[var(--pad-panneau)] pb-4 pt-6">
          <Button variant="quiet" iconOnly onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('common.close')} className="absolute right-2 top-2" icon={<X size={18} aria-hidden="true" />} />
          <Overline>{t('pill.signIn')}</Overline>
          <h2 id="login-title" className="m-0 mt-1 pr-10 text-titre2 font-semibold text-ink">{title}</h2>
          {lead && <p className="mb-0 mt-1.5 text-sous text-ink-2">{lead}</p>}
        </div>

        <div className="px-[var(--pad-panneau)] pb-[var(--pad-panneau)]">
          {mode === 'qr' ? (
            <QrLogin
              onApproved={(tk, u) => { loginWithToken(tk, u); markReturning(); setOpen(false); }}
              onEmail={() => setMode('login')}
            />
          ) : (
            <>
              {canRegister && (
                <div role="tablist" className="mb-4 grid grid-cols-2 gap-1 rounded-pill border border-line p-1">
                  {(['login', 'register'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={mode === m}
                      onClick={() => { setMode(m); useAuth.setState({ error: null }); }}
                      className={clsx('min-h-[36px] rounded-pill text-sous font-semibold', mode === m ? 'bg-[var(--bg-3)] text-ink' : 'text-ink-2')}
                    >
                      {m === 'login' ? t('login.tabLogin') : t('login.tabRegister')}
                    </button>
                  ))}
                </div>
              )}

              <form onSubmit={submit} className="space-y-3">
                {!isLogin && (
                  <Field icon={<UserIcon size={16} />}>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('login.name')} aria-label={t('login.name')} className="field-input" autoComplete="name" />
                  </Field>
                )}
                <Field icon={<Mail size={16} />}>
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('login.email')} aria-label={t('login.email')} className="field-input" autoComplete="email" autoFocus={!tv && finePointer()} />
                </Field>
                <Field icon={<Lock size={16} />}>
                  <input
                    type={showPw ? 'text' : 'password'}
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('login.password')}
                    aria-label={t('login.password')}
                    className="field-input pr-11"
                    autoComplete={isLogin ? 'current-password' : 'new-password'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-field text-ink-3"
                    aria-label={showPw ? t('login.hidePw') : t('login.showPw')}
                    title={showPw ? t('login.hidePw') : t('login.showPw')}
                  >
                    {showPw ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  </button>
                </Field>

                {err && <p role="alert" className="m-0 rounded-field border border-[var(--red)] px-3 py-2 text-sous text-red">{err}</p>}

                <Button type="submit" variant="primary" disabled={busy} className="w-full">
                  {busy && <Spinner className="h-4 w-4" />}
                  {isLogin ? t('login.signIn') : t('login.create')}
                </Button>
              </form>

              {/* Phone sign-in: no typing with a remote. */}
              <Button variant="quiet" onClick={() => setMode('qr')} className="mt-2 w-full" icon={<Smartphone size={16} aria-hidden="true" />}>
                {t('qr.connectPhone')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// TV side of QR pairing: request a code, show the QR + short code, poll until the
// phone approves, then hand the token up to be stored.
function QrLogin({ onApproved, onEmail }: { onApproved: (token: string, user: User) => void; onEmail: () => void }) {
  const t = useT();
  const [userCode, setUserCode] = useState('');
  const [qr, setQr] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [status, setStatus] = useState<'loading' | 'waiting' | 'expired'>('loading');
  const deviceRef = useRef<string | null>(null);
  const approvedRef = useRef(onApproved);
  approvedRef.current = onApproved;

  const start = async () => {
    setStatus('loading');
    try {
      const r = await api.post<{ deviceCode: string; userCode: string; expiresIn?: number }>('/auth/device/start', {});
      deviceRef.current = r.deviceCode;
      setUserCode(r.userCode);
      setMinutes(Math.max(1, Math.round((r.expiresIn || 600) / 60)));
      // `t` = when the TV showed the code: the phone shows its age before confirming.
      const url = `${location.origin}/link?code=${r.userCode}&t=${Date.now()}`;
      QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#05070a', light: '#ffffff' } }).then(setQr).catch(() => setQr(''));
      setStatus('waiting');
    } catch {
      setStatus('expired');
    }
  };

  useEffect(() => { start(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => {
    if (status !== 'waiting') return;
    const id = setInterval(async () => {
      const deviceCode = deviceRef.current;
      if (!deviceCode) return;
      try {
        const r = await api.post<{ status: string; token?: string; user?: User }>('/auth/device/poll', { deviceCode });
        if (r.status === 'approved' && r.token && r.user) { clearInterval(id); approvedRef.current(r.token, r.user); }
        else if (r.status === 'expired') { clearInterval(id); setStatus('expired'); }
      } catch { /* transient */ }
    }, 3000);
    return () => clearInterval(id);
  }, [status]);

  const host = location.host;

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="m-0 max-w-[280px] text-sous text-ink-2">{t('pages.login.qrHow')}</p>
      <div className="grid h-48 w-48 place-items-center rounded-card bg-[#ffffff] p-3">
        {status === 'waiting' && qr ? (
          <img src={qr} alt={t('qr.title')} className="h-full w-full" />
        ) : status === 'expired' ? (
          <span className="text-sous text-[#27221d]">{t('qr.expired')}</span>
        ) : (
          <Spinner />
        )}
      </div>
      {status === 'waiting' && (
        <>
          <p className="m-0 text-sous text-ink-2">{t('login.orOpen', { url: `${host}/link` })}</p>
          <p className="m-0 font-mono text-titre2 font-semibold tracking-[0.3em] text-ink" translate="no">{userCode}</p>
          <p className="meta m-0">{t('login.waitingPhone', { n: minutes })}</p>
        </>
      )}
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {status === 'expired' && <Button variant="primary" onClick={start}>{t('qr.retry')}</Button>}
        <Button variant="quiet" onClick={onEmail} autoFocus={isTV()} icon={<Mail size={16} aria-hidden="true" />}>{t('login.useEmail')}</Button>
      </div>
    </div>
  );
}

function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-3 text-ink-3" aria-hidden="true">{icon}</span>
      {children}
    </div>
  );
}
