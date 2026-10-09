import { clsx } from 'clsx';
import { useEffect, useState, type ButtonHTMLAttributes, type ImgHTMLAttributes, type ReactNode } from 'react';
import type { HealthStatus } from '@/types';
import { useT } from '@/lib/i18n';
import { imgSrc, type ImgW } from '@/lib/img';
import { useUI } from '@/store/uiStore';

// Design primitives (Sentinel TV OS, DESIGN-SPEC sections 1.2 and 2.9-2.11).
// They draw with the classes of index.css (.btn, .pill, .overline, .meta,
// .toast). Data (channel names, countries, programme titles) is marked
// translate="no" so the browser never translates it and the verifier knows it
// is not UI copy.

/** A third-party logo through the image relay (lib/img.ts); `fallback` when there is
 *  none or it fails to load (404, refused, not an image). */
/** `w`: the relay rendition (imgSrc), separate from the displayed `width`. */
export function LogoImg({ src, fallback, w, ...rest }: { src: string | null | undefined; fallback: ReactNode; w?: ImgW } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'>) {
  const url = imgSrc(src, w);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <>{fallback}</>;
  return <img alt="" decoding="async" referrerPolicy="no-referrer" {...rest} src={url} onError={() => setFailed(url)} />;
}

/** A hero's category artwork (public/ambiance/<name>.webp, 1920 px, plus a 960 px
 *  copy for phones). It is the page's largest paint, so it is a real <img> in the
 *  document, fetched first, not a CSS background set from script (PERF-4).
 *  Decorative: no alt, hidden from assistive tech, never focusable. */
export function AmbianceImg({ name, sizes, className }: { name: string; sizes: string; className?: string }) {
  return (
    <img
      src={`/ambiance/${name}.webp`}
      srcSet={`/ambiance/${name}-960.webp 960w, /ambiance/${name}.webp 1920w`}
      sizes={sizes}
      alt=""
      aria-hidden="true"
      decoding="async"
      draggable={false}
      // React 18 does not know fetchPriority: the lowercase attribute reaches the DOM as is.
      {...{ fetchpriority: 'high' }}
      className={clsx('pointer-events-none h-full w-full select-none object-cover object-center', className)}
    />
  );
}

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

// ── Button ─────────────────────────────────────────────────────────────
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

