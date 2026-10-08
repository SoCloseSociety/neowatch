import { useEffect, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, Tv, Monitor, Copy } from 'lucide-react';
import { useUI, toast } from '@/store/uiStore';
import { useAuth } from '@/store/authStore';
import type { RuntimeConfig } from '@/types';
import { useEscapeClose } from './ui';
import { useT } from '@/lib/i18n';

// Install (spec 4.6): the web app first (PWA: one button where the browser
// allows it, "Share, then Add to Home Screen" on iPhone), a QR to open the
// site on a phone or a TV browser. The old TWA package is never offered. The
// Android TV shell (user agent "NeoWatchTV") IS the app: there, install is hidden.

/** Inside the NEOWATCH Android shell (WebView, UA suffix "NeoWatchTV/x"). */
export function insideTvShell(): boolean {
  return typeof navigator !== 'undefined' && /NeoWatchTV/i.test(navigator.userAgent || '');
}

/** Already running as an installed app (home-screen PWA). */
export function runningInstalled(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

const isIOS = () => typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent || '');

// The beforeinstallprompt event may fire before React mounts: keep it here.
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
let deferredPrompt: InstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    window.dispatchEvent(new Event('neowatch:installable'));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.dispatchEvent(new Event('neowatch:installed'));
  });
}

/** The browser offers its own install prompt right now. */
export function useCanInstall(): boolean {
  const [can, setCan] = useState(() => !!deferredPrompt);
  useEffect(() => {
    const on = () => setCan(true);
    const off = () => setCan(false);
    window.addEventListener('neowatch:installable', on);
    window.addEventListener('neowatch:installed', off);
    return () => {
      window.removeEventListener('neowatch:installable', on);
      window.removeEventListener('neowatch:installed', off);
    };
  }, []);
  return can;
}

/** Show the browser's install prompt; true when the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferredPrompt;
  if (!ev) return false;
  deferredPrompt = null;
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    return choice.outcome === 'accepted';
  } catch {
    return false;
  } finally {
    window.dispatchEvent(new Event('neowatch:installed'));
  }
}

export function Install() {
  const t = useT();
  const open = useUI((s) => s.installOpen);
  const setOpen = useUI((s) => s.setInstall);
  const config = useAuth((s) => s.config) as (RuntimeConfig & { androidApk?: string }) | null;
  const canInstall = useCanInstall();
  useEscapeClose(open, () => setOpen(false));
  const [qr, setQr] = useState('');
  const url = typeof window !== 'undefined' ? window.location.origin : 'https://neowatch.soclose.co';
  const shell = insideTvShell();

  useEffect(() => {
    if (!open || shell) return;
    QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#05070a', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(''));
  }, [open, url, shell]);

  // The shell is the app: never offer to install it (or anything else) inside it.
  useEffect(() => {
    if (open && shell) setOpen(false);
  }, [open, shell, setOpen]);

  if (!open || shell) return null;

  const copy = () => {
    navigator.clipboard?.writeText(url).then(
      () => toast(t('toast.copied'), { ok: true }),
      () => { /* clipboard refused: the address stays visible */ }
    );
  };
  const install = async () => {
    if (await promptInstall()) {
      toast(t('shell.installed'), { ok: true });
      setOpen(false);
    }
  };
  // Only when the server publishes a current Android TV package (not the old TWA).
  const apk = typeof config?.androidApk === 'string' && /^\/[\w./-]+\.apk$/.test(config.androidApk) ? config.androidApk : null;
  const host = url.replace(/^https?:\/\//, '');

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-[var(--scrim-panneau)] p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nw-install-title"
        className="max-h-[calc(100vh-32px)] w-full max-w-[460px] overflow-y-auto rounded-card border border-line-strong bg-[var(--bg-1)] shadow-panel animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2 id="nw-install-title" className="text-carte font-semibold text-ink">
            {t('install.title')}
          </h2>
          <button type="button" onClick={() => setOpen(false)} aria-label={t('common.close')} title={t('common.close')} className="btn btn-quiet btn-icon ml-auto">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-col gap-5 p-5">
          {runningInstalled() ? (
            <p className="text-sous text-ink-2">{t('shell.alreadyInstalled')}</p>
          ) : canInstall ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sous text-ink-2">{t('shell.installHere')}</p>
              <button type="button" data-autofocus="" onClick={install} className="btn btn-primary">
                {t('shell.installNow')}
              </button>
            </div>
          ) : isIOS() ? (
            <p className="text-sous text-ink-2">{t('install.ios')}</p>
          ) : null}

          <div className="flex items-center gap-4">
            <div className="shrink-0 rounded-field bg-white p-2">
              {qr ? <img src={qr} alt={t('shell.qrAlt')} className="h-32 w-32" /> : <div className="h-32 w-32" aria-hidden="true" />}
            </div>
            <div className="min-w-0 space-y-2">
              <p className="text-sous text-ink-2">{t('shell.scanToOpen')}</p>
              <button type="button" onClick={copy} className="btn btn-secondary max-w-full" aria-label={t('shell.copyLink')} title={t('shell.copyLink')}>
                <Copy size={16} aria-hidden="true" />
                <span translate="no" className="truncate font-mono">
                  {host}
                </span>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Step icon={<Smartphone size={18} />} title={t('install.phone')}>
              {isIOS() ? t('install.ios') : t('install.phoneBody')}
            </Step>
            <Step icon={<Tv size={18} />} title={t('install.tv')}>
              {t('install.tvBody')}
              {apk && (
                <>
                  {' '}
                  <a href={apk} className="text-ink underline underline-offset-2">
                    {t('shell.getTvApp')}
                  </a>
                </>
              )}
            </Step>
            <Step icon={<Monitor size={18} />} title={t('install.pc')}>
              {t('install.pcBody')}
            </Step>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-field border border-line bg-[var(--bg-2)] p-3">
      <span className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sous font-semibold text-ink">{title}</p>
        <p className="text-sous text-ink-2">{children}</p>
      </div>
    </div>
  );
}
