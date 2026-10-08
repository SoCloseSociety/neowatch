# NEOWATCH -- Tests

Everything automated runs from the repo root. Manual checks (real TV, real phone, real payments)
are listed at the end.

## 1. Commands

| Command | What it proves | Time |
|---|---|---|
| `npm run typecheck` | web TypeScript | 10 s |
| `npm run build` | typecheck + production build (`web/dist`) | 20 s |
| `npm test` | every server suite below, on throwaway servers | 2 to 3 min |
| `node test/run.mjs contract proxy` | a subset of suites (names: `contract integration proxy account catalog session`) | |
| `node test/verify-design.mjs --keys` | every `t('key')` used in `web/src` exists in EN, FR and RU (static) | 1 s |
| `node test/verify-design.mjs <port> --pages ... --formats ... --measure --out DIR` | design rules in a real Chrome (12 px floor, one primary, contrast, focus ring, jargon, mixed languages...), one screenshot per page | 1 to 5 min |
| `npm run test:e2e` | Playwright smoke: home, search, channel page, play, guide, filter URL, language (`BASE=` the server; default: the live site, GET only) | 1 min |
| `npm audit --omit=dev --audit-level=high` | no high/critical advisory in production dependencies | 5 s |

CI (`.github/workflows/ci.yml`, Node from `.nvmrc`) runs: `npm ci`, an undici-major-6 guard,
typecheck, build, `--keys`, `npm test`, the audit, and an em dash guard. `--tokens` (comparison
with Sentinel House `charte.css`) is local only: that file is not in this repo.

## 2. The test runner (`test/run.mjs`)

- One fresh server per suite: free port, temp `DATA_DIR` (its own accounts, rate-limit counters
  and pairings), shared temp `CACHE_DIR`. Your `server/.data` and `server/.cache` are never written.
- The cache is seeded from `server/.cache` when it exists (fast, works offline). Health verdicts
  in the COPY are re-dated to now so online-only paths have data. `NW_TEST_SEED=0` forces a cold
  build from iptv-org; a cold cache is then warmed with real probes of 200 streams (5 categories).
- Offline-safe: no cache and iptv-org unreachable -> every suite is skipped with a clear message
  and exit 0 (`NW_TEST_STRICT=1` makes that a failure).
- Every setting a developer `.env` could carry is pinned for the throwaway servers
  (`NODE_ENV=test`, `ALLOW_PRIVATE_SOURCES=true` for the crafted local upstreams, mock billing,
  no guide URL, no sweep...). The session suite gets its own server with `JWT_TTL=8s JWT_RENEW_AFTER=3s`.
- `KEEP=1` keeps the temp dir (server logs, data) for inspection; it is also kept on failure.

## 3. Suites

| Suite | File | Covers | Checks |
|---|---|---|---|
| contract | `test/contract-test.mjs` | the FROZEN API (NEO_CONNECTOR.md): health, meta, channels?q, channel/:id fields + `canonicalId` + `?channelId=`, `/chaine/<id>` (+ `?play=1`), epg/now + epg/day shapes with a pasted XMLTV, unsigned proxy 403 | 34 |
| integration | `test/integration-test.mjs` | config, catalog, auth and roles, admin gating, billing, signed proxy URLs, preferences (Premium feature), password change, M3U sources, guide, health check, home rails, language, sort and search, pagination, channel page, robustness | 66 |
| proxy | `test/proxy-test.mjs` | lot S1: SSRF ranges, bounded reads, signing key, signature scope (ua/ref/root/lan), header allowlist + forced content type, range, playlist sniffing/rewrite, manifest caps + micro-cache, mid-stream failure, LAN custom sources, health probes, takedown 410 at serve time, radio links | 70 |
| account | `test/account-test.mjs` (`S3_MODE=dev`) | lot S3: typed and capped inputs, roaming favorites/mosaic, prefs no-store, GDPR export, pairing caps, sources and guide projections, keep-last-good, XMLTV parser, films ids, save-chain recovery, plan copy, mock billing grant/cancel/resume, write throttles | 83 |
| catalog | `test/catalog-test.mjs` (`MODE=live`) | lot S2: JSON 404, no stacks, bounded paging, health shape and privacy, document headers, `/assets` 404, localized rails, spotlights online only, id resolution (exact, alternate, `?channelId=`), blocklist on alternates, proxy not compressed, failed save -> 500 | 45 |
| session | `test/session-test.mjs` | sliding sessions: renewal, expiry, revocation (`tokenVersion`), demoted admin, password races (409), TV pairing, no-store, no 304 replay, HS256 pinned, no token on `/api/proxy`, boot warnings, no token in the server log | 83 |

The catalog and account suites have other modes for one-off runs (each file's header explains
the server to start): `MODE=fake|stale|empty` (crafted iptv-org upstream, outage, no cache) and
`S3_MODE=prod|stripe` (mock billing closed in production; Stripe checkout and signed webhooks
against a fake Stripe API). Running a suite by hand:

```bash
PORT=8931 DATA_DIR=/tmp/nw-data CACHE_DIR=/tmp/nw-cache ADMIN_EMAIL=a@a.local ADMIN_PASSWORD=test-password-123 \
  JWT_SECRET=test-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx ALLOW_PRIVATE_SOURCES=true node server/src/index.js
BASE=http://localhost:8931 ADMIN_EMAIL=a@a.local ADMIN_PASSWORD=test-password-123 \
  JWT_SECRET=test-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx node test/proxy-test.mjs
```

Sessions by hand: start the server with `JWT_TTL=8s JWT_RENEW_AFTER=3s ALLOW_PRIVATE_SOURCES=true
JWT_SECRET=<test> ... 2>&1 | tee /tmp/nw.log`, then `BASE=... TTL_S=8 RENEW_S=3 JWT_SECRET=<test>
SERVER_LOG=/tmp/nw.log ADMIN_EMAIL=... ADMIN_PASSWORD=... node test/session-test.mjs`. Without
`JWT_SECRET` the algorithm and proxy sections are skipped; without `ALLOW_PRIVATE_SOURCES=true`
the proxy section is skipped (never counted as a failure).

## 4. Manual checks (not automated)

- Play an HLS channel (direct), a CORS-blocked one (proxy fallback) and a YouTube channel; quality,
  audio and subtitle menus, PiP, fullscreen.
- Multi-view: add 2 to 9 channels, move the sound, remove one, clear.
- TV (`?tv=1` or a real TV): D-pad reaches every control, the focus ring is always visible, Back
  closes the top overlay then goes back, focus returns to the card that started the player.
- Phone: the dock, install to the home screen, the PWA opens offline on the app shell.
- QR sign-in: the TV shows a code, the phone approves, the TV is signed in.
- Android shell and widgets: the checklists in `android/README.md` (owner, real devices).
- Stripe with real keys (test mode first): checkout, renewal, cancel at period end, deletion.
- AdSense with a real publisher id: the consent prompt, then an ad for a free user only.
- `docker compose up --build` with a `.env` holding `JWT_SECRET`: the app on `PORT`, data kept
  across `docker compose down && up`, `docker inspect --format '{{.State.Health.Status}}' neowatch`
  reports `healthy`.