/** Class string for a button-looking element (use it on a <Link> or <a>). */
const BTN: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  quiet: 'btn-quiet',
  danger: 'btn-danger',
};
export function btnClass(variant: ButtonVariant = 'secondary', opts: { icon?: boolean; className?: string } = {}) {
  return clsx('btn', BTN[variant], opts.icon && 'btn-icon', opts.className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** ONE `primary` per screen (bone pill). Default `secondary`. */
  variant?: ButtonVariant;
  /** Leading glyph (lucide icon). */
  icon?: ReactNode;
  /** Icon-only square button: pass `aria-label`. */
  iconOnly?: boolean;
}

export function Button({ variant = 'secondary', icon, iconOnly, className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={btnClass(variant, { icon: iconOnly, className })} {...rest}>
      {icon}
      {!iconOnly && children}
    </button>
  );
}

// ── Pills, overline, meta, data ────────────────────────────────────────
export type PillTone = 'neutral' | 'live' | 'ok' | 'att' | 'alert';

export interface PillProps {
  tone?: PillTone;
  /** Only the hero LIVE point pulses (opacity, two steps). */
  pulse?: boolean;
  /** The text is data (not UI copy). */
  data?: boolean;
  className?: string;
  children: ReactNode;
}

const PILL: Record<PillTone, string> = { neutral: '', live: 'pill-live', ok: 'pill-ok', att: 'pill-att', alert: 'pill-alert' };

/** Mono caps label. Tones: live (red point), ok (mint check), att (amber triangle), alert (red dot). */
export function Pill({ tone = 'neutral', pulse, data, className, children }: PillProps) {
  return (
    <span
      className={clsx('pill', PILL[tone], pulse && 'pill-pulse', className)}
      translate={data ? 'no' : undefined}
    >
      {children}
    </span>
  );
}

/** "LIVE" pill with the red point. */
export function LivePill({ pulse, className }: { pulse?: boolean; className?: string }) {
  const t = useT();
  return (
    <Pill tone="live" pulse={pulse} className={className}>
      {t('pill.live')}
    </Pill>
  );
}

/** Stream state as a corner pill: glyph + word, never colour alone (spec 2.4). */
export function HealthPill({ status, geo, className }: { status: HealthStatus; geo?: boolean; className?: string }) {
  const t = useT();
  if (status === 'online' && !geo) return <LivePill className={className} />;
  if (geo && status !== 'offline') {
    return (
      <Pill tone="att" className={className}>
        {t('pill.blocked')}
      </Pill>
    );
  }
  if (status === 'checking') {
    return (
      <Pill className={className}>
        <span aria-hidden="true">…</span>
        {t('pill.checking')}
      </Pill>
    );
  }
  if (status === 'offline') {
    return (
      // Full ink: an off-air card is dimmed to .72, a secondary ink would fall under 4.5:1.
      <Pill className={clsx('text-ink', className)}>
        <span aria-hidden="true">○</span>
        {t('pill.offAir')}
      </Pill>
    );
  }
  return null; // unknown: no pill (the meta line says "not checked")
}

/** Mono caps overline above a title (`LIVE · NEWS · FRANCE`). */
export function Overline({ children, data, className }: { children: ReactNode; data?: boolean; className?: string }) {
  return (
    <p className={clsx('overline', className)} translate={data ? 'no' : undefined}>
      {children}
    </p>
  );
}

/** Mono meta line; each non-empty part is separated by " · ". Wrap data parts in <Data>. */
export function Meta({ parts, children, className }: { parts?: ReactNode[]; children?: ReactNode; className?: string }) {
  const items = (parts || []).filter((p) => p !== null && p !== undefined && p !== false && p !== '');
  return (
    <p className={clsx('meta', className)}>
      {items.map((p, i) => (
        <span key={i}>{p}</span>
      ))}
      {children}
    </p>
  );
}

/** Marks DATA (channel name, country, programme title): never translated, not UI copy. */
export function Data({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span translate="no" className={className}>
      {children}
    </span>
  );
}

// ── Empty state: one per page, one action (spec 2.9) ───────────────────
export interface EmptyAction {
  label: string;
  onClick: () => void;
  /** `primary` when the page has no hero (its only primary). Default `secondary`. */
  variant?: ButtonVariant;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  /** One `--t2` sentence. */
  body?: string;
  action?: EmptyAction;
  className?: string;
}) {
  return (
    <div data-empty="" className={clsx('flex flex-col items-center justify-center gap-3 py-20 text-center', className)}>
      {icon && <div className="text-ink-3" aria-hidden="true">{icon}</div>}
      <p className="text-carte font-semibold text-ink">{title}</p>
      {body && <p className="max-w-sm text-sous text-ink-2">{body}</p>}
      {action && (
        <Button variant={action.variant || 'secondary'} onClick={action.onClick} className="mt-2">
          {action.label}
        </Button>
      )}
    </div>
  );
}

// ── Toasts (spec 2.10): mount <ToastHost/> once in the shell (Lot B) ────
export function ToastHost() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  const t = useT();
  // The live region is always in the DOM (empty when idle): one inserted along
  // with its first message is often not announced (WEB-15).
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--entete-h)+8px)] z-[80] flex flex-col items-center gap-2 px-4 sm:bottom-8 sm:top-auto"
    >
      {toasts.map((x) => (
        <div key={x.id} className="toast pointer-events-auto animate-fade-in">
          {x.ok && (
            <span aria-hidden="true" className="text-mint">
              ✓
            </span>
          )}
          <span className={clsx(!x.undo && 'pr-2.5')}>{x.text}</span>
          {x.undo && (
            <button
              type="button"
              className="btn btn-quiet min-h-[36px] px-3"
              onClick={() => {
                x.undo?.();
                dismiss(x.id);
              }}
            >
              {t('toast.undo')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Loading ────────────────────────────────────────────────────────────
/** The NEOWATCH mark: SoClose rose identity point + wordmark (same everywhere). */
export function BrandMark({ className, as: Tag = 'span' }: { className?: string; as?: 'span' | 'p' | 'h1' }) {
  return (
    <Tag translate="no" className={clsx('brand inline-flex items-center gap-2 text-libelle', className)}>
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[var(--identite)]" />
      NEOWATCH
    </Tag>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={clsx('h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-ink-2', className)} />;
}

export function CardSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-card border border-line bg-[var(--surface-carte)]">
      <div className="aspect-video bg-[var(--bg-2)]" />
      <div className="space-y-1.5 p-2">
        <div className="h-2.5 w-3/4 rounded bg-[var(--bg-3)]" />
        <div className="h-2 w-1/2 rounded bg-[var(--bg-3)]" />
      </div>
    </div>
  );
}
