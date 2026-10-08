#!/usr/bin/env bash
# NEOWATCH deploy to helper-vps (production). Only with the owner's go-ahead.
#
#   bash scripts/deploy.sh                # gate (clean tree, npm test, build), ship, restart, verify
#   bash scripts/deploy.sh --rollback     # put back the previous release (server + web) and restart
#   bash scripts/deploy.sh --apk FILE     # ALSO publish FILE as /app.apk (explicit; else the live APK stays)
#   options: --skip-tests (no local npm test gate), --allow-dirty (ship uncommitted changes)
#
# What lives where on the VPS (and survives every deploy):
#   /root/neowatch/.env                 JWT_SECRET, EPG_DEFAULT_URL...   never shipped, never touched
#   /root/neowatch/server/.data         accounts, favorites, sources       outside every rsync source
#   /root/neowatch/server/.cache        iptv-org catalog + health cache    outside every rsync source
#   /var/www/neowatch/epg.xml.gz        nightly guide (scripts/epg)        protected from --delete
#   /var/www/neowatch/app.apk           Android shell                      protected; only --apk replaces it
#   /root/neowatch/.rollback/           previous release (one level)       written before each deploy
#
# Dependencies: the repo lockfile is shipped (root package.json + package-lock.json +
# server/package.json) and installed with `npm ci --omit=dev -w server`, so prod runs exactly
# the versions CI tested. undici stays on major 6: the VPS runs Node 20.20.2.
set -euo pipefail

HOST="${NEOWATCH_HOST:-helper-vps}"
URL="${NEOWATCH_URL:-https://neowatch.soclose.co}"
APP="${NEOWATCH_APP_DIR:-/root/neowatch}"
WWW="${NEOWATCH_WWW_DIR:-/var/www/neowatch}"
EPG="${NEOWATCH_EPG_DIR:-/root/epg}"
RB="$APP/.rollback"
SSH_BIN="${NEOWATCH_SSH:-ssh}" # overridable only to rehearse the script against a local fake host
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
RSH="$SSH_BIN ${SSH_OPTS[*]}"

MODE=deploy APK="" SKIP_TESTS=0 ALLOW_DIRTY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) MODE=rollback ;;
    --apk) APK="${2:-}"; shift ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
remote() { "$SSH_BIN" "${SSH_OPTS[@]}" "$HOST" "$@"; }

# Web dist rsync rules. A protect rule (P) only stops --delete; it never blocks a transfer.
#  - epg.xml.gz (+ its temp file) is written on the VPS by scripts/epg/grab.sh;
#  - app.apk is excluded from the dist transfer ('-' also protects it): web/public/app.apk is
#    a local leftover, the live APK is published only with --apk;
#  - .well-known/ transfers from dist (assetlinks.json is tracked); acme-challenge is kept.
WEB_FILTERS=(
  --filter='P /epg.xml.gz' --filter='P /.epg.xml.gz.*'
  --filter='- /app.apk' --filter='P /*.apk.bak'
  --filter='P /.well-known/acme-challenge/'
)

json_field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(d));console.log(v ?? "")}catch{console.log("")}})' "$1"; }

