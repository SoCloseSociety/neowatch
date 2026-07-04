# CLAUDE.md -- NEOWATCH

> Operating manual for any AI assistant working in this repo. Read it fully before touching code.
> House rule: never use em dashes in any output. Use `--` instead.

## 1. Project Identity

- **Name:** NEOWATCH
- **Role:** Self-hostable live-TV aggregator + player. Watches the world's publicly available free live channels (sport/football, news, films, kids, music, docs, every iptv-org category) with a fast HLS player, a multi-screen mosaic, health badges, favorites, themes, and a SaaS-style admin/user layer.
- **Detected stack (versions pinned in package.json):**
  - Frontend: React 18.3 + TypeScript 5.6 + Vite 6 + Tailwind 3.4, Zustand 5 (state), hls.js 1.5 (playback), react-router-dom 6, lucide-react (icons), clsx. Installable PWA (manifest + service worker).
  - Backend: Node 20+ (ESM), Express 4, jsonwebtoken + bcryptjs (auth), compression, cors, dotenv. No database -- JSON-file persistence for users; disk cache for the catalog.
  - Data source: the public **iptv-org** API (`https://iptv-org.github.io/api/`) -- channels, streams, categories, countries, languages, logos, feeds.
- **Architecture overview:**
  - Monorepo with npm workspaces: `server/` (API + stream proxy + catalog cache + auth) and `web/` (React SPA / PWA).
  - Dev: `web` on Vite port **5273**, `server` on port **8787**; Vite proxies `/api` -> server. Run both with `npm run dev`.
  - Prod: `npm run build` outputs `web/dist`; the Express server serves it statically and exposes `/api`. Single process, single port (8787).
  - External dependency: iptv-org API (fetched + cached to `server/.cache` with TTL). The catalog is normalized in memory once, then queried/paginated per request.
  - The stream **proxy** (`/api/proxy`) only handles CORS/geo-locked streams and streams needing a custom User-Agent/Referrer. The web app plays DIRECT first and falls back to the proxy -- this keeps server bandwidth low on a shared host.
- **Critical files -- do not change without a written plan first:**
  - `server/src/catalog.js` -- the iptv-org normalization + facet building. Subtle joins (streams<->channels<->logos<->feeds). Breaking it empties the whole app.
  - `server/src/proxy.js` -- HLS manifest rewriting. A wrong rewrite breaks playback for proxied streams.
  - `web/src/components/HlsVideo.tsx` -- the player core (hls.js config + direct/proxy fallback). Tuned for fast start + low lag.
  - `server/src/auth.js` -- token signing, password hashing, role gates. Security-sensitive.

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
  - `curl localhost:8787/api/health` returns ok; `/api/catalog/meta` returns a non-zero `total`.
  - `/api/catalog/channels?category=sports` returns items; the stream health endpoint returns mixed online/offline.
  - Open the app, play one HLS channel and one YouTube channel, open the multi-screen mosaic.
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
  - Server = thin route handlers + dedicated modules (`catalog`, `proxy`, `health`, `auth`, `config`). No ORM; swap the JSON user store by reimplementing `load()/save()` in `auth.js` only.
  - Web = store-per-domain (auth / settings / catalog / player / ui). Components are presentational and read from stores. Theming via CSS variables (`--accent`, `--surface`, ...) set by `applyTheme()`.
  - Server-side filters (category/country/language/q/foot) trigger a reload; pure client filters (online-only, hide-geo, favorites) are applied in `applyClientFilters`.
- **Known fragile / tech-debt areas:**
  - Channel `id` is index-based and NOT stable across catalog rebuilds. Favorites/recents key on the stream **url** (stable) -- keep it that way.
  - The web bundle is ~750 kB (hls.js). Code-split if it grows.
  - Many streams are geo-blocked or part-time ("Not 24/7"); the health badge mitigates this but a green badge only means reachable now.
  - No rate limiting on `/api/proxy` or `/api/catalog/check` yet -- add before exposing publicly at scale.
  - Stream proxying consumes host bandwidth. Keep "direct-first, proxy-fallback" intact on shared deploys.
