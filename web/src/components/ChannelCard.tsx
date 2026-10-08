import { memo, useState } from 'react';
import { clsx } from 'clsx';
import type { Channel, HealthStatus } from '@/types';
import type { Programme } from '@/lib/epg';
import { categoryLabel } from '@/lib/format';
import { LOCALES, fmtTime, useT, type Lang } from '@/lib/i18n';
import { useUI } from '@/store/uiStore';
import type { PlayOptions } from '@/store/playerStore';
import { HealthPill, Pill } from './ui';

// One card = one button = one action (spec 2.4): click, OK, Enter and Space all
// play (a locked custom-playlist channel opens Pricing). No inner controls: the
// list, multi-view and channel page live in the player and on the detail page.
// Verifier contract: data-card + data-key=<stream url> (focus restore on Back).

export type PlayFn = (ch: Channel, opts?: PlayOptions) => void;

interface Props {
  channel: Channel;
  health: HealthStatus;
  /** @deprecated ignored: latency in ms is jargon on screen. */
  latency?: number;
  onPlay: PlayFn;
  /** The list the card sits in (rail, grid): next / previous in the player. */
  queue?: Channel[];
  /** Programme on air now / next (EPG), when known. */
  now?: Programme | null;
  next?: Programme | null;
  /** Fixed row width (`--carte-l`, or `--carte-l-large` when `wide`); default fills its grid cell. */
  inRow?: boolean;
  wide?: boolean;
  className?: string;
}

/** "1080p" -> "FHD" (quality meta; the raw value is data). */
export function qualityLabel(q: string | null | undefined): string | null {
  if (!q) return null;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 'UHD';
  if (s.includes('1080')) return 'FHD';
  if (s.includes('720')) return 'HD';
  if (s.includes('480') || s.includes('576') || s.includes('360')) return 'SD';
  return null;
}

/** Two letters shown when the logo is missing or fails. */
export function monogram(name: string): string {
  const words = (name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] || '?') + (words[1]?.[0] || words[0]?.[1] || '')).toUpperCase();
}

// Country name in the UI language from its code (Intl), else iptv-org's English name.
// iptv-org uses UK for the United Kingdom; Intl wants GB.
const regionNames = new Map<Lang, Intl.DisplayNames | null>();
export function countryLabel(ch: Pick<Channel, 'country' | 'countryName'>, lang: Lang): string | null {
  const code = ch.country === 'UK' ? 'GB' : ch.country;
  if (code && /^[A-Z]{2}$/.test(code)) {
    if (!regionNames.has(lang)) {
      try {
        regionNames.set(lang, new Intl.DisplayNames([LOCALES[lang]], { type: 'region' }));
      } catch {
        regionNames.set(lang, null);
      }
    }
    try {
      const n = regionNames.get(lang)?.of(code);
      if (n && n !== code) return n;
    } catch {
      /* unknown region code */
    }
  }
  return ch.countryName || null;
}

// First language in the UI language from its ISO 639 code (Intl), else iptv-org's English name.
const languageNames = new Map<Lang, Intl.DisplayNames | null>();
export function languageLabel(ch: Pick<Channel, 'languages' | 'languageNames'>, lang: Lang): string | null {
  const code = ch.languages?.[0];
  if (code && /^[a-z]{2,3}$/.test(code)) {
    if (!languageNames.has(lang)) {
      try {
        languageNames.set(lang, new Intl.DisplayNames([LOCALES[lang]], { type: 'language' }));
      } catch {
        languageNames.set(lang, null);
      }
    }
    try {
      const n = languageNames.get(lang)?.of(code);
      if (n && n !== code) return n;
    } catch {
      /* unknown language code */
    }
  }
  return ch.languageNames?.[0] || null;
}

export const isGeo = (ch: Channel) => /geo-?block/i.test(ch.label || '');

export const ChannelCard = memo(function ChannelCard({ channel: ch, health, onPlay, queue, now, next, inRow, wide, className }: Props) {
  const t = useT();
  const setPricing = useUI((s) => s.setPricing);
  const [imgFailed, setImgFailed] = useState(false);
  const locked = !!ch.locked;
  const offline = !locked && health === 'offline';
  const cat = ch.categories.find((c) => c !== 'undefined');
  const q = qualityLabel(ch.quality);
  const country = countryLabel(ch, t.lang);
  const legend = next ? t('card.nextAt', { time: fmtTime(next.start), title: next.title }) : null;

  const activate = () => (locked ? setPricing(true) : onPlay(ch, { queue, originKey: ch.url }));

  return (
    <button
      type="button"
      data-card=""
      data-key={ch.url}
      onClick={activate}
      className={clsx(
        'lift group relative flex shrink-0 snap-start flex-col rounded-card text-left',
        inRow ? (wide ? 'w-[var(--carte-l-large)]' : 'w-[var(--carte-l)]') : 'w-full',
        offline && 'opacity-[.72]',
        className
      )}
    >
      {/* 16:9 plate: the logo centred on --bg-3, or a monogram */}
      <span className="card-surface flex w-full items-center justify-center bg-[var(--bg-3)] pb-2 pt-[calc(var(--pastille-h)_+_10px)]">
        {ch.logo && !imgFailed ? (
          <img
            src={ch.logo}
            alt=""
            width={160}
            height={90}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="h-auto max-h-[78%] w-auto max-w-[72%] object-contain"
          />
        ) : (
          <span aria-hidden="true" translate="no" className="font-mono text-titre2 font-semibold text-ink-2">
            {monogram(ch.name)}
          </span>
        )}
        {/* Corner state: glyph + word, never colour alone */}
        <span className="absolute left-2 top-2 flex">
          {locked ? (
            <Pill>
              <span aria-hidden="true">✦</span>
              {t('pill.premium')}
            </Pill>
          ) : (
            <HealthPill status={health} geo={isGeo(ch)} />
          )}
        </span>
      </span>

      {/* Name, then one subtitle line: EPG now, else country · category (· quality) */}
      <span className="flex min-w-0 flex-col gap-0.5 px-0.5 pb-1 pt-2.5">
        <span translate="no" className="truncate text-carte font-semibold text-ink [:root[data-tv]_&]:line-clamp-2 [:root[data-tv]_&]:whitespace-normal">
          {ch.name}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-sous text-ink-2">
          {now ? (
            <>
              <span className="shrink-0 font-mono text-meta text-ink-3">{fmtTime(now.start)}</span>
              <span translate="no" className="truncate">{now.title}</span>
            </>
          ) : (
            <span className="truncate">
              {country && <span translate="no">{country}</span>}
              {country && cat && <span aria-hidden="true"> · </span>}
              {cat && <span>{categoryLabel(cat)}</span>}
              {q && <span aria-hidden="true"> · </span>}
              {q && <span translate="no" className="font-mono text-meta">{q}</span>}
              {ch.kind === 'youtube' && <span aria-hidden="true"> · </span>}
              {ch.kind === 'youtube' && <span translate="no">YouTube</span>}
            </span>
          )}
        </span>
        {/* Legend under the focused card (EPG next), one line, opacity only */}
        {legend && (
          <span className="truncate text-meta text-ink-3 opacity-0 transition-opacity duration-d1 group-hover:opacity-100 group-focus-visible:opacity-100">
            {legend}
          </span>
        )}
      </span>
    </button>
  );
});
