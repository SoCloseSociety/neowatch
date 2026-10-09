# NEOWATCH -- Deployment (helper VPS)

Live: **https://neowatch.soclose.co**. Deploying, nginx changes and APK publishing all need the
owner's explicit go-ahead.

## Where it runs
- **Host:** helper-vps (`212.227.202.92`, ssh alias `helper-vps`, root). Shared with other soclose.co projects.
- **Node:** **20.20.2**. undici stays on major **6** (undici 7/8 need Node 22 and crash with `markAsUncloneable is not a function`).
- **API:** systemd service `neowatch` on `127.0.0.1:8790`, `MemoryMax=768M` (steady ~100 MB RSS).
  Layout under `/root/neowatch`: `package.json` + `package-lock.json` + `node_modules/` (root of the
  install), `server/package.json`, `server/src/`, `server/.data/` (accounts), `server/.cache/`
  (catalog + health), `.env` (secrets), `.rollback/` (previous release). Logs: `/var/log/neowatch.log`.
- **Static web:** `web/dist` served by host **nginx** from `/var/www/neowatch`, plus files written
  on the VPS: `epg.xml.gz` (nightly guide) and `app.apk` (Android shell).
- **nginx vhost:** `/etc/nginx/sites-enabled/neowatch.soclose.co`: serves static, proxies `/api/` to
  `127.0.0.1:8790` (`proxy_buffering off` for live streams), gzip for js/css/json/svg. The web
  manifest and the woff2 fonts go out as `application/octet-stream` (the manifest is therefore
  not gzipped) until the "Static files" lines of the nginx checklist below are applied.
  TLS by Let's Encrypt (certbot `--nginx`, `certbot.timer`). HTTP -> HTTPS 301.
- **Guide grabber:** `/root/epg/` (`grab.sh`, `curate-fr.sh`, `merge.mjs`, `curated/`, the
  iptv-org/epg clone in `epg/`), cron `12 4 * * * /root/epg/grab.sh >> /root/epg/grab.log 2>&1`.
  Repo copy: `scripts/epg/` (see its README).
- **No Docker build on the VPS** (avoids RAM spikes): the web app is built locally and rsynced.

## Deploy

```bash
bash scripts/deploy.sh                 # full deploy
bash scripts/deploy.sh --rollback      # put back the previous release
bash scripts/deploy.sh --apk FILE      # full deploy + publish FILE as /app.apk (owner go-ahead)
```

What `scripts/deploy.sh` does, in order:

1. **Local gate:** refuses uncommitted changes under `server/`, `web/` or the manifests
   (`--allow-dirty` to override), syntax-checks the EPG scripts, runs `npm test`
   (`--skip-tests` to skip, not recommended).
2. **Build** the web app (`npm run build`: typecheck + Vite).
3. **Rollback copy** on the VPS, one level, in `/root/neowatch/.rollback/`: `server/src`, the
   manifests and lockfiles, `node_modules`, the web root (minus `epg.xml.gz` and `app.apk`), and
   the live APK when `--apk` replaces it.
4. **Dependencies:** ships the root `package.json` + `package-lock.json` + `server/package.json`
   and runs `npm ci --omit=dev -w server` in `/root/neowatch`, so production runs exactly the
   versions CI tested. The old VPS-local `server/package-lock.json` and `server/node_modules` are
   removed (they would shadow the root install). If `npm ci` fails, the previous manifests and
   `node_modules` are restored and the deploy stops before touching the code.
5. **Server code:** `rsync --delete ./server/src/` only. `.data`, `.cache` and `.env` are never in
   the source path.
6. **Web:** `rsync --delete ./web/dist/` with filter rules. A protect rule (`P`) only stops
   `--delete`; it never blocks a transfer:
   - `P /epg.xml.gz` (+ its temp file): the guide is written on the VPS;
   - `- /app.apk`: never shipped from `web/dist` (a stale local copy may sit in `web/public`),
     and therefore kept; only `--apk FILE` replaces it (uploaded as `app.apk.new`, then renamed);
   - `.well-known/` transfers from dist (`assetlinks.json` is tracked); `acme-challenge/` is protected.
7. **EPG scripts:** `scripts/epg/{grab.sh,curate-fr.sh,merge.mjs}` -> `/root/epg/` (no delete, executable).
8. **Restart + verify:** `systemctl restart neowatch`, then polls `https://neowatch.soclose.co/api/health`
   until `ok:true` and `catalog.total > 0` (2 min max), checks the frozen routes answer 200
   (`/api/catalog/meta`, `/api/catalog/channel/<id>`, `/api/epg/now`, `/api/epg/day`, `/chaine/<id>`,
   `/`, `/.well-known/assetlinks.json`, `/app.apk`) and prints `npm ls compression undici express`
   from the VPS. On failure it prints the rollback command.

