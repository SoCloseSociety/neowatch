import { memo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Heart, Play, Plus, Check, Tv, Crown, Lock, Info } from 'lucide-react';
import type { Channel, HealthStatus } from '@/types';
import { categoryIcon } from '@/lib/format';
import { useCatalog } from '@/store/catalogStore';
import { usePlayer } from '@/store/playerStore';
import { useUI } from '@/store/uiStore';
import { HealthBadge } from './ui';
import { useT } from '@/lib/i18n';

interface Props {
  channel: Channel;
  health: HealthStatus;
  latency?: number;
  onPlay: (ch: Channel) => void;
}

export const ChannelCard = memo(function ChannelCard({ channel, health, latency, onPlay }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const [imgFailed, setImgFailed] = useState(false);
  const toggleFavorite = useCatalog((s) => s.toggleFavorite);
  const isFavorite = useCatalog((s) => s.isFavorite(channel.url));
  const addToMulti = usePlayer((s) => s.addToMulti);
  const inMulti = usePlayer((s) => s.isInMulti(channel.url));
  const setPricing = useUI((s) => s.setPricing);

  const geo = /geo-?block/i.test(channel.label || '');
  const locked = !!channel.locked;
  const premium = channel.tier === 'premium';
  // Locked premium channels open the paywall instead of playing.
  const activate = () => (locked ? setPricing(true) : onPlay(channel));

  return (
    <div
      role="button"
      tabIndex={0}
      data-card
      // Pointer click = quick play. Remote/keyboard OK = open the detail page -- the
      // reliable TV action hub (Play / My List / Multi-screen / Programme), since the
      // hover quick-actions can't be reached with a D-pad. (e.detail===0 => key-driven.)
      onClick={(e) => { if (e.detail !== 0) activate(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (locked) setPricing(true); else navigate(`/chaine/${channel.id}`);
        }
      }}
      className={clsx(
        'cv-card lift group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border bg-panel/70 text-left',
        'border-white/[0.06] hover:border-accent/40 hover:bg-panel',
        'focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/50',
        health === 'offline' && 'opacity-50'
      )}
    >
      {/* Thumbnail / logo */}
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-gradient-to-br from-white/[0.04] to-black/40">
        {channel.logo && !imgFailed ? (
          <img
            src={channel.logo}
            alt={channel.name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="max-h-[70%] max-w-[80%] object-contain transition-transform group-hover:scale-105"
          />
        ) : (
          <Tv className="text-ink/15" size={40} />
        )}

        {/* Top row badges */}
        <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
          {!locked && <HealthBadge status={health} latency={latency} />}
        </div>
        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
          {premium && (
            <span className="flex items-center gap-0.5 rounded bg-amber-500/90 px-1 py-0.5 font-mono text-[8px] font-bold text-black" title={t('common.premium')}>
              <Crown size={8} />
            </span>
          )}
          {channel.quality && (
            <span className="rounded bg-black/70 px-1 py-0.5 font-mono text-[8px] font-bold text-accent">
              {channel.quality}
            </span>
          )}
          {channel.kind === 'youtube' && (
            <span className="rounded bg-rose-600/80 px-1 py-0.5 font-mono text-[8px] font-bold text-white">YT</span>
          )}
        </div>

        {/* Locked = premium paywall overlay; otherwise hover play overlay */}
        {locked ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 backdrop-blur-[1px]">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/90 text-black">
              <Lock size={15} />
            </div>
            <span className="font-mono text-[8px] font-bold tracking-wider text-amber-300">PREMIUM</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/90 text-black">
              <Play size={18} className="ml-0.5" fill="currentColor" />
            </div>
          </div>
        )}

        {geo && (
          <span className="absolute bottom-1.5 left-1.5 rounded bg-amber-500/20 px-1 py-0.5 font-mono text-[7px] text-amber-300">
            GEO
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-1 flex-col gap-0.5 p-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-ink">{channel.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-ink/40">
          <span>{channel.flag || '🌐'}</span>
          <span className="truncate">{channel.countryName || 'International'}</span>
          <span className="ml-auto shrink-0">{categoryIcon(channel.categories[0] || 'undefined')}</span>
        </div>
      </div>

      {/* Quick actions — always visible on touch, hover/focus-reveal on desktop */}
      <div className="absolute bottom-14 right-1.5 flex flex-col gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <button
          aria-label={t('common.favorite')}
          onClick={(e) => {
            e.stopPropagation();
            if (locked) return setPricing(true);
            toggleFavorite(channel);
          }}
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur transition-colors',
            isFavorite ? 'border-rose-500/40 bg-rose-500/20 text-rose-400' : 'border-white/10 bg-black/60 text-ink/60 hover:text-rose-400'
          )}
        >
          <Heart size={13} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
        <button
          aria-label={t('common.addMulti')}
          onClick={(e) => {
            e.stopPropagation();
            if (locked) return setPricing(true);
            addToMulti(channel);
          }}
          className={clsx(
            'flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur transition-colors',
            inMulti ? 'border-accent/40 bg-accent/20 text-accent' : 'border-white/10 bg-black/60 text-ink/60 hover:text-accent'
          )}
        >
          {inMulti ? <Check size={13} /> : <Plus size={13} />}
        </button>
        <button
          aria-label={t('common.info')}
          onClick={(e) => { e.stopPropagation(); navigate(`/chaine/${channel.id}`); }}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/60 text-ink/60 backdrop-blur transition-colors hover:text-accent"
        >
          <Info size={13} />
        </button>
      </div>
    </div>
  );
});
