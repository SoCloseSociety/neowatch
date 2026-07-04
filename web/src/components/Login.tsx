import { useState, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import QRCode from 'qrcode';
import { X, Radio, Loader2, Mail, Lock, User as UserIcon, Eye, EyeOff, Crown, Smartphone } from 'lucide-react';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { User } from '@/types';
import { useEscapeClose } from './ui';

export function Login() {
  const open = useUI((s) => s.loginOpen);
  const setOpen = useUI((s) => s.setLogin);
  const { login, register, loginWithToken, error, config } = useAuth();
  const t = useT();
  const [mode, setMode] = useState<'login' | 'register' | 'qr'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  useEscapeClose(open, () => setOpen(false));

  if (!open) return null;
  const canRegister = config?.allowRegister !== false;
  const isLogin = mode === 'login';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (isLogin) await login(email, password);
      else await register(email, password, name);
      setOpen(false);
    } catch {
      /* error shown via store */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label={t('login.title')}
    >
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-panel shadow-2xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent glow header */}
        <div className="relative overflow-hidden px-6 pb-5 pt-7 text-center">
          <div className="pointer-events-none absolute -top-16 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full bg-accent/25 blur-3xl" />
          <button
            onClick={() => setOpen(false)}
            className="absolute right-3 top-3 rounded-lg p-1.5 text-ink/40 transition-colors hover:bg-white/5 hover:text-ink"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
          <div className="relative mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent ring-1 ring-accent/30">
            <Radio size={22} />
          </div>
          <h2 className="relative font-mono text-lg font-bold tracking-widest text-ink">
            NEO<span className="text-accent">WATCH</span>
          </h2>
          <p className="relative mt-1 text-[12px] text-ink/50">
            {isLogin ? t('login.welcomeBack') : t('login.welcomeNew')}
          </p>
        </div>

        <div className="px-6 pb-6">
          {mode === 'qr' ? (
            <QrLogin onApproved={(tk, u) => { loginWithToken(tk, u); setOpen(false); }} onBack={() => setMode('login')} />
          ) : (
          <>
          {/* Tabs */}
          {canRegister && (
            <div className="relative mb-5 grid grid-cols-2 rounded-xl bg-black/30 p-1">
              <span
                className={clsx(
                  'absolute inset-y-1 w-[calc(50%-0.25rem)] rounded-lg bg-accent/15 ring-1 ring-accent/30 transition-transform duration-200',
                  isLogin ? 'translate-x-0' : 'translate-x-[calc(100%+0.5rem)]'
                )}
              />
              {(['login', 'register'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={clsx(
                    'relative z-10 rounded-lg py-2 text-xs font-semibold transition-colors',
                    mode === m ? 'text-accent' : 'text-ink/50 hover:text-ink'
                  )}
                >
                  {m === 'login' ? t('login.tabLogin') : t('login.tabRegister')}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={submit} className="space-y-3">
            {!isLogin && (
              <Field icon={<UserIcon size={15} />}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('login.name')} className="field-input" autoComplete="name" />
              </Field>
            )}
            <Field icon={<Mail size={15} />}>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('login.email')} className="field-input" autoComplete="email" />
            </Field>
            <Field icon={<Lock size={15} />}>
              <input
                type={showPw ? 'text' : 'password'}
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.password')}
                className="field-input pr-9"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink/40 hover:text-ink"
                aria-label={showPw ? t('login.hidePw') : t('login.showPw')}
                tabIndex={-1}
              >
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </Field>

            {error && (
              <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 animate-fade-in">{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-bold text-black shadow-lg shadow-accent/20 transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {isLogin ? t('login.signIn') : t('login.create')}
            </button>
          </form>

          {/* QR / phone login -- ideal on a TV (no typing with the remote). */}
          <button
            onClick={() => setMode('qr')}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/20 py-2.5 text-xs font-semibold text-ink/70 transition-colors hover:border-accent/30 hover:text-ink"
          >
            <Smartphone size={14} /> {t('qr.connectPhone')}
          </button>

          <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px] text-ink/40">
            {isLogin ? (
              canRegister && (
                <>
                  {t('login.noAccount')}
                  <button onClick={() => setMode('register')} className="font-semibold text-accent hover:underline">
                    {t('login.register')}
                  </button>
                </>
              )
            ) : (
              <>
                <Crown size={12} className="text-amber-400" /> {t('login.tagline')}
              </>
            )}
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

// TV side of QR pairing: request a code, show the QR + short code, poll until the
// phone approves, then hand the token up to be stored.
function QrLogin({ onApproved, onBack }: { onApproved: (token: string, user: User) => void; onBack: () => void }) {
  const t = useT();
  const [userCode, setUserCode] = useState('');
  const [qr, setQr] = useState('');
  const [status, setStatus] = useState<'loading' | 'waiting' | 'expired'>('loading');
  const deviceRef = useRef<string | null>(null);

  const start = async () => {
    setStatus('loading');
    try {
      const r = await api.post<{ deviceCode: string; userCode: string }>('/auth/device/start', {});
      deviceRef.current = r.deviceCode;
      setUserCode(r.userCode);
      const url = `${location.origin}/link?code=${r.userCode}`;
      QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#0a0e14', light: '#ffffff' } }).then(setQr).catch(() => setQr(''));
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
        if (r.status === 'approved' && r.token && r.user) { clearInterval(id); onApproved(r.token, r.user); }
        else if (r.status === 'expired') { clearInterval(id); setStatus('expired'); }
      } catch { /* transient */ }
    }, 3000);
    return () => clearInterval(id);
  }, [status, onApproved]);

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <h3 className="text-sm font-semibold text-ink">{t('qr.title')}</h3>
      <p className="max-w-[260px] text-[12px] text-ink/60">{t('qr.scan')}</p>
      <div className="grid h-44 w-44 place-items-center rounded-2xl bg-white p-3">
        {status === 'loading' ? <Loader2 className="animate-spin text-black/40" size={28} />
          : status === 'expired' ? <span className="text-xs text-black/50">{t('qr.expired')}</span>
          : qr ? <img src={qr} alt="QR" className="h-full w-full" /> : <Loader2 className="animate-spin text-black/40" size={28} />}
      </div>
      {status === 'waiting' && (
        <>
          <p className="text-[11px] text-ink/50">{t('qr.orCode')}</p>
          <div className="font-mono text-2xl font-bold tracking-[0.3em] text-accent">{userCode}</div>
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-ink/40"><Loader2 size={11} className="animate-spin" /> {t('qr.waiting')}</p>
        </>
      )}
      <div className="mt-1 flex gap-2">
        {status === 'expired' && (
          <button onClick={start} className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-black hover:opacity-90">{t('qr.retry')}</button>
        )}
        <button onClick={onBack} className="rounded-lg border border-white/10 px-4 py-2 text-xs font-semibold text-ink/70 hover:text-ink">{t('qr.back')}</button>
      </div>
    </div>
  );
}

function Field({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-3 text-ink/40">{icon}</span>
      {children}
    </div>
  );
}
