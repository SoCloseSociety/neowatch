# CLAUDE.md -- NEOWATCH

> Operating manual for any AI assistant working in this repo. Read it fully before touching code.
> House rule: never use em dashes in any output. Use `--` instead.

## 1. Project Identity

- **Name:** NEOWATCH
- **Role:** Self-hostable live-TV aggregator + player. Watches the world's publicly available free live channels (every iptv-org category), internet radio and public-domain films, with a fast HLS player, a 9-screen mosaic, a TV guide, honest health badges, a remote-friendly TV mode and a SaaS-style admin/user layer. Live at https://neowatch.soclose.co.
- **Detected stack (versions pinned in package.json + package-lock.json):**
  - Frontend: React 18.3 + TypeScript 5.6 + Vite 6 + Tailwind 3.4, Zustand 5 (state), hls.js 1.5 (playback), react-router-dom 6.30, lucide-react (icons), clsx, IBM Plex Sans/Mono self-hosted via `@fontsource`. Installable PWA (manifest + service worker).
  - Backend: Node 20 (ESM; production runs **20.20.2**, `.nvmrc`), Express 4.22, undici **6** (never 7/8: they need Node 22), jsonwebtoken + bcryptjs, compression, cors, dotenv. No database: JSON files for users/sources/guides, disk cache for the catalog.
  - Data sources: **iptv-org** API (channels, streams, categories, countries, languages, logos, feeds), radio-browser (radio), Internet Archive (public-domain films), XMLTV guides.
  - Android: `android/` = plain WebView shell + phone widgets (package `co.soclose.neowatch.twa`, FROZEN). `twa-manifest.json` is the legacy Bubblewrap TWA config, kept for history only (see `docs/android-tv.md`).
- **Repo layout:** `server/` API, `web/` SPA, `android/` shell, `scripts/` (deploy.sh, start.mjs, epg/ = the VPS guide grabber), `test/` (run.mjs + suites + e2e + verify-design), `docs/` (TESTS.md, android-tv.md, screenshots), `tasks/` (todo.md + lessons.md only).
- **Architecture overview:**
  - Monorepo with npm workspaces: `server/` (API + stream proxy + catalog cache + auth) and `web/` (React SPA / PWA).
  - Dev: `web` on Vite port **5273**, `server` on port **8787**; Vite proxies `/api` -> server. Run both with `npm run dev`.
  - Prod: `npm run build` outputs `web/dist`; the Express server serves it statically and exposes `/api` (single process, port 8787). On the VPS, nginx serves `web/dist` and proxies `/api/` to the service (DEPLOY.md).
  - External dependency: iptv-org API (fetched + cached with TTL, stale-while-revalidate, stale disk fallback when iptv-org is down). The catalog is normalized in memory once, then queried/paginated per request.
  - The stream **proxy** (`/api/proxy`) only handles CORS/geo-locked/mixed-content streams and streams needing a custom User-Agent/Referrer. The web app plays DIRECT first, then the proxy, then the alternates -- this keeps server bandwidth low on a shared host.
- **Frozen API contract** (consumed by Sentinel House, Neo, the Android widgets): see `NEO_CONNECTOR.md` section 1. Additive changes only; `test/contract-test.mjs` guards it.
- **Critical files -- do not change without a written plan first:**
  - `server/src/catalog.js` -- the iptv-org normalization + facet building + id aliases. Subtle joins (streams<->channels<->logos<->feeds). Breaking it empties the whole app.
  - `server/src/proxy.js` -- HLS manifest rewriting + the header allowlist. A wrong rewrite breaks playback for proxied streams.
  - `web/src/components/HlsVideo.tsx` -- the player core (hls.js config + direct/proxy/alternate fallback). Tuned for fast start + low lag.
  - `server/src/auth.js` -- token signing, password hashing, role gates, sliding sessions. Security-sensitive.

## 2. Workflow Orchestration

- Enter **plan mode** for ANY non-trivial task (3+ steps or an architectural decision). Write the plan to `tasks/todo.md` first.
- If something goes sideways, **STOP and re-plan immediately**. Never keep pushing a failing approach.
- Write a short spec upfront before touching code for anything beyond a one-line fix.
- Use **subagents** for research / exploration / parallel analysis -- one task per subagent. Keep the build itself cohesive (one author).
- After any correction from the user: append the pattern to `tasks/lessons.md`.

## 3. Verification Before Done

