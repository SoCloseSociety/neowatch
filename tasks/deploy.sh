#!/usr/bin/env bash
# NEOWATCH safe deploy to helper-vps.
#
# Persistence guarantee: this script NEVER deletes live state between pushes.
#   - server/.data  (accounts, favorites -- users.json)   : not in the rsync source path, untouched
#   - /root/neowatch/.env  (JWT_SECRET, EPG_DEFAULT_URL)   : lives above server/, untouched
#   - server/.cache, server/node_modules                  : untouched
#   - hosted web extras (epg.xml.gz, app.apk, .well-known) : explicitly excluded from --delete
#
# undici stays pinned ^6 (Node 20.20.2 on the VPS); `npm install --omit=dev` respects package.json.
set -euo pipefail

HOST="${NEOWATCH_HOST:-helper-vps}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=20"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/5 typecheck + build web"
npm --workspace web run build

echo "==> 2/5 deploy server code (src + package.json only -- .data/.env/.cache/node_modules preserved)"
# --delete here only affects files INSIDE src/, never the sibling .data/.cache/node_modules dirs.
rsync -az --delete -e "$SSH" ./server/src ./server/package.json "$HOST:/root/neowatch/server/"

echo "==> 3/5 deploy web (preserve operator assets: epg.xml.gz, app.apk, .well-known)"
rsync -az --delete \
  --exclude='epg.xml.gz' --exclude='app.apk' --exclude='.well-known/' \
  -e "$SSH" ./web/dist/ "$HOST:/var/www/neowatch/"

echo "==> 4/5 install server deps (undici ^6 pinned) + restart"
$SSH "$HOST" 'cd /root/neowatch/server && npm install --omit=dev --no-audit --no-fund && systemctl restart neowatch'

echo "==> 5/5 health check"
sleep 2
$SSH "$HOST" 'systemctl is-active neowatch'
curl -fsS https://neowatch.soclose.co/api/health && echo " -- health OK"
curl -fsS https://neowatch.soclose.co/api/catalog/meta | grep -o '"total":[0-9]*' | head -1
echo "==> deploy done"
