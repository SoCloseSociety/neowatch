# NEOWATCH -- Tasks / TODO

> Plan-first board. Add checkable items before implementing. Mark complete as you go.
> Add a "Review" section under each batch once done.

## Backlog / Next

- [ ] Native PNG icons (192/512/maskable) for best iOS "Add to Home Screen".
- [ ] Android TV / Smart TV: TWA wrapper or Tizen/webOS packaging.
- [ ] Wire Stripe (keys pending) + real AdSense (client id pending).
- [ ] Per-user custom sources + client-side `collections` prefs (server field exists).
- [ ] Unit-test infra (vitest/node:test) to complement the integration suite.
- [ ] Favorites roam reconstruction (server stores urls; needs by-url lookup to rebuild on a new device).

## Done (v1.3 -- ultracode audit hardening + completeness)

Driven by a 72-agent adversarial audit (52 confirmed issues). All 5 HIGH + key MED fixed; integration suite at 44/44.

- [x] SECURITY: SSRF `safeFetch` (manual per-hop revalidation + undici DNS-pinned agent, defeats redirect-bypass + DNS-rebinding) applied to proxy/health/sources/epg; signed (HMAC+TTL) proxy URLs replace the JWT-in-`?t=` (no credential in query, no open relay, paywall enforced at vend); random JWT secret if unset + explicit-secret boot guard for prod; trust-proxy hardening; decompression-bomb + streaming size caps; generic proxy errors; Referrer-Policy no-referrer.
- [x] CORRECTNESS: proxy reader cleanup on disconnect; multi/single mutual exclusion; forcedProxy reset per channel; admin error surfacing; cross-tab token sync; custom-source NSFW filter + URL dedup; EPG default-tz.
- [x] PERF (scale): DNS verdict cache, undici keep-alive pooling, 1.5s manifest micro-cache.
- [x] FEATURES: arrow-key/D-pad grid navigation; locked-channel guard (no fav/multi/play of premium); HlsVideo auto-reconnect on network return; Account modal (plan/expiry, cancel premium, self password change) + `PUT /api/auth/password`; Escape-to-close on all modals.

## Done (v1.4 -- bug-hunt v2 + playability/coverage)

Second 46-agent adversarial bug-hunt on the post-refactor code (27 confirmed). Coverage audited: iptv-org lists 39,927 channels but only 15,944 have a stream; we ingest ~all of them (drop only closed/NSFW) -- the ~30k "missing" channels simply have no public feed.

- [x] PLAYABILITY (the "channels that don't work" fix): (H2) route extension-less / .php / path-marker HLS to hls.js (was failing in Chrome/Firefox via native playback) -- broadened `classifyKind` + client uses hls.js for any non-progressive source; (alternates) **auto-fallback to a channel's other feeds** when the primary dies (1,909 channels, 3,999 alternate feeds); skip unplayable DASH (~247) instead of vending broken cards.
- [x] (H1) SSRF `safeFetch` socket leak: drain/cancel each redirect-hop body (was exhausting the undici pool and stalling all playback at scale).
- [x] Player resilience: stall recovery no longer tears down a healthy playing stream; online-reconnect only fires when errored; native-path teardown clears src/onerror.
- [x] Server: custom items compose even if base build failed; proxy manifest-detection case-insensitive; proxy drain-listener leak fixed; signed-URL TTL 6h->2h (bounds post-cancel premium window).
- [x] Client: prefs roll back on 402.

## Done (v1.5 -- background health sweep)

- [x] Server health store now persists to disk + exposes getHealth/isOnline; a gentle, opt-in background sweep (HEALTH_SWEEP=true, or admin "Tester les chaînes" button) probes channels in bounded batches and refreshes on an interval.
- [x] Catalog projects an `online` field per channel and sorts **confirmed-online first**; `hideOffline` query param drops server-confirmed-dead channels catalog-wide (wired to the "En ligne uniquement" toggle).
- [x] Web seeds LIVE/OFFLINE badges instantly from the server `online` field (no per-card probe needed for swept channels).
- [x] Admin: trigger a sweep + see online/offline stats.