- Never mark a task complete without proving it works. Ask: "Would a senior engineer approve this?"
- Concretely for NEOWATCH:
  - `npm run typecheck` and `npm run build` must pass.
  - `npm test` must pass (`test/run.mjs`: throwaway servers, contract + integration + proxy + img (logo relay) + account + catalog + hardening + session suites; see `docs/TESTS.md`).
  - `curl localhost:8787/api/health` returns ok; `/api/catalog/meta` returns a non-zero `total`.
  - UI changes: `node test/verify-design.mjs <port> --pages <yours> --formats desktop,phone,tv --measure` on a throwaway server, and LOOK at the screenshots. `node test/verify-design.mjs --keys` checks every `t()` key exists in EN/FR/RU.
  - Open the app, play one HLS channel and one YouTube channel, open the multi-screen mosaic. `npm run test:e2e` (BASE=...) is the scripted version.
- Diff behavior between the previous state and your change when relevant (e.g. catalog counts before/after a normalization change).

## 4. Autonomous Bug Fixing

- Given a bug report: fix it end to end, no hand-holding.
- Server logs go to stdout (and `/tmp/neowatch-server.log` in dev runs). Point at logs, failing requests, console errors -- resolve them, then verify per section 3.
- Zero context switching required from the user.

## 5. Task Management

1. **Plan first:** write the plan to `tasks/todo.md` with checkable items.
2. **Verify plan:** check in before starting implementation (unless the user said proceed autonomously).
3. **Track progress:** mark items complete as you go.
4. **Explain changes:** give a high-level summary at each step.
5. **Document results:** add a review section to `tasks/todo.md`.
6. **Capture lessons:** update `tasks/lessons.md` after any correction.

## 6. Project-Specific Rules (inferred from the codebase)

- **Naming conventions:** React components PascalCase in `web/src/components`; Zustand stores `useX` in `web/src/store`; server modules lowercase ESM in `server/src`. API routes are namespaced under `/api`.
- **Architectural patterns:**
  - Server = thin route handlers + dedicated modules (`catalog`, `proxy`, `signing`, `health`, `auth`, `billing`, `sources`, `epg`, `films`, `radio`, `netguard`, `ratelimit`, `config`). No ORM; swap the JSON user store by reimplementing `load()/save()` in `auth.js` only.
  - Web = store-per-domain (auth / settings / catalog / player / prefs / ui). Components are presentational and read from stores. Design tokens are CSS variables in `web/src/index.css` (section 8, design system).
  - Server-side filters (category/country/language/q/foot/sort/hideOffline) trigger a reload; pure client filters (favorites, hide-geo) are applied in `applyClientFilters`.
- **Channel identity:** `id` = djb2 `stableId(url)` in base 36 (`server/src/util.js`), FROZEN for external consumers. It is stable across rebuilds; when a stream URL moves, `DATA_DIR/id-aliases.json` maps the old id and the response carries `canonicalId`; `?channelId=<tvg-id>` is a last-resort fallback. Favorites/recents/mosaic still key on the stream **url** -- keep it that way. Known: a few djb2 collisions exist (logged at build; the first channel keeps the id).
- **Premium gates features, never content.** Every iptv-org channel is free for everyone. Premium = account features (`PUT /api/me/prefs`: pinned/hidden categories, start page, preferences on every device; "no ads" only when ads run). Only operator-imported M3U items can be locked (`CUSTOM_PREMIUM`). `PREMIUM_CATEGORIES` is ignored for locking (still in `/api/config` for compatibility) -- never re-enable category locking.
- **Known fragile / tech-debt areas:**
  - The hls.js chunk is ~520 kB and the main bundle ~390 kB (lazy Player/MultiView/Admin). Code-split if they grow.
  - Many streams are geo-blocked or part-time ("Not 24/7"); a green badge only means reachable at `checkedAt` (verdicts older than 12 h count as unknown).
  - Stream proxying consumes host bandwidth. Keep "direct-first, proxy-fallback" intact on shared deploys.
  - `react-router-dom` 6.30.6 still has 2 moderate advisories fixed only in v7 (major bump, not taken).
