import { clsx } from 'clsx';
import { useEffect, type ReactNode } from 'react';
import type { HealthStatus } from '@/types';

// Close a modal on Escape (call before any early return to satisfy hook rules).
export function useEscapeClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, onClose]);
}

export function LiveDot({ status }: { status: HealthStatus }) {
  const map: Record<HealthStatus, string> = {
    online: 'bg-emerald-400',
    offline: 'bg-rose-500',
    checking: 'bg-amber-400 animate-pulse',
    unknown: 'bg-slate-500',
  };
  return <span className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', map[status])} />;
}

export function HealthBadge({ status, latency }: { status: HealthStatus; latency?: number }) {
  const label: Record<HealthStatus, string> = {
    online: 'LIVE',
    offline: 'OFF',
    checking: '...',
    unknown: '?',
  };
  const cls: Record<HealthStatus, string> = {
    online: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
    offline: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
    checking: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
    unknown: 'text-slate-400 border-white/10 bg-white/5',
  };
  return (
    <span
      className={clsx(
        'flex items-center gap-1 rounded border px-1 py-0.5 font-mono text-[8px] font-bold tracking-wider',
        cls[status]
      )}
    >
      <LiveDot status={status} />
      {label[status]}
      {status === 'online' && latency ? <span className="opacity-50">{latency}ms</span> : null}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={clsx('h-5 w-5 animate-spin rounded-full border-2 border-accent/30 border-t-accent', className)} />
  );
}

export function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-panel/60">
      <div className="aspect-video animate-shimmer bg-gradient-to-r from-white/[0.02] via-white/[0.06] to-white/[0.02] bg-[length:200%_100%]" />
      <div className="space-y-1.5 p-2">
        <div className="h-2.5 w-3/4 rounded bg-white/[0.06]" />
        <div className="h-2 w-1/2 rounded bg-white/[0.04]" />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <div className="text-ink/30">{icon}</div>
      <p className="font-mono text-sm text-ink/60">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink/40">{hint}</p>}
    </div>
  );
}
