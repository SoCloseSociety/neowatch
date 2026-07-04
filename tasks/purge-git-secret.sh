#!/usr/bin/env bash
# One-shot: purge the committed PWABuilder signing package (keystore + password) from
# ALL git history, then force-push. SAFE: backs up first, and only force-pushes if the
# secret is verifiably gone. The keystore stays on disk (gitignored) for future builds.
#
# The repo is PRIVATE, so exposure was limited to collaborators -- this is history
# hygiene, not an emergency; no key rotation needed.
#
# Run from anywhere:  bash tasks/purge-git-secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SECRET="NEOWATCH - Google Play package"

echo "==> repo: $ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "ABORT: working tree not clean -- commit or stash changes first."; exit 1
fi

echo "==> 1/5 backup bundle (full history)"
BK="../neowatch-prepurge-$(date +%Y%m%d-%H%M%S).bundle"
git bundle create "$BK" --all
echo "    backup written: $(cd "$(dirname "$BK")" && pwd)/$(basename "$BK")"
echo "    (restore if needed:  git clone \"$BK\" neowatch-restored )"

echo "==> 2/5 rewrite history, removing: $SECRET"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --index-filter \
  "git rm -rf --cached --ignore-unmatch '$SECRET'" \
  --prune-empty --tag-name-filter cat -- --all

echo "==> 3/5 drop rewrite refs + gc"
rm -rf .git/refs/original/
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo "==> 4/5 verify the keystore is gone from ALL history"
if git log --all --oneline -- "$SECRET/signing.keystore" "$SECRET/signing-key-info.txt" | grep -q .; then
  echo "ABORT: secret still found in history -- NOT force-pushing. Inspect manually."; exit 1
fi
echo "    confirmed: no keystore / key-info anywhere in history"

echo "==> 5/5 force-push rewritten history"
git push origin --force --all
git push origin --force --tags 2>/dev/null || true

echo
echo "DONE. Remote history purged."
if [ -f "$SECRET/signing.keystore" ]; then
  echo "Local keystore still on disk (gitignored) for future APK builds: OK"
else
  echo "NOTE: local keystore not on disk -- keep your safe copy for future builds."
fi
echo "Tip: other clones of this repo must re-clone (history was rewritten)."