`NEOWATCH_HOST` and `NEOWATCH_URL` override the ssh alias and the public origin.

**Never** `rsync --delete ./server/ ...` (whole dir): it deletes `server/.data` (all accounts).
**Never** `rsync --delete ./web/dist/ ...` without the filter rules: it deletes the hosted guide and APK.

## Configuration notes
- Prod `.env` holds a strong `JWT_SECRET` (required in production), `ADMIN_EMAIL`, a generated
  `ADMIN_PASSWORD`, `REQUIRE_AUTH=false` (public freemium), `TRUST_PROXY=1`,
  `BILLING_PROVIDER=mock`, `HEALTH_SWEEP=true`, `EPG_DEFAULT_URL=https://neowatch.soclose.co/epg.xml.gz`.
  Change the admin password from the account panel after first login.
- **Mock billing is closed in production** (`NODE_ENV=production`): checkout answers that payments
  are not open and `/api/config` reports `billing.checkout:false`. To run a deliberate free beta
  with instant Premium, set `ALLOW_MOCK_BILLING=true` (owner's call).
- `/api/health` answers **503** when the catalog is empty or older than 2 x `CATALOG_TTL_HOURS`;
  Neo (`bot/config.py`) alerts on any status >= 500. User counts are admin-only.
- **Takedown:** the admin blocklist hides a stream everywhere; the proxy answers **410 Gone** for
  it, including links already handed to players.
- Service: `systemctl {status,restart,stop} neowatch` · logs `tail -f /var/log/neowatch.log`.
- To close the site to signed-in users: `REQUIRE_AUTH=true` (+ `ALLOW_REGISTER=false`) in
  `/root/neowatch/.env`, then restart.
- Sessions slide: with `JWT_TTL=30d` a device used at least once every 15 days stays signed in
  (set `JWT_RENEW_AFTER=1d` to renew daily instead). `JWT_RENEW_AFTER=0`, a value >= `JWT_TTL`, or
  a unit-less `JWT_TTL`/`JWT_RENEW_AFTER` (read as milliseconds) are **warned at boot, not
  refused**: read the boot log after a config change. An unused device still expires at the TTL.
  There is **no absolute session cap** (owner decision, 06/10/2026): a token that keeps being used
  (including a stolen one) lives until a password change, an admin password reset or a disable,
  on every path, including a TV pairing approved but not yet collected.
- Renewing responses and every user-specific response (`/api/auth/*`, `/api/me/*`,
  `/api/admin/*`) are `Cache-Control: private, no-store`; a renewing response is never a 304.
  `/api/proxy` never carries a token (ours or the upstream's).

## nginx checklist (prod edits need the owner's explicit OK, then `nginx -t` + reload)

On the `/api/` location:
- no `proxy_cache` (nor `proxy_store`): a cached renewing response would hand one user's token to the next;
- no `proxy_hide_header X-Renewed-Token`, no `proxy_ignore_headers Cache-Control`, no `proxy_hide_header Cache-Control`;
- `proxy_buffering off` stays (live streams).

Quick check: `ssh helper-vps 'grep -nE "proxy_cache|proxy_store|proxy_hide_header|proxy_ignore_headers" /etc/nginx/sites-enabled/neowatch.soclose.co'` must print nothing.

**Document headers.** Express sends them on the Docker/self-host path; in production nginx serves
the documents, so add them in the HTTPS `server` block (with `always`). Note that an `add_header`
inside a `location` replaces every `add_header` inherited from the `server` block: repeat them in
any location that declares its own.

```nginx
# NEOWATCH: nothing may frame the app (clickjacking on /link?code= would approve a TV pairing).
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age=31536000" always;
```

Do not add `includeSubDomains`/`preload` without checking every `*.neowatch.soclose.co` host.
The stream proxy sets its own sandbox CSP on relayed bytes; these headers do not affect playback.
Check after reload: `curl -sI https://neowatch.soclose.co/ | grep -iE "x-frame|content-security|nosniff|strict-transport|referrer"`.

Simplest way to repeat them: put the five lines above in `/etc/nginx/snippets/neowatch-headers.conf`
and write `include snippets/neowatch-headers.conf;` in the `server` block and in every location
below that has its own `add_header`.

**HTML must revalidate (stale app after a deploy).** Today nginx sends the HTML (`/`, every SPA
route through the `/index.html` fallback) with an ETag and no `Cache-Control`, so browsers apply
heuristic freshness (about 10% of the file's age, hours for a day-old file) and the service
worker's navigation fetch gets the cached copy. After a deploy that old `index.html` asks for
hashed chunks `rsync --delete` removed: `vite:preloadError`, one reload, the same stale page,
then the crash screen. `/assets/` (hashed) stays `immutable`; only the HTML changes:

```nginx
# Every .html, including /index.html reached by "index" or the try_files fallback
# (an internal redirect runs the location match again).
location ~ \.html$ {
    add_header Cache-Control "no-cache" always;
    include snippets/neowatch-headers.conf;
}
```

Check: `curl -sI https://neowatch.soclose.co/chaine/x | grep -i cache-control` -> `no-cache`
(same for `/`), and the security headers are still there.

**Static files (types, gzip, art caching).**
- MIME types: if `grep -nE "woff2|webmanifest" /etc/nginx/mime.types` lacks them, add
  `application/manifest+json webmanifest;` and `font/woff2 woff2;` INSIDE the `types { }` block of
  `/etc/nginx/mime.types` (correct for every vhost). Never write a `types { }` block in the vhost's
  `server`: it replaces the whole inherited map (HTML would go out as the default type).
- gzip: append `application/manifest+json` to the `gzip_types` line in use (`grep -rn gzip_types
  /etc/nginx/`). A `gzip_types` in the vhost replaces the inherited list: keep the existing types.
- The art in `web/public` has fixed names (not hashed), so cache it for a week, not forever (a
  replaced tile shows up within 7 days):

```nginx
location ~* ^/(ambiance/|tiles/|hero\.webp$) {
    add_header Cache-Control "public, max-age=604800" always;
    include snippets/neowatch-headers.conf;
}
```

Check: `curl -sI -H 'Accept-Encoding: gzip' https://neowatch.soclose.co/manifest.webmanifest`
-> `application/manifest+json` + `content-encoding: gzip`; `curl -sI .../tiles/news.webp` ->
`max-age=604800`; a woff2 under `/assets/` -> `font/woff2`, still `immutable`.

## Enabling real payments (Stripe): code is ready, keys are pending
In `/root/neowatch/.env`: `BILLING_PROVIDER=stripe`, `STRIPE_SECRET=sk_live_...`,
`STRIPE_PRICE_ID=price_...` (a recurring price), `STRIPE_WEBHOOK_SECRET=whsec_...`, then
`systemctl restart neowatch`.

In the Stripe dashboard, add a webhook endpoint `https://neowatch.soclose.co/api/billing/webhook`
with these events:
- `checkout.session.completed`, `checkout.session.async_payment_succeeded` (grant once paid; SEPA pays later);
- `invoice.paid` (or `invoice.payment_succeeded`): renewals extend Premium, never downgrade;
- `customer.subscription.created`, `customer.subscription.updated`: status + period end, `cancel_at_period_end`;
- `customer.subscription.deleted`: end of Premium (a plan granted by an admin is never revoked by Stripe).

Events are signature-checked, idempotent by event id, and a persistence failure answers 500 so
Stripe retries. Cancelling from the app sets `cancel_at_period_end` (Premium stays until the end
of the paid period); deleting an account cancels its subscription.

## Enabling ads (Google AdSense)
Set `ADSENSE_CLIENT=ca-pub-xxxx` in `.env` + restart. Free users then see an AdSense unit after
giving consent; Premium users and TV screens never do.

## Android app (WebView shell): publish only with the owner's go-ahead
The app in `android/` replaces the old TWA (TCL Google TVs have no Chrome, so the TWA showed
nothing). Same package `co.soclose.neowatch.twa`, same signing key, so it installs over the old
app and `assetlinks.json` stays valid. `twa-manifest.json` is legacy (kept for history).

1. Bump `versionCode` / `versionName` in `android/app/build.gradle`.
2. Build and verify (signature fingerprint = the one in `web/public/.well-known/assetlinks.json`,
   `python3 -I android/tools/check_widgets.py` prints OK): see `android/README.md`.
3. Owner go-ahead, then publish:
   `bash scripts/deploy.sh --apk android/app/build/outputs/apk/release/app-release.apk`
   (the previous APK is kept in the rollback copy). Then set `ANDROID_APK=/app.apk` in
   `/root/neowatch/.env` and restart: `/api/config` sends `androidApk` and the install panel shows
   "Get the TV app". `web/public/tv.html` (the TV install page) links `/app.apk` directly.
4. Tell **Sentinel House** (`androidtv.py` `NAVIGATEURS_DE_TWA`, `media.py` `LIMITE_TWA`) that the
   app is now a WebView shell.

Pending external accounts only: Stripe keys, AdSense publisher id.
