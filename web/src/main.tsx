import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// IBM Plex, self-hosted (OFL, @fontsource): no request leaves the origin, the
// fonts are content-hashed under /assets (offline in the PWA), and the
// unicode-range subsets mean a Latin page never downloads Cyrillic.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import App from './App';
import './index.css';
import { applyDeviceFlags } from './lib/device';
import { applyTheme } from './store/settingsStore';
import { applyLang } from './lib/i18n';

// Before the first render: data-tv (the 10-foot tokens), data-theme/motion and
// <html lang>, so the first frame already has the right scale, style and language.
applyDeviceFlags();
applyTheme();
applyLang();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register the PWA service worker (installable on Android / iOS / desktop).
// The app IS the live site, so updates are automatic: navigations are
// network-first and assets are content-hashed. We additionally poll for a new
// service worker (on focus + hourly) so long-lived installs (TV/PWA left open)
// pick up new deploys without any manual update.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      const check = () => reg.update().catch(() => {});
      setInterval(check, 60 * 60 * 1000); // hourly
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    }).catch(() => {});
  });
}
