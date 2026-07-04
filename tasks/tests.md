# NEOWATCH -- Test plan / checklist

> Complete test list across API, web, monetization, EPG, security, platforms.
> ✅ = verified this build · ⬜ = manual / to run · 🔑 = needs your API keys (Stripe/AdSense)

## 1. Build & boot
- ✅ `npm install` (workspaces) succeeds
- ✅ `npm run typecheck` passes (web)
- ✅ `npm run build` passes; hls.js code-split into its own chunk (initial bundle ~71 kB gzip)
- ✅ `npm run dev` starts server (8787) + Vite (5273); `/api` proxied
- ⬜ `npm start` (NODE_ENV=production) serves `web/dist` + `/api` on one port
- ✅ Server refuses to boot in prod/gated mode with the default JWT secret

## 2. Catalog
- ✅ `/api/catalog/meta` returns total (~15.9k), categories (29), countries (176), free/premium counts
- ✅ `/api/catalog/channels?category=sports|news|movies|...` returns items
- ✅ `?foot=1` returns football/sport channels
- ✅ `?q=france` searches name/country/category
- ✅ `?country=FR&language=fra` filter
- ✅ Pagination (`page`, `limit`) + infinite scroll in the grid
- ✅ Deterministic channel id (stable across rebuilds); `/api/catalog/channel/:id` deep-link

## 3. Playback
- ✅ Proxy returns + rewrites HLS master manifest (ABR variants) with correct content-type
- ✅ Proxy streams `.ts` segments (CORS/geo bypass), forwards custom UA/Referrer
- ✅ Channel health sweep: ~70% of a multi-category sample reachable (rest correctly flagged offline)
- ⬜ Web: play an HLS channel (direct), a CORS-blocked one (auto proxy fallback), a YouTube channel
- ⬜ Player: quality menu, PiP, fullscreen (F), volume slider + mute (M) + arrows, play/pause (space)
- ⬜ Error overlay: Réessayer / Forcer le proxy / Ouvrir l'original recover a flaky stream
- ⬜ Multi-screen: add 2-9 channels, switch active audio, remove/clear

## 4. Filters / search / UX
- ✅ "Toutes les chaînes" (logo + sidebar entry) resets every filter
- ✅ TopBar search syncs with store resets (no ghost text)
- ⬜ "En ligne uniquement" hides offline; "Sans géo-bloc" hides geo-blocked
- ⬜ Density (Large/Normal/Dense), themes (4) + accent (8) apply live
- ⬜ Favorites add/remove + "Mes favoris" view; recents list

## 5. Monetization (tiers / paywall / billing)
- ✅ Channels split free (~13.9k) / premium (~2k: sports, movies, series, custom)
- ✅ Anonymous/free: premium channels locked (url null, `locked:true`)
- ✅ Free user upgrade (mock checkout) -> premium -> channels unlocked (url present)
- ✅ Proxy refuses a premium URL for non-premium users (HTTP 402)
- ✅ Admin grant/revoke premium (`/api/admin/users/:id/plan`)
- ⬜ Web: locked card opens Pricing funnel; "Premium" CTA; PRO badge after upgrade
- ⬜ Free users see the ad banner; premium users do not
- 🔑 Stripe checkout (set BILLING_PROVIDER=stripe + STRIPE_SECRET/PRICE_ID + webhook)
- 🔑 Real Google AdSense unit (set ADSENSE_CLIENT=ca-pub-...)

## 6. Auth / SaaS / admin
- ✅ Register / login / `me`; JWT; bcrypt; roles admin/user
- ✅ Admin API requires admin (401/403 otherwise)
- ✅ Last-admin demotion/disable blocked; admin password min length
- ✅ Atomic + serialized user-store writes
- ✅ Rate limiting: auth (30/min), health-check (120/min), proxy (3000/min)
- ⬜ `REQUIRE_AUTH=true` gates catalog/proxy behind login (SaaS mode)

## 7. Custom sources (M3U) + EPG
- ✅ Import M3U by URL and by pasted text; parsed + merged into catalog
- ✅ M3U: comma-safe names, tvg-logo, group->category, tvg-id, #EXTVLCOPT UA/Referrer
- ✅ Delete source removes its channels; refresh re-fetches
- ✅ EPG XMLTV parser: programmes, entities, timezone conversion (verified)
- ✅ `/api/epg/now?ids=` now/next; `/api/epg/search?q=` programme search joined to channels
- ⬜ Web: Player now/next strip; "À l'antenne" program-search strip; admin EPG source UI
- 🔑/⬜ Add your provider's XMLTV URL and confirm now/next + program search populate

## 8. Security
- ✅ SSRF guard on proxy, health, and M3U/EPG fetch (blocks 127.0.0.1, 169.254.169.254, RFC1918)
- ✅ `ALLOW_PRIVATE_SOURCES` opt-out for trusted LAN providers
- ✅ Playlist/EPG size caps; CORS same-origin by default; `trust proxy` configurable
- ⬜ Pen-test the proxy for redirect-based SSRF bypass before public exposure

## 9. PWA / platforms (responsive)
- ⬜ Installable on Android / iPhone (Add to Home Screen) + desktop install button
- ⬜ Phone (2 cols) / tablet / desktop / 4K-TV (up to 8-12 cols) layouts
- ⬜ TV / D-pad: every control shows a visible focus ring; cards focusable + Enter plays
- ⬜ Offline: app shell loads via service worker (playback needs network)

## 10. Deploy
- ⬜ `docker compose up --build` serves the app on $PORT with persisted cache/data volumes
- ⬜ Behind nginx with `REQUIRE_AUTH=true`, strong `JWT_SECRET`, `TRUST_PROXY=1`

## How to run the automated checks
- API/catalog/monetization/EPG: see the curl + node snippets used during this build (smoke tests).
- Parser unit check: `node --input-type=module -e "import('./server/src/epg.js').then(...)"`.