## Done (v1.6 -- Netflix/Molotov homepage + QR install + live deploy)

- [x] LIVE on **https://neowatch.soclose.co** (helper VPS, systemd, nginx, TLS) -- see [DEPLOY.md](../DEPLOY.md).
- [x] Welcoming discover **Home** (`Home.tsx`): kie.ai-generated hero (`web/public/hero.jpg`, 272K) + rotating featured spotlight, colourful category tiles, and horizontal **rails** (`Rail.tsx`) per category -- server `GET /api/catalog/home` returns curated, online-first, premium-aware rails + featured. Favorites + Reprendre (recents) rails client-side. The **sidebar stays on desktop** for power users; any filter/search/category switches to the full grid.
- [x] **QR quick-install** panel (`Install.tsx`): QR code (qrcode) of the site + step-by-step for phone/tablet (Add to Home Screen), Android/Smart TV (browser + D-pad), and desktop (install button). Opened from the TopBar.
- [x] Channels auto-ranked: confirmed-online first (deep health), then custom/logo/known; home rails surface the best per category.

## Known residual (low / roadmap)
- Premium self-renewal: a cancelled user keeping a tab open can stream up to ~2h (signed-URL TTL). Full fix = per-request premium re-check via short-lived stream token.
- `.php` streams labelled `kind:other` server-side (cosmetic) but still played via hls.js client-side.

## Review (v1.3)

The app is feature-complete for v1 and hardened: 15,883 channels, free/premium tiers with a real (signed-URL) paywall, M3U import, EPG, multi-screen, PWA, admin + account management, TV/responsive. 44/44 integration tests pass; build + typecheck clean. Remaining items are roadmap (native packaging, Stripe/AdSense keys, unit-test infra).

## Done (v1.1 -- import + hardening + responsive)

- [x] Custom M3U/M3U8 import (URL or pasted text), parsed + merged into the catalog,
      admin-managed, searchable/filterable/playable like every other channel.
- [x] Rate limiting on auth (brute force), health-check, and proxy.
- [x] Code-split hls.js + Player/MultiView/Admin -> initial bundle ~68 kB gzip (was ~234 kB).
- [x] Responsive everywhere: phone/tablet/desktop + 2xl columns for 4K/TV; touch-visible card
      actions; wrapping player bar; visible focus ring on ALL controls (TV/D-pad); PWA safe-areas.
- [x] Player volume quick actions: mute + volume slider + play/pause, keyboard (m / arrows / space),
      native-control sync.
- [x] Second audit pass: SSRF guard on M3U import (+ private-host opt-out), playlist size cap,
      comma-safe M3U name parsing, trust-proxy for real client IP, catalog merge race safeguard.

## Done (v1 -- initial build)

- [x] Monorepo scaffold (workspaces: server + web).
- [x] Server: iptv-org catalog fetch + disk cache + normalization + facets.
- [x] Server: HLS/segment proxy (CORS/geo + custom UA/Referrer, manifest rewrite).
- [x] Server: stream health checks (LIVE / OFFLINE badges) with TTL cache.
- [x] Server: JWT + bcrypt auth, admin/user roles, admin user-management API, content gate.
- [x] Web: HLS player (hls.js tuned) + YouTube embed + direct/proxy fallback.
- [x] Web: channel grid (infinite scroll, lazy logos, density), search + all filters.
- [x] Web: multi-screen mosaic (1-9 tiles, single active audio).
- [x] Web: favorites, recents, themes/accent, settings, login/register, admin dashboard.
- [x] PWA: manifest + service worker (installable, offline shell).
- [x] Security/audit pass: SSRF guard on proxy + health (block private/metadata IPs),
      atomic+serialized user store writes, deterministic channel ids (stable favorites/deep-links),
      request-generation guard against out-of-order pages, JWT-secret boot check, CORS locked to
      same-origin by default, last-admin lock-out guard, HLS proxy-fallback deferred + stall watchdog.

## Review (v1)

Initial build delivered a working, installable, self-hostable live-TV app over the public
iptv-org catalog with admin/user separation and a multi-screen mode. See README for run steps.
Open items above are roadmap, not blockers.
