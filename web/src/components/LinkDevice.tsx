import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Tv, Check, LogIn, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { useT, fmtAge } from '@/lib/i18n';
import { Button, EmptyState, Overline, Pill, Spinner } from './ui';

const CODE_TTL_MS = 10 * 60 * 1000;

// Phone side of QR pairing: opened by scanning the TV's QR (/link?code=XXXXXX&t=<ms>).
// Approving gives the TV that shows this code a session on THIS account, so the page
// says it plainly and asks twice (SEC-2): a link received from someone else would sign
// THEIR TV in to your account. `t` (set by our TV) shows how old the code is.
export function LinkDevice() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const user = useAuth((s) => s.user);
  const ready = useAuth((s) => s.ready);
  const setLogin = useUI((s) => s.setLogin);
  const code = (params.get('code') || '').toUpperCase().trim();
  const shownAt = Number(params.get('t')) || 0;
  const [step, setStep] = useState<'review' | 'confirm' | 'sending' | 'done' | 'invalid'>('review');
  const [valid, setValid] = useState<boolean | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!code) { setValid(false); return; }
    api.get<{ valid: boolean }>(`/auth/device/info?code=${encodeURIComponent(code)}`)
      .then((r) => setValid(r.valid))
      .catch(() => setValid(false));
  }, [code]);

  // Keep the code age current while the page is open.
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(iv);
  }, []);

  const approve = async () => {
    setStep('sending');
    try {
      await api.post('/auth/device/approve', { code });
      setStep('done');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setStep('review'); setLogin(true); }
      else setStep('invalid');
    }
  };

  // A plausible timestamp from our own QR (not in the future, not older than the code).
  const age = shownAt && shownAt <= Date.now() + 60_000 && Date.now() - shownAt < CODE_TTL_MS * 2 ? Date.now() - shownAt : null;
  const old = age !== null && age > CODE_TTL_MS / 2;

  const shell = (children: React.ReactNode) => (
    <main className="flex flex-1 items-center justify-center overflow-y-auto p-4">
      <section aria-labelledby="link-title" className="w-full max-w-md rounded-card border border-line bg-[var(--surface-panneau)] p-[var(--pad-panneau)] shadow-menu">
        <div className="mb-3 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-field border border-line bg-[var(--bg-2)] text-ink-2" aria-hidden="true"><Tv size={22} /></span>
          <div>
            <Overline>{t('pages.link.overline')}</Overline>
            <h1 id="link-title" className="m-0 text-titre2 font-semibold text-ink">{t('link.title')}</h1>
          </div>
        </div>
        {children}
      </section>
    </main>
  );

  if (!ready || (code && valid === null)) return shell(<div className="flex justify-center py-6"><Spinner /></div>);

  if (!code || valid === false || step === 'invalid') {
    return shell(
      <EmptyState
        className="py-6"
        icon={<AlertTriangle size={28} />}
        title={code ? t('link.invalid') : t('link.noCode')}
        body={t('pages.link.invalidBody')}
        action={{ label: t('empty.backToChannels'), onClick: () => navigate('/'), variant: 'primary' }}
      />
    );
  }

  if (step === 'done') {
    return shell(
      <div className="flex flex-col items-start gap-3">
        <Pill tone="ok">{t('pages.link.donePill')}</Pill>
        <p className="m-0 text-corps text-ink">{t('link.connected')}</p>
        <p className="m-0 text-sous text-ink-2">{t('pages.link.doneHint')}</p>
        <Button onClick={() => navigate('/')}>{t('empty.backToChannels')}</Button>
      </div>
    );
  }

  if (!user) {
    return shell(
      <div className="flex flex-col gap-4">
        <p className="m-0 text-corps text-ink-2">{t('link.needLogin')}</p>
        <Button variant="primary" onClick={() => setLogin(true)} icon={<LogIn size={16} aria-hidden="true" />} className="w-full">
          {t('link.signin')}
        </Button>
      </div>
    );
  }

  return shell(
    <div className="flex flex-col gap-4">
      <p className="m-0 text-corps text-ink-2">{t('pages.link.prompt', { email: user.email })}</p>
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-field border border-line bg-[var(--bg-2)] px-4 py-3">
        <span className="font-mono text-titre2 font-semibold tracking-[0.3em] text-ink" translate="no">{code}</span>
        <span className="meta">{age !== null ? t('pages.link.shown', { age: fmtAge(Date.now() - age) }) : t('pages.link.ageUnknown')}</span>
      </div>
      <div role="note" className="flex gap-2.5 rounded-field border border-[var(--amber)] px-3 py-2.5">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
        <div className="text-sous text-ink">
          <p className="m-0">{t('pages.link.warn1')}</p>
          <p className="m-0 mt-1 text-ink-2">{old ? t('pages.link.warnOld') : t('pages.link.warn2')}</p>
        </div>
      </div>
      {step === 'review' ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setStep('confirm')} className="flex-1">{t('pages.link.continue')}</Button>
          <Button variant="quiet" onClick={() => navigate('/')}>{t('pages.link.notMine')}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-sous font-semibold text-ink">{t('pages.link.sure')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={approve} disabled={step === 'sending'} className="flex-1" icon={step === 'sending' ? <Spinner className="h-4 w-4" /> : <Check size={16} aria-hidden="true" />}>
              {t('link.connectTv')}
            </Button>
            <Button variant="quiet" onClick={() => setStep('review')} disabled={step === 'sending'}>{t('pages.link.cancel')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