- **Dev / build / run commands:**
  - `npm install` (root, installs both workspaces)
  - `npm run dev` -- server + web with hot reload (web: http://localhost:5273)
  - `npm run build` -- typecheck + build web to `web/dist`
  - `npm start` -- production: Express serves `web/dist` + `/api` on port 8787
  - `npm run typecheck` -- web TS check
  - Docker: `docker compose up --build` (serves the built app on `PORT`)
- **Critical env vars (see `.env.example`):**
  - `PORT` (8787), `CATALOG_TTL_HOURS` (12), `IPTV_API_BASE`, `HIDE_NSFW` (true)
  - `REQUIRE_AUTH` (false = public dev; true = SaaS gate), `ALLOW_REGISTER`
  - `JWT_SECRET` (CHANGE in prod), `JWT_TTL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (first-boot admin; a random password is printed once if unset)
  - `ALLOWED_ORIGINS` (CORS allowlist for a deployed instance)

## 7. Core Principles (global)

- **Simplicity first:** every change as simple as possible, minimal code impact.
- **No laziness:** find root causes, no temporary patches, senior-developer standards.
- **Minimal impact:** touch only what is necessary; avoid introducing regressions.
- **Never use em dashes** in any output -- use `--`.
- **Ollama-first** for any local LLM calls (an RTX 4070 is available). Do not add a paid cloud LLM dependency without asking.
- **Legality:** NEOWATCH only aggregates publicly available free streams (iptv-org) plus playlists the operator supplies. Do not add scrapers for paywalled/pirated content. Premium monetization charges for the SERVICE (curation, EPG, multi-screen, no ads, the user's own playlists), not for reselling third-party copyrighted streams.

## 8. Modules added after v1 (read before touching)

- **Monetization / tiers** -- `server/src/catalog.js` computes `tier` (free|premium) per channel: premium = categories in `PREMIUM_CATEGORIES` (default sports,movies,series) + custom M3U sources. Premium stream URLs are stripped (`locked:true`) from `/api/catalog/*` for non-premium users, and the proxy returns 402 for premium URLs. `server/src/billing.js` = plans + checkout (`mock` instant / `stripe` seam) + admin grant. `server/src/auth.js` holds `plan`/`planExpires`, `isPremium()`, `setPlan()`. Web: `Pricing.tsx` (funnel), `AdBanner.tsx` (real AdSense unit for free users only -- the premium upsell now lives in `PromoStrip.tsx`), lock UI in `ChannelCard.tsx`, CTA in `TopBar.tsx`.
- **Home design (claude.ai/design "NeoWatch Home")** -- the left **sidebar was removed**; the app is full-width with a centered `max-w-[1760px]` container. Fonts: Manrope + JetBrains Mono. Tokens: `live`/`gold`/`ok` colours + cyan/violet radial bg. `Home.tsx` = cinematic hero (ken-burns ambiance + EPG now/next + progress + live-chat showcase) -> category art tiles -> rails (`Rail.tsx`: card / poster / resume variants, EPG-enriched, D-pad arrow nav) -> footer. `PromoStrip.tsx` = dismissible banner below the top bar (`sessionStorage` key `nw.promo.dismissed`; hidden on `/admin`). Country/language/category filters moved from the sidebar into `FilterBar.tsx`. Brand/social assets: `/social-kit.html` + `/social/*` exports.
- **Custom sources** -- `server/src/sources.js` imports M3U (URL or pasted text), parses `#EXTINF`/`#EXTVLCOPT`/tvg-* into the normalized Channel shape, merges via `catalog.setCustomItems()`. Admin UI in `AdminDashboard.tsx`.
- **EPG** -- `server/src/epg.js` parses XMLTV (xml/.gz), indexes programmes by tvg-id (== `channel.channelId`), serves now/next + programme search (joined to playable channels). Web: now/next strip in `Player.tsx`, `ProgramSearch.tsx`, admin XMLTV UI.
- **Security** -- `server/src/netguard.js` (SSRF), `server/src/ratelimit.js`. Keep these on all user-supplied-URL paths (proxy, health, sources, epg).
- **New env vars:** `PREMIUM_CATEGORIES`, `CUSTOM_PREMIUM`, `BILLING_PROVIDER` (mock|stripe), `PREMIUM_PRICE`/`PREMIUM_CURRENCY`/`PREMIUM_PERIOD_DAYS`, `ADSENSE_CLIENT`, `STRIPE_SECRET`/`STRIPE_PRICE_ID`, `TRUST_PROXY`, `ALLOW_PRIVATE_SOURCES`. Stripe + AdSense need the operator's keys (pending) -- mock billing + an upsell banner work without them.
- **Rule:** any new user-supplied URL must pass `assertPublicHost()` and a size cap; any new content route must respect `gateContent` + premium locking.