verify() {
  echo "==> verify: service + health + frozen routes on $URL"
  remote "systemctl is-active neowatch" || { echo "!! service neowatch is not active"; return 1; }
  local ok="" total=""
  for _ in $(seq 1 60); do
    local h; h="$(curl -fsS --max-time 10 "$URL/api/health" 2>/dev/null || true)"
    ok="$(printf '%s' "$h" | json_field ok)"; total="$(printf '%s' "$h" | json_field catalog.total)"
    if [ "$ok" = "true" ] && [ "${total:-0}" -gt 0 ] 2>/dev/null; then break; fi
    sleep 2
  done
  if [ "$ok" != "true" ] || ! [ "${total:-0}" -gt 0 ] 2>/dev/null; then
    echo "!! /api/health not ok (ok=$ok total=$total)"; return 1
  fi
  echo "   health ok, catalog.total=$total"
  local id; id="$(curl -fsS --max-time 15 "$URL/api/catalog/channels?q=news&limit=1" | json_field items.0.id)"
  [ -n "$id" ] || { echo "!! /api/catalog/channels?q= returned no id"; return 1; }
  local path code fail=0
  for path in "/api/catalog/meta" "/api/catalog/channel/$id" "/api/epg/now?ids=x" "/api/epg/day?id=x" \
              "/chaine/$id" "/" "/.well-known/assetlinks.json" "/app.apk"; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -I "$URL$path" 2>/dev/null || true)"
    # Some Express routes answer HEAD like GET; retry as GET when HEAD is refused.
    [ "$code" = "200" ] || code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL$path" || true)"
    printf '   %-40s %s\n' "$path" "$code"
    [ "$code" = "200" ] || fail=1
  done
  echo "==> versions on the VPS"
  remote "cd $APP && npm ls compression undici express --omit=dev 2>/dev/null || true"
  return $fail
}

if [ "$MODE" = rollback ]; then
  echo "==> rollback on $HOST from $RB"
  remote "bash -s" <<EOF
set -euo pipefail
test -f "$RB/STAMP" || { echo "no rollback copy at $RB"; exit 1; }
echo "   restoring release from: \$(cat "$RB/STAMP")"
rsync -a --delete "$RB/server/src/" "$APP/server/src/"
cp -a "$RB/server/package.json" "$APP/server/package.json"
for f in package.json package-lock.json; do
  if [ -f "$RB/\$f" ]; then cp -a "$RB/\$f" "$APP/\$f"; else rm -f "$APP/\$f"; fi
done
if [ -f "$RB/server/package-lock.json" ]; then cp -a "$RB/server/package-lock.json" "$APP/server/"; fi
if [ -d "$RB/node_modules" ]; then rsync -a --delete "$RB/node_modules/" "$APP/node_modules/"; else rm -rf "$APP/node_modules"; fi
if [ -d "$RB/server/node_modules" ]; then rsync -a --delete "$RB/server/node_modules/" "$APP/server/node_modules/"; else rm -rf "$APP/server/node_modules"; fi
rsync -a --delete --filter='P /epg.xml.gz' --filter='P /.epg.xml.gz.*' --filter='P /app.apk' --filter='P /*.apk.bak' --filter='P /.well-known/acme-challenge/' "$RB/www/" "$WWW/"
if [ -f "$RB/app.apk" ]; then cp -a "$RB/app.apk" "$WWW/app.apk"; fi
systemctl restart neowatch
EOF
  verify && echo "==> rollback done" || { echo "!! rollback verification failed: check 'journalctl -u neowatch' / /var/log/neowatch.log"; exit 1; }
  exit 0
fi

if [ -n "$APK" ]; then
  [ -f "$APK" ] || { echo "--apk: no such file: $APK" >&2; exit 2; }
  # No `| grep -q` here: with pipefail, grep's early exit SIGPIPEs unzip and fails the test.
  case "$(unzip -l "$APK" 2>/dev/null)" in *AndroidManifest.xml*) ;; *) echo "--apk: $APK is not an APK" >&2; exit 2 ;; esac
fi

echo "==> 1/8 local gate"
echo "   branch $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
if [ "$ALLOW_DIRTY" = 0 ] && [ -n "$(git status --porcelain --untracked-files=normal -- server web package.json package-lock.json)" ]; then
  echo "!! uncommitted changes under server/ web/ or the manifests (commit, or pass --allow-dirty)"; exit 1
fi
bash -n scripts/epg/grab.sh && bash -n scripts/epg/curate-fr.sh
if [ "$SKIP_TESTS" = 0 ]; then npm test; else echo "   tests SKIPPED (--skip-tests)"; fi

echo "==> 2/8 build web"
npm run build

