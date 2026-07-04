import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '@/store/authStore';

// Real Google AdSense unit for FREE/anonymous users (only when a client id is
// configured server-side). The premium upsell lives in PromoStrip.
export function AdBanner() {
  const { user, config } = useAuth();
  const [closed, setClosed] = useState(false);
  const adRef = useRef<HTMLModElement>(null);
  const adsense = config?.adsenseClient;
  const isFree = !user?.premium;

  useEffect(() => {
    if (!isFree || closed || !adsense) return;
    // Inject the AdSense loader once.
    const id = 'adsbygoogle-js';
    if (!document.getElementById(id)) {
      const s = document.createElement('script');
      s.id = id;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsense}`;
      document.head.appendChild(s);
    }
    try {
      // @ts-expect-error adsbygoogle is injected globally
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* blocked / not ready */
    }
  }, [isFree, closed, adsense]);

  // Only render a real ad unit. The premium upsell for free users lives in
  // PromoStrip (single, non-duplicated CTA), so without AdSense we render nothing.
  if (!isFree || closed || !adsense) return null;

  return (
    <div className="relative border-b border-white/[0.06] bg-panel/50">
      <button onClick={() => setClosed(true)} className="absolute right-1 top-1 z-10 rounded p-1 text-ink/30 hover:text-ink/70" aria-label="Fermer">
        <X size={13} />
      </button>
      <ins
        ref={adRef}
        className="adsbygoogle block"
        style={{ display: 'block', minHeight: 60 }}
        data-ad-client={adsense}
        data-ad-slot="auto"
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
