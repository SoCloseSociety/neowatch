import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Tv, Check, Loader2, LogIn, AlertCircle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { useT } from '@/lib/i18n';

// Phone-side of QR pairing: opened by scanning the TV's QR (/link?code=XXXXXX).
// If signed in, the user confirms and the TV gets logged in to this account.
export function LinkDevice() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const user = useAuth((s) => s.user);
  const ready = useAuth((s) => s.ready);
  const setLogin = useUI((s) => s.setLogin);
  const code = (params.get('code') || '').toUpperCase().trim();
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'invalid'>('idle');
  const [valid, setValid] = useState<boolean | null>(null);

  useEffect(() => {
    if (!code) { setValid(false); return; }
    api.get<{ valid: boolean }>(`/auth/device/info?code=${encodeURIComponent(code)}`)
      .then((r) => setValid(r.valid))
      .catch(() => setValid(false));
  }, [code]);

  const approve = async () => {
    setState('sending');
    try {
      await api.post('/auth/device/approve', { code });
      setState('done');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 401 ? 'idle' : 'invalid');
    }
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-panel p-7 text-center shadow-2xl">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent/15 text-accent ring-1 ring-accent/30"><Tv size={26} /></div>
        <h1 className="m-0 text-lg font-bold text-ink">{t('link.title')}</h1>
        {children}
      </div>
    </main>
  );

  if (!ready) return <Shell><Loader2 className="mx-auto mt-5 animate-spin text-accent" size={26} /></Shell>;
  if (!code || valid === false) return (
    <Shell><p className="mt-3 flex items-center justify-center gap-2 text-sm text-ink/60"><AlertCircle size={16} /> {code ? t('link.invalid') : t('link.noCode')}</p>
      <button onClick={() => navigate('/')} className="mt-5 rounded-xl border border-white/10 px-4 py-2 text-sm text-ink/70 hover:text-ink">NEOWATCH</button></Shell>
  );
  if (state === 'done') return (
    <Shell><p className="mt-3 flex items-center justify-center gap-2 text-sm font-semibold text-emerald-400"><Check size={18} /> {t('link.done')}</p></Shell>
  );
  if (!user) return (
    <Shell>
      <p className="mt-3 text-sm text-ink/60">{t('link.needLogin')}</p>
      <button onClick={() => setLogin(true)} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-bold text-black hover:opacity-90"><LogIn size={16} /> {t('link.signin')}</button>
    </Shell>
  );
  return (
    <Shell>
      <p className="mt-3 text-sm text-ink/70">{t('link.prompt')}</p>
      <div className="my-4 font-mono text-2xl font-bold tracking-[0.3em] text-accent">{code}</div>
      <button onClick={approve} disabled={state === 'sending'} className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-bold text-black hover:opacity-90 disabled:opacity-50">
        {state === 'sending' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {t('link.confirm')}
      </button>
      {state === 'invalid' && <p className="mt-3 text-xs text-rose-300">{t('link.invalid')}</p>}
    </Shell>
  );
}
