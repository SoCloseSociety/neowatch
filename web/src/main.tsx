import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

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
