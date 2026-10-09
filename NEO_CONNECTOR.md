# NEO_CONNECTOR -- NEOWATCH

How other systems consume NEOWATCH: Sentinel House (the TV OS), Neo (the ops brain), the
Android shell and its widgets. Everything is plain HTTP under `/api` on the public origin
`https://neowatch.soclose.co` (dev: `http://localhost:8787`). No credential is needed for any
route in the frozen contract.

## 1. Frozen contract

These routes, fields and formats are used OUTSIDE this repo. They may gain fields; they are
never renamed, removed or re-typed. `test/contract-test.mjs` (part of `npm test` and CI) fails
the build if one of them moves.

| Route / item | Frozen fields and format | Consumers |
|---|---|---|
| `GET /api/catalog/channel/:id` | `url`, `alternates` (array), `online`, `quality`, `logo`, `channelId` (tvg-id), `name`; 404 JSON when unknown | Sentinel House `direct.py`, `media.py`; Android widgets |
| `GET /api/catalog/channels?q=` | `items[]` with `id`, `name`, `online` | Sentinel House `direct.py`, `integrations.py`; widget options screen |
| `GET /api/catalog/meta` | `categories` (array), `total`, `online` | Sentinel House `integrations.py` |
| `GET /api/img?u=<url-encoded logo>` | relays ONLY a logo the catalog/radio vends: 200 raster `image/*` with `nosniff` + sandbox CSP, 404 for any other URL, 400 without `u`; an `<img>` gets 204 when the logo is dead | Sentinel House (TV wall logos) |
| `GET /api/epg/now?ids=<tvg-id>,...` | `{ channels: { <tvg-id>: { now, next } } }` (programme = `start`, `stop`, `title`, ...) | Sentinel House `media.py`; Android "My channels" widget |
| `GET /api/epg/day?id=<tvg-id>` | `{ programmes: [{ start, stop, title, desc }], enabled }` | Sentinel House `media.py` |
| `GET /api/health` | key `ok`; HTTP status (see section 3) | Neo `bot/config.py` (monitoring) |
| Page `/chaine/<id>` | the public channel page URL | Sentinel House (app-link launch), widgets, shared links |
| Channel `id` | djb2 hash of the stream URL in base 36, lowercase letters and digits, no dash (e.g. `1tin5zz`); `server/src/util.js stableId()` | everyone above |
| Android package | `co.soclose.neowatch.twa` (the `.twa` suffix is historical) | Sentinel House `androidtv.py`; `web/public/.well-known/assetlinks.json` |

Ids are stable across catalog rebuilds. When a stream URL moves, the server keeps an alias map
(`DATA_DIR/id-aliases.json`) so an old id still resolves; the response then says which id is
current in `canonicalId`.

## 2. Additive fields and parameters (safe to use, optional to read)

| Item | Meaning |
|---|---|
| `canonicalId` on `/api/catalog/channel/:id` | The current id of the channel. Adopt it when it differs from the one you asked for. |
| `checkedAt` on channel items | Epoch ms of the health verdict behind `online` (`null` = never checked). Verdicts older than 12 h count as unknown (`online: null`). |
| `?channelId=<tvg-id>` on `/api/catalog/channel/:id` | Last-resort fallback: when the id no longer resolves, find the channel by its tvg-id. |
| `/chaine/<id>?play=1` | The channel page starts playing at once, muted (autoplay rules). |
| `featured[].heroCategory` on `/api/catalog/home` | The category the home hero illustrates. |
| `?lang=en\|fr\|ru` on `/api/catalog/home` | Localized rail titles (English by default). |
| `proxyUrl` on channel items | Opaque, signed and expiring (2 h) link through the stream proxy. Take it as is; never build a proxy URL yourself. |

## 3. Health (`GET /api/health`)

```json
{
  "ok": true,
  "uptimeS": 5321,
  "catalog": { "total": 12060, "base": 12060, "custom": 0, "updatedAt": 1791489999743, "dataAt": 1791468327535,
               "ageMin": 361, "stale": false, "building": false },
  "epg": { "enabled": true, "channels": 55 },
  "streams": { "checked": 6856, "online": 4120, "offline": 2736 }
}
```

