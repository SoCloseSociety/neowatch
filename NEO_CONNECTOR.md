# NEO_CONNECTOR -- NEOWATCH

How NEOWATCH plugs into the wider "neo" ecosystem and how other apps/devices integrate with it. NEOWATCH is self-contained (no external services required to run), so "connecting" means consuming its HTTP API or embedding its player.

## What NEOWATCH exposes

Base URL: `http://localhost:8787` (dev) or your deployed origin. Everything lives under `/api`.

### Public / catalog (gated only when `REQUIRE_AUTH=true`)
- `GET /api/config` -- runtime config the web app reads (auth mode, billing, ads, epg, premium categories).
- `GET /api/health` -- liveness + user stats.
- `GET /api/catalog/meta` -- categories / countries / languages facets + totals + free/premium counts.
- `GET /api/catalog/channels?category=&country=&language=&q=&foot=1&page=&limit=` -- paginated channels. Premium channels are returned with `locked:true` and no `url` for non-premium callers.
- `GET /api/catalog/channel/:id` -- one channel (stable id).
- `POST /api/catalog/check { items:[{id,url,ua,ref}] }` -- live reachability (LIVE/OFFLINE badges).
- `GET /api/proxy?url=&ua=&ref=` -- CORS/geo stream proxy (rewrites HLS manifests). SSRF-guarded; 402 on premium URLs for non-premium callers.
- `GET /api/epg/now?ids=tvgId,...` and `GET /api/epg/search?q=` -- program guide now/next + programme search.
- `GET /api/sources` / `GET /api/epg/sources` -- configured custom playlists / EPG sources.

### Auth / billing
- `POST /api/auth/register|login`, `GET /api/auth/me`, `PUT /api/auth/favorites`.
- `GET /api/billing/plans`, `POST /api/billing/checkout|cancel` (Bearer token).

### Admin (Bearer token, role=admin)
- `/api/admin/users` CRUD + `/api/admin/users/:id/plan` (grant/revoke premium).
- `/api/admin/sources` (M3U), `/api/admin/epg` (XMLTV), `/api/catalog/refresh`.

Auth = `Authorization: Bearer <JWT>` from login/register.

## Integration patterns

- **Another neo app consuming channels:** call `GET /api/catalog/channels` (+ `?q=`/`?category=`) and play `item.url` with any HLS player. Use `/api/proxy?url=...` when CORS/geo blocks direct playback. Respect `locked` (premium) items.
- **Embedding the player:** the web app is a standalone PWA; iframe or link to the deployed origin. Deep-state (current channel) is in-app, not URL-routed, by design.
- **Feeding your own sources:** push provider playlists via `POST /api/admin/sources {name,url|text}` and EPG via `POST /api/admin/epg {name,url}`. They merge into the same catalog and API.
- **Device install:** PWA (Add to Home Screen) on Android/iPhone/desktop; TV browsers via the responsive + D-pad-focus UI; wrap as a TWA for Android TV / Play Store (roadmap).

## Pending external connectors (operator keys required)
- **Stripe** (`BILLING_PROVIDER=stripe`, `STRIPE_SECRET`, `STRIPE_PRICE_ID` + webhook) -- real subscriptions. Until set, `mock` billing activates premium instantly for local/self-host use.
- **Google AdSense** (`ADSENSE_CLIENT=ca-pub-...`) -- real ads for free accounts. Until set, an upgrade upsell banner is shown instead.
- **Local LLM (Ollama-first, RTX 4070)** -- not used yet; reserved for future features (smart search, recommendations). Do not add a paid cloud LLM without asking.

## Notes
- No database: users/sources/epg persist as JSON under `server/.data`; catalog cache under `server/.cache`.
- Keep it self-host-friendly: direct-first playback (proxy only as fallback) so a shared host serves mostly JSON + the static bundle.