echo "==> 3/8 rollback copy of the live release ($RB)"
KEEP_APK=0; [ -z "$APK" ] || KEEP_APK=1
remote "bash -s" <<EOF
set -euo pipefail
rm -rf "$RB.new"; mkdir -p "$RB.new/server" "$RB.new/www"
cp -a "$APP/server/src" "$RB.new/server/src"
cp -a "$APP/server/package.json" "$RB.new/server/"
for f in server/package-lock.json package.json package-lock.json; do
  if [ -f "$APP/\$f" ]; then cp -a "$APP/\$f" "$RB.new/\$f"; fi
done
if [ -d "$APP/node_modules" ]; then cp -a "$APP/node_modules" "$RB.new/node_modules"; fi
if [ -d "$APP/server/node_modules" ]; then cp -a "$APP/server/node_modules" "$RB.new/server/node_modules"; fi
rsync -a --exclude=/epg.xml.gz --exclude='/.epg.xml.gz.*' --exclude=/app.apk "$WWW/" "$RB.new/www/"
# The live APK is kept only when this deploy replaces it (--apk).
if [ "$KEEP_APK" = 1 ] && [ -f "$WWW/app.apk" ]; then cp -a "$WWW/app.apk" "$RB.new/app.apk"; fi
echo "\$(date -u +%FT%TZ) (before $(git rev-parse --short HEAD))" > "$RB.new/STAMP"
rm -rf "$RB"; mv "$RB.new" "$RB"
echo "   saved: \$(cat "$RB/STAMP")"
EOF

echo "==> 4/8 dependencies: ship the lockfile, npm ci --omit=dev -w server"
rsync -az -e "$RSH" ./package.json ./package-lock.json "$HOST:$APP/"
rsync -az -e "$RSH" ./server/package.json "$HOST:$APP/server/"
remote "bash -s" <<EOF
set -euo pipefail
cd "$APP"
if ! npm ci --omit=dev -w server --no-audit --no-fund; then
  echo "!! npm ci failed: restoring the previous manifests (server code untouched)"
  cp -a "$RB/server/package.json" server/package.json
  for f in package.json package-lock.json; do if [ -f "$RB/\$f" ]; then cp -a "$RB/\$f" "\$f"; else rm -f "\$f"; fi; done
  if [ -d "$RB/node_modules" ]; then rsync -a --delete "$RB/node_modules/" node_modules/; fi
  exit 1
fi
# Old layout leftovers: a VPS-local lock and a nested node_modules would shadow the root install.
rm -f server/package-lock.json
rm -rf server/node_modules
EOF

echo "==> 5/8 server code (src only: .data/.cache/.env are never in the source path)"
rsync -az --delete -e "$RSH" ./server/src/ "$HOST:$APP/server/src/"

echo "==> 6/8 web (dist; EPG + APK + acme protected)"
rsync -az --delete "${WEB_FILTERS[@]}" -e "$RSH" ./web/dist/ "$HOST:$WWW/"
if [ -n "$APK" ]; then
  echo "   publishing $APK as /app.apk"
  rsync -az -e "$RSH" "$APK" "$HOST:$WWW/app.apk.new"
  remote "mv -f $WWW/app.apk.new $WWW/app.apk"
fi

echo "==> 7/8 EPG scripts (scripts/epg -> $EPG, no delete: curated/ and the grabber stay)"
# --chmod: cron runs /root/epg/grab.sh directly, it must stay executable.
rsync -az --chmod=F755 -e "$RSH" ./scripts/epg/grab.sh ./scripts/epg/curate-fr.sh ./scripts/epg/merge.mjs "$HOST:$EPG/"

echo "==> 8/8 restart + verify"
remote "systemctl restart neowatch"
sleep 2
if verify; then
  echo "==> deploy done"
else
  echo "!! post-deploy verification FAILED. Roll back with: bash scripts/deploy.sh --rollback"
  exit 1
fi
