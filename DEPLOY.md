# NEOWATCH -- Deployment (helper VPS)

Live: **https://neowatch.soclose.co**

## Where it runs
- **Host:** helper-vps (`212.227.202.92`, ssh alias `helper-vps`, root). Shared with other soclose.co projects.
- **API:** Node (systemd service `neowatch`) on `127.0.0.1:8790`, capped at `MemoryMax=768M` (steady ~100 MB RSS). Code at `/root/neowatch/server`, env at `/root/neowatch/.env`, logs at `/var/log/neowatch.log`.
- **Static web:** built `web/dist` served by host **nginx** from `/var/www/neowatch`.
- **nginx vhost:** `/etc/nginx/sites-enabled/neowatch.soclose.co` -- serves static, proxies `/api/` to `127.0.0.1:8790` (`proxy_buffering off` for live HLS). TLS via Let's Encrypt (certbot `--nginx`, auto-renew via `certbot.timer`). HTTP->HTTPS 301.
- **No Docker build on the VPS** (avoids RAM spikes): web is built locally and rsynced; only the small server deps are `npm install`ed on the box.

## Resource footprint (good neighbour)
- ~100 MB RAM steady (cap 768 MB). The VPS had ~2 GB available + 5.9 GB swap; other projects unaffected.
- Disk: a few hundred MB (code + cached iptv-org catalog under `server/.cache`).
- `HEALTH_SWEEP=false` on prod by default (no constant outbound probing); trigger on demand from the admin panel ("Tester les chaînes").

## Redeploy (from this repo, locally)
Use the safe deploy script -- it guarantees accounts/favorites/EPG/APK survive every push:
```bash
bash tasks/deploy.sh
```
What it does (and why, so you never wipe live state by hand):
```bash
npm --workspace web run build
# server: src + package.json only -- never the whole server/ dir, so .data (accounts),
# .cache, node_modules and ../.env (JWT_SECRET, EPG_DEFAULT_URL) are left untouched.
rsync -az --delete -e ssh ./server/src ./server/package.json helper-vps:/root/neowatch/server/
# web: --delete is fine BUT must exclude operator-hosted assets that are NOT in web/dist,
# otherwise every deploy deletes them.
rsync -az --delete --exclude='epg.xml.gz' --exclude='app.apk' --exclude='.well-known/' \
  -e ssh ./web/dist/ helper-vps:/var/www/neowatch/
ssh helper-vps 'cd /root/neowatch/server && npm install --omit=dev --no-audit --no-fund && systemctl restart neowatch'
```
(If server deps changed, the `npm install` picks them up. Web changes need only the dist rsync.)
**Never** `rsync --delete ./server/ ...` (whole dir) -- that deletes `server/.data` (all accounts).
**Never** `rsync --delete ./web/dist/ ...` without the excludes -- that deletes the hosted EPG + APK.

## Important
- **undici is pinned to ^6** -- the VPS runs Node 20.20.2, and undici 7/8 require Node 22+ (crash: `markAsUncloneable is not a function`). Do not bump it past 6 unless the VPS Node is upgraded.
- Prod `.env` holds a strong `JWT_SECRET` (required in prod), `ADMIN_EMAIL=sin.soclose@gmail.com`, a generated `ADMIN_PASSWORD`, `REQUIRE_AUTH=false` (public freemium), `TRUST_PROXY=1`, `BILLING_PROVIDER=mock`. Change the admin password from the account panel after first login.
- Service: `systemctl {status,restart,stop} neowatch` · logs `tail -f /var/log/neowatch.log`.
- To gate the whole site to logged-in friends only: set `REQUIRE_AUTH=true` in `/root/neowatch/.env` + restart.
## Enabling real payments (Stripe) -- code is ready, just add keys
In `/root/neowatch/.env`: `BILLING_PROVIDER=stripe`, `STRIPE_SECRET=sk_live_...`, `STRIPE_PRICE_ID=price_...` (a recurring price), `STRIPE_WEBHOOK_SECRET=whsec_...`, then `systemctl restart neowatch`.
- In the Stripe dashboard add a webhook endpoint -> `https://neowatch.soclose.co/api/billing/webhook`, events `checkout.session.completed`, `customer.subscription.deleted`, `customer.subscription.updated`.
- Checkout becomes a real hosted Stripe page; premium is granted/revoked by the webhook (signature-verified). No code change needed.

## Enabling ads (Google AdSense)
Set `ADSENSE_CLIENT=ca-pub-xxxx` in `.env` + restart. Free users then see real AdSense units (premium users never do).

## Android / Android TV (Play Store)
PWA wraps into a TWA. See `tasks/android-tv.md`. After building (PWABuilder or Bubblewrap), paste your signing SHA-256 into `web/public/.well-known/assetlinks.json` and redeploy `web/dist/`. Served at `https://neowatch.soclose.co/.well-known/assetlinks.json`.

Pending external accounts only: Stripe keys, AdSense publisher id, the app signing fingerprint.