- **200 + `ok: true`** when the catalog has channels and its data is younger than 2 x
  `CATALOG_TTL_HOURS`, or while the first build is still running at boot.
- **503 + `ok: false`** when the catalog is empty after the first build settled, or its data is
  older than 2 x TTL (iptv-org unreachable for that long). Neo treats any status `< 500` as
  healthy, so a 503 is exactly the alert.
- Always `Cache-Control: no-store`. User counts (`users`) and `catalog.lastError` are returned to
  an admin token only, never publicly.

## 4. Stream proxy and takedowns

- `GET /api/proxy` only relays URLs the server signed itself (HMAC over the URL, expiry,
  User-Agent, Referer, root stream). An unsigned or tampered link answers **403**. It is not
  behind `REQUIRE_AUTH` (players never send a token) and never carries a session token.
- **Takedown:** `POST /api/admin/blocklist {url}` hides a stream from every listing at once, and
  the proxy answers **410 Gone** for it, including playlists and segments of links already
  handed to players. `DELETE /api/admin/blocklist?url=` lifts it.
- The proxy never forwards upstream cookies, CSP, HSTS or CORS headers; it forces a media
  content type and sends `Content-Security-Policy: default-src 'none'; sandbox`.

## 5. Other routes (not frozen: may change with the web app)

- `GET /api/config`: runtime config for the web app (auth mode, billing `checkout` flag, ads, guide).
- `GET /api/catalog/home?lang=`, `GET /api/catalog/random`, `GET /api/epg/grid`, `GET /api/epg/search?q=`.
- `GET /api/films`, `GET /api/films/:id/play`, `GET /api/radios`, `GET /api/radios/countries`.
- `POST /api/catalog/check {items:[{id,url}]}`: shared reachability probe (max 40 known catalog URLs per call).
- Auth: `POST /api/auth/register|login`, `GET /api/auth/me`, `GET /api/auth/me/export` (GDPR),
  `DELETE /api/auth/me`, `PUT /api/auth/favorites|multi|password`, TV pairing
  `POST /api/auth/device/start|poll|approve`, `GET /api/auth/device/info`. Sessions slide: a
  renewed token arrives in the `X-Renewed-Token` header.
- Billing: `GET /api/billing/plans`, `POST /api/billing/checkout|cancel`, `POST /api/billing/webhook` (Stripe).
- Admin (Bearer token, role admin): `/api/admin/users`, `/api/admin/users/:id/plan`,
  `/api/admin/sources` (M3U), `/api/admin/epg` (XMLTV), `/api/admin/blocklist`,
  `/api/admin/health/sweep|stats`, `/api/admin/config`, `POST /api/catalog/refresh`.

## 6. Android shell

`android/` is a plain WebView app (no TWA: TCL Google TVs ship no Chrome), same package
`co.soclose.neowatch.twa`, same signing key, so it installs over the old TWA and the verified
app links keep working. It loads `https://neowatch.soclose.co`, appends ` NeoWatchTV/2.0` to the
user agent, and carries three phone widgets that read only the public routes above. The
web app opens every overlay (player, mosaic, menus, dialogs) as a history entry. On the
remote's Back key the shell (2.1.1+) first leaves fullscreen video, then asks the page:
`window.__nwBack()` runs the Back action and returns `true` when the page handled it (closed an
overlay, went back a page, sent a deep link with no history to Home, or showed "Press Back
again to exit" on Home) and `false` when nothing is left (a second Back within 2.6 s on Home):
the shell exits. With no hook, or no answer within 300 ms, the shell does WebView history back
(then leaves the app). Build, signing and publish steps: [android/README.md](android/README.md). It is
published at `/app.apk` only with the owner's go-ahead (`bash scripts/deploy.sh --apk FILE`).

## 7. Pending external connectors (operator keys)

- **Stripe** (`BILLING_PROVIDER=stripe`, `STRIPE_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`): see DEPLOY.md.
- **Google AdSense** (`ADSENSE_CLIENT=ca-pub-...`): ads for free accounts, only after consent.
- **Local LLM**: none used. Any future one is Ollama-first; no paid cloud LLM without asking.
