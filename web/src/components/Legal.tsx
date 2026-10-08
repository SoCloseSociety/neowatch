import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useT, fmtDate } from '@/lib/i18n';
import { useAuth } from '@/store/authStore';
import { useUI } from '@/store/uiStore';
import { Overline, btnClass } from './ui';

/** Legal and takedown contact (also used by "Report this channel"). */
export const LEGAL_CONTACT = 'sin.soclose@gmail.com';
/** Publisher named in the legal notice. */
const PUBLISHER = 'SoClose';
const UPDATED = new Date(2026, 9, 8);

interface Section { id: string; title: string; paras: string[] }

// Terms of use + legal notice + privacy policy on one page, with anchors
// (#cgu, #mentions, #confidentialite). Every sentence is in lib/i18n/pages.ts
// (EN, FR, RU). The ads statement matches the app: ads only for free users, only
// on Movies and Radio, only after consent.
const TERMS: Section[] = [
  { id: 'service', title: 'pages.legal.s1', paras: ['pages.legal.s1a', 'pages.legal.s1b', 'pages.legal.s1c'] },
  { id: 'content', title: 'pages.legal.s2', paras: ['pages.legal.s2a', 'pages.legal.s2b', 'pages.legal.s2c'] },
  { id: 'use', title: 'pages.legal.s3', paras: ['pages.legal.s3a'] },
  { id: 'premium', title: 'pages.legal.s4', paras: ['pages.legal.s4a', 'pages.legal.s4b'] },
  { id: 'warranty', title: 'pages.legal.s5', paras: ['pages.legal.s5a'] },
];
const PRIVACY: Section[] = [
  { id: 'data', title: 'pages.legal.p1', paras: ['pages.legal.p1a', 'pages.legal.p1b'] },
  { id: 'device', title: 'pages.legal.p2', paras: ['pages.legal.p2a'] },
  { id: 'ads', title: 'pages.legal.p3', paras: ['pages.legal.p3a', 'pages.legal.p3b'] },
  { id: 'logs', title: 'pages.legal.p4', paras: ['pages.legal.p4a'] },
  { id: 'rights', title: 'pages.legal.p5', paras: ['pages.legal.p5a', 'pages.legal.p5b', 'pages.legal.p5c'] },
  { id: 'playback', title: 'pages.legal.p6', paras: ['pages.legal.p6a'] },
];

export function Legal() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const t = useT();
  const user = useAuth((s) => s.user);
  const setAccount = useUI((s) => s.setAccount);
  const setLogin = useUI((s) => s.setLogin);

  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };
  const updated = t('pages.legal.updated', { date: fmtDate(UPDATED, { month: 'long', year: 'numeric' }) });
  const mail = <a href={`mailto:${LEGAL_CONTACT}`} className="font-mono text-ink underline underline-offset-2" translate="no">{LEGAL_CONTACT}</a>;

  const renderSections = (list: Section[]) =>
    list.map((s) => (
      <section key={s.id} aria-labelledby={`legal-${s.id}`} className="mt-7">
        <h3 id={`legal-${s.id}`} className="m-0 mb-2 text-carte font-semibold text-ink">{t(s.title)}</h3>
        {s.paras.map((p) => <p key={p} className="m-0 mb-2 text-corps text-ink-2">{t(p)}</p>)}
        {s.id === 'rights' && <p className="m-0 mb-2 text-corps text-ink-2">{t('pages.legal.p5d')} {mail}</p>}
      </section>
    ));

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-[var(--gouttiere)] pb-16 pt-6">
        <button type="button" onClick={back} className={btnClass('quiet', { className: 'mb-6 px-3' })} aria-label={t('detail.back')}>
          <ArrowLeft size={16} aria-hidden="true" /> {t('detail.back')}
        </button>

        <section id="cgu" className="scroll-mt-6">
          <Overline>{t('footer.legal')}</Overline>
          <h2 className="m-0 mt-1 text-titre font-semibold text-ink">{t('pages.legal.termsTitle')}</h2>
          <p className="meta m-0 mt-2">{updated}</p>
          {renderSections(TERMS)}
        </section>

        <section id="mentions" className="mt-12 scroll-mt-6" aria-labelledby="legal-notice">
          <h2 id="legal-notice" className="m-0 text-titre2 font-semibold text-ink">{t('pages.legal.noticeTitle')}</h2>
          <dl className="m-0 mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-corps">
            <dt className="text-ink-3">{t('pages.legal.publisher')}</dt>
            <dd className="m-0 text-ink" translate="no">{PUBLISHER} · NEOWATCH</dd>
            <dt className="text-ink-3">{t('pages.legal.contact')}</dt>
            <dd className="m-0">{mail}</dd>
            <dt className="text-ink-3">{t('pages.legal.host')}</dt>
            <dd className="m-0 text-ink-2">{t('pages.legal.hostValue')}</dd>
          </dl>
        </section>

        <section id="retrait" className="mt-12 scroll-mt-6 rounded-card border border-line bg-card p-[var(--pad-panneau)]" aria-labelledby="legal-takedown">
          <h2 id="legal-takedown" className="m-0 text-titre2 font-semibold text-ink">{t('pages.legal.takedownTitle')}</h2>
          <p className="m-0 mt-3 text-corps text-ink-2">{t('pages.legal.takedownA')}</p>
          <p className="m-0 mt-2 text-corps text-ink-2">{t('pages.legal.takedownB')}</p>
          <p className="m-0 mt-3 text-corps">{mail}</p>
        </section>

        <section id="confidentialite" className="mt-12 scroll-mt-6">
          <h2 className="m-0 text-titre font-semibold text-ink">{t('pages.legal.privacyTitle')}</h2>
          <p className="meta m-0 mt-2">{updated}</p>
          {renderSections(PRIVACY)}
          <button
            type="button"
            onClick={() => (user ? setAccount(true) : setLogin(true))}
            className={btnClass('secondary', { className: 'mt-5' })}
          >
            {user ? t('pages.legal.openAccount') : t('link.signin')}
          </button>
        </section>
      </div>
    </main>
  );
}
