import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X, Smartphone, Tv, MonitorDown, Copy, Check } from 'lucide-react';
import { useUI } from '@/store/uiStore';
import { useEscapeClose } from './ui';
import { useT } from '@/lib/i18n';

// Netflix-style quick install: scan a QR with your phone / TV browser, or open
// the link, then "Add to home screen" (PWA) for a native-like, fast launch.
export function Install() {
  const t = useT();
  const open = useUI((s) => s.installOpen);
  const setOpen = useUI((s) => s.setInstall);
  useEscapeClose(open, () => setOpen(false));
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const url = typeof window !== 'undefined' ? window.location.origin : 'https://neowatch.soclose.co';

  useEffect(() => {
    if (!open) return;
    QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#0a0e14', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(''));
  }, [open, url]);

  if (!open) return null;

  const copy = () => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" onClick={() => setOpen(false)} role="dialog" aria-modal="true">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-panel shadow-2xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/[0.06] p-4">
          <MonitorDown size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-ink">{t('install.title')}</h2>
          <button onClick={() => setOpen(false)} className="ml-auto rounded-lg p-1.5 text-ink/50 hover:bg-white/5"><X size={18} /></button>
        </div>

        <div className="flex flex-col items-center gap-4 p-6">
          <div className="rounded-2xl bg-white p-3">
            {qr ? <img src={qr} alt="QR code NEOWATCH" className="h-44 w-44" /> : <div className="h-44 w-44 animate-pulse rounded bg-black/10" />}
          </div>
          <button onClick={copy} className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-ink/80 hover:border-accent/30">
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />} {url.replace(/^https?:\/\//, '')}
          </button>

          <div className="w-full space-y-2.5 text-sm">
            <Step icon={<Smartphone size={16} />} title={t('install.phone')}>{t('install.phoneBody')}</Step>
            <Step icon={<Tv size={16} />} title={t('install.tv')}>{t('install.tvBody')}</Step>
            <Step icon={<MonitorDown size={16} />} title={t('install.pc')}>{t('install.pcBody')}</Step>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <span className="mt-0.5 shrink-0 text-accent">{icon}</span>
      <p className="text-[12px] leading-relaxed text-ink/70"><b className="text-ink/90">{title}: </b>{children}</p>
    </div>
  );
}