- **Dev / build / run commands:**
  - `npm install` (root, installs both workspaces; `npm ci` in CI)
  - `npm run dev` -- server + web with hot reload (web: http://localhost:5273)
  - `npm run build` -- typecheck + build web to `web/dist`
  - `npm start` -- production (`scripts/start.mjs` sets `NODE_ENV=production` when unset; works on Windows): Express serves `web/dist` + `/api` on port 8787
  - `npm run typecheck` -- web TS check
  - `npm test` -- server suites on throwaway servers; `npm run test:e2e`; `npm run verify:design -- <port> ...`
  - Docker: `cp .env.example .env` (set `JWT_SECRET`), `docker compose up --build`
  - Deploy: `bash scripts/deploy.sh` (owner go-ahead only), `--rollback` to undo
- **Critical env vars (see `.env.example`):**
  - `PORT` (8787), `CATALOG_TTL_HOURS` (12), `IPTV_API_BASE`, `HIDE_NSFW` (true)
  - `REQUIRE_AUTH` (false = public; true = closed instance), `ALLOW_REGISTER`
  - `JWT_SECRET` (required in prod), `JWT_TTL`, `JWT_RENEW_AFTER` (sliding-session threshold, default half of `JWT_TTL`), `SIGNING_SECRET` (optional, derived from `JWT_SECRET`), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (first-boot admin; a random password is printed once if unset)
  - `DATA_DIR`, `CACHE_DIR` (optional: relocate `server/.data` / `server/.cache`, e.g. for a throwaway test server)
  - `ALLOWED_ORIGINS` (CORS allowlist), `TRUST_PROXY` (1 behind nginx)
  - `BILLING_PROVIDER` (mock|stripe), `ALLOW_MOCK_BILLING` (mock checkout in production, an explicit "free beta"), `STRIPE_SECRET`/`STRIPE_PRICE_ID`/`STRIPE_WEBHOOK_SECRET`, `PREMIUM_PRICE`/`PREMIUM_CURRENCY`/`PREMIUM_PERIOD_DAYS`, `CUSTOM_PREMIUM`, `ADSENSE_CLIENT`
  - `ALLOW_PRIVATE_SOURCES` (admin M3U/XMLTV fetches + the streams of custom sources may reach LAN hosts; iptv-org/radio streams keep the full SSRF guard)
  - `HEALTH_SWEEP`, `HEALTH_SWEEP_INTERVAL_HOURS`, `SWEEP_BATCH_SIZE`, `SWEEP_CONCURRENCY`, `EPG_DEFAULT_URL`, `EPG_DEFAULT_TZ_MINUTES`

## 7. Core Principles (global)

- **Simplicity first:** every change as simple as possible, minimal code impact.
- **No laziness:** find root causes, no temporary patches, senior-developer standards.
- **Minimal impact:** touch only what is necessary; avoid introducing regressions.
- **Never use em dashes** in any output -- use `--`.
- **Ollama-first** for any local LLM calls (an RTX 4070 is available). Do not add a paid cloud LLM dependency without asking.
- **Legality:** NEOWATCH only aggregates publicly available free streams (iptv-org) plus playlists the operator supplies. Do not add scrapers for paywalled/pirated content. Premium charges for features of the SERVICE (account preferences, no ads, the operator's own playlists), never for access to third-party streams. Takedowns: the admin blocklist hides a stream everywhere and the proxy answers 410.

## 8. Modules added after v1 (read before touching)

- **Monetization** -- `server/src/catalog.js` computes `tier` per channel: premium ONLY for custom M3U items when `CUSTOM_PREMIUM` is on (their URLs are stripped, `locked:true`, for non-premium callers). `server/src/billing.js` = plan copy (EN/FR/RU, one source, only what exists), checkout (`mock` instant, refused in production unless `ALLOW_MOCK_BILLING=true`; `stripe` hosted checkout), the signed Stripe webhook (idempotent by event id, invoices never downgrade, `planSource` mock|stripe|admin, cancel = `cancel_at_period_end`), admin grant. `/api/config` `billing.checkout` says whether a payment step is open. `auth.js` holds `plan`/`planExpires`/`planSource`/`cancelAtPeriodEnd`, `isPremium()`. Web: `Pricing.tsx`, `PromoStrip.tsx` (dismissible upsell under the top bar), `AdBanner.tsx` (AdSense only with `ADSENSE_CLIENT`, never on TV, only after consent).
- **Design system (Sentinel House "Lunaire")** -- tokens on `:root` in `web/src/index.css` (Lunaire dark + Doux light, `:root[data-tv]` TV scale), mapped to Tailwind names in `web/tailwind.config.js` (`text-min/meta/sous/...`, `line`, `primary`, `mint`, `amber`, `red`, `rounded-card/field/pill`, `shadow-ring/panel/toast/menu`), component classes (`.btn .btn-primary .btn-secondary .btn-quiet .btn-danger .btn-icon .pill* .overline .meta .row .row-title .card-surface .scrim-hero .toast .input`), primitives in `web/src/components/ui.tsx` (`Button`, `Pill`/`LivePill`/`HealthPill`, `Overline`, `Meta`, `Data`, `EmptyState`, `ToastHost`, `Skeleton`, `Spinner`, `useEscapeClose`). Rules: ONE `.btn-primary` per screen (per dialog inside a dialog), bone-white focus ring + halo (never colour alone), SoClose rose `--identite` (`#f9a8d4`, Doux `#b83280`) = identity only (hero `.thread`, brand point, active door in TopBar/Dock; fleet rule, owner 2026-10-09: Sentinel House keeps mint, the SaaS products wear the rose), mint = OK state only, red = live/alert, uppercase only in `.overline`/`.pill`, text never under 12 px, sentences <= 12 words, verb-first buttons, no jargon on screen. Fonts: IBM Plex Sans + Mono, self-hosted. Measured by `test/verify-design.mjs` (contract attributes: cards `data-card` + `data-key=<stream url>`, hero `data-hero`, guide `data-prog` in `data-prog-row`, empty states `data-empty`; `--tokens <charte.css>` compares with Sentinel House, local only).
- **Home** -- `Home.tsx`: a hero (at most 45 % of the screen, artwork by the channel's own category via `featured[].heroCategory`, no rotation) -> rows of cards with the title above (`Rail.tsx`, `ChannelCard.tsx`) -> Browse row of categories -> footer. Country/language/category filters live in `FilterBar.tsx`. Top bar: `TopBar.tsx` + `AvatarMenu.tsx`; phones get `Dock.tsx`. Brand/social assets: `/social-kit.html` + `/social/*`.
- **Devices and Back** -- `web/src/lib/device.ts` (`isTV()`: `?tv=1` persisted in `nw.tv`, TV user agents, no-pointer devices; `applyDeviceFlags()` sets `data-tv`; `prefersReducedMotion()`): never re-implement it. `web/src/lib/spatialNav.ts`: D-pad spatial focus inside the top layer, every overlay is a history entry (Back closes it), focus restored to `[data-key=<url>]` of the card that launched the player, ONE Back contract: `window.__nwBack()` (Escape, Backspace, GoBack, keyCodes 4 / 461 / 10009). `/chaine/<id>?play=1` autostarts muted. `window.__nwLastPlayedKey` = last played stream url.
- **i18n** -- `web/src/lib/i18n.ts` is the core (`useT()`, `t(key, vars)`, `t.n()`, `fmtNum`, `fmtTime`, `fmtDate`, `fmtAge`, browser-language detection with English fallback, Intl locale = UI language). Keys live in fragments `web/src/lib/i18n/{home,shell,pages,logic}.ts` (`satisfies Dict`, EN + FR + RU all required). Data (channel names, titles, countries) is wrapped with `translate="no"` (`Data`). Every user-visible string goes through `t()`.
- **Web correctness** -- `web/src/lib/fresh.ts` `freshChannel()` re-resolves a stored channel through the frozen `/api/catalog/channel/:id` before play/mosaic when its signed `proxyUrl` is about to expire; stores persist stable channel fields only (never `proxyUrl`); `sw.js` never touches `/api`, the proxy or cross-origin media; it caches hashed `/assets` cache-first and other static files network-first (only a same-origin 200 that is not HTML), and handles navigations only for `mode === 'navigate'`.
- **Stream proxy security** -- `/api/proxy` relays only server-signed URLs (`signing.js`: HMAC over `v2`, expiry (2 h), url, ua, ref, root stream, lan); unsigned/tampered = 403, taken-down root = 410. Response headers are an ALLOWLIST (no upstream cookies/CSP/HSTS/CORS), media content types forced, `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`; only real HLS bodies (`#EXTM3U`) are rewritten; mounted BEFORE `gateContent` and never renews a token; not compressed. Documents carry `X-Frame-Options: DENY` + `frame-ancestors 'none'` (Express path; nginx in prod, DEPLOY.md).
- **Health** -- `server/src/health.js`: shared verdicts (`/api/catalog/check` probes only known catalog URLs, with the catalog's own UA/Referer; `force` admin-only), optional background sweep (shallow at boot, deep = real segment download on the interval). `/api/health` = `{ok, uptimeS, catalog:{total, ageMin, building, ...}, epg, streams}`, 503 when the catalog is empty or older than 2 x TTL; user counts admin-only.
- **Custom sources** -- `server/src/sources.js` imports M3U (URL or pasted text), parses `#EXTINF`/`#EXTVLCOPT`/tvg-* into the normalized Channel shape, merges via `catalog.setCustomItems()`. A failed refresh keeps the last good data. Public `/api/sources` hides urls/errors; admin `/api/admin/sources` shows them.
- **EPG** -- `server/src/epg.js` parses XMLTV (xml/.gz, linear parser, streaming size cap), indexes programmes by normalized tvg-id (== `channel.channelId`), serves now/next, day, grid and throttled programme search; refreshes every 6 h. The production guide is grabbed nightly on the VPS by `scripts/epg/grab.sh` (atomic swap of `/var/www/neowatch/epg.xml.gz`).
- **Logo relay** -- `server/src/img.js`, `GET /api/img?u=` (mounted before `authenticate`): relays ONLY URLs the server vends (`catalog.getLogoMeta`, `radio.isKnownRadioIcon`; 404 otherwise), via `safeFetch` (a custom source's LAN logo host only, `privateHost`), 10 s, 1 MB, magic-byte sniffed raster types (SVG refused), our headers only, LRU 32 MB / 1000 + 10 min negative cache, imgur 640 px WebP rendition when smaller, 204 for an `<img>` on failure (no console error). Web: `imgSrc()` (`web/src/lib/img.ts`), `LogoImg` (`ui.tsx`). Film posters (archive.org) stay direct. Tests: `test/img-test.mjs`.
- **Security** -- `server/src/netguard.js` (SSRF: DNS-pinned undici agent, per-hop revalidation, private/NAT64/6to4 ranges blocked), `server/src/ratelimit.js`. Keep these on all user-supplied-URL paths (proxy, health, sources, epg, films, radio).
- **Sliding sessions (auth.js)** -- `authenticate` renews a valid token older than `JWT_RENEW_AFTER` (default half its lifetime) via the `X-Renewed-Token` header (+ `token` on `GET /auth/me`); `web/src/lib/api.ts` swaps it in (same `sub`, `iat` not older than the held one, else ignored). Revocation = `user.tokenVersion` (claim `tv`), bumped on password change / admin reset / disable; call `revokeTokens(user)` from any new path that must sign a user out. **Any response that carries a token goes through `handToken()`**: it sets `Cache-Control: no-store` and drops the request validators (full 200, never a 304) so the browser cache can never replay one user's token to the next user of the same browser/TV (`/api/config` has the same ETag for everyone). Never renew outside `resolveToken()` success, never log a token. `jwt.verify` pins `algorithms: ['HS256']`. **Never renew on `/api/proxy`** (`isProxyPath`): a stream response is the upstream's, and `proxy.js` drops an upstream `X-Renewed-Token`. User-specific routers (`/api/auth`, `/api/me`, `/api/admin`) are `privateNoStore`. Client guards (`adoptToken()`): same `sub`, `tv` and `iat` not older than the held token, and localStorage re-read right before writing (a Safari bfcache page must not overwrite a session that moved under it). `authStore` drops the token on a **401 only**; any other `/auth/me` failure (502 during a deploy, offline TV) keeps it and retries with backoff. TV pairing is a token in reserve: `approve` records the approver's `tokenVersion`, `poll` refuses if it moved, and `revokeTokens()` purges that user's pending pairings. So the guarantee holds on every path: **only a password change, an admin password reset or a disable kills a session**. Known trade-off, accepted by the owner (06/10/2026, no absolute session cap): a renewed token's OLD copy stays valid until its own `exp` and can itself be renewed, so a stolen token that is used at least once per threshold lives until the user's `tokenVersion` is bumped. Two concurrent `PUT /auth/password` (or a password change racing an admin reset): exactly one wins, the other gets 409 (the stored hash moved while it hashed). Tests: `test/session-test.mjs`.
- **Rule:** any new user-supplied URL must pass `assertPublicHost()` and a size cap; any new content route must respect `gateContent`, the takedown blocklist and custom-source locking.
