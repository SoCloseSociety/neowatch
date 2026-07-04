#!/usr/bin/env bash
# NEOWATCH EPG grab: pull several EU TV-guide sites, merge, gzip, host.
# Safe: writes to a temp file and only swaps the live guide on success.
set -u
cd /root/epg/epg || exit 1

OUT="${OUT:-/root/epg/guide.xml}"
HOSTED="${HOSTED:-/var/www/neowatch/epg.xml.gz}"
# france.tv (public FR) + programme-tv.net (curated ~48 FR) + tv.blue.ch (curated:
# BFMTV/C8, which the FR aggregators 404 on) + guidatv.sky.it (IT). Dropped
# tv-programme.telecablesat.fr / mi.tv / ontvtonight.com -- they chronically time out.
SITES="${SITES:-france.tv programme-tv.net tv.blue.ch guidatv.sky.it}"
# Per-site budget: the FR aggregators (~300 channels x 2 days) need far more than the
# old 20 min, so allow 50 min each.
SITE_TIMEOUT="${SITE_TIMEOUT:-3000}"
PARTS="$(mktemp -d /tmp/epg-parts.XXXXXX)"
TMPOUT="$(mktemp /tmp/epg-guide.XXXXXX.xml)"

echo "[$(date -u +%FT%TZ)] grab start sites: $SITES"
for s in $SITES; do
  cfg="sites/$s/$s.config.js"
  # Prefer a curated channels file (just the channels we surface) when present --
  # the full site channels.xml (~300 ch) is too slow/flaky to finish reliably.
  if [ -f "/root/epg/curated/$s.channels.xml" ]; then
    ch="/root/epg/curated/$s.channels.xml"
  else
    ch="$(ls sites/$s/$s*.channels.xml 2>/dev/null | head -1)"
  fi
  if [ ! -f "$cfg" ] || [ -z "$ch" ]; then echo "  skip $s (no cfg/channels)"; continue; fi
  if timeout "$SITE_TIMEOUT" npx epg-grabber --config="$cfg" --channels="$ch" --output="$PARTS/$s.xml" --days=2 >/dev/null 2>&1; then
    echo "  ok $s ($(grep -c '<programme' "$PARTS/$s.xml" 2>/dev/null) progs)"
  else
    echo "  FAIL/timeout $s"
  fi
done

if node /root/epg/merge.mjs "$PARTS" "$TMPOUT"; then
  PROGS="$(grep -c '<programme' "$TMPOUT" 2>/dev/null || echo 0)"
  CHANS="$(grep -c '<channel ' "$TMPOUT" 2>/dev/null || echo 0)"
  # Guard on CHANNEL COUNT: a real grab (curated FR ~48 + france.tv 8 + IT) has 30+
  # channels; a partial france.tv-only run has just 8 and must NOT overwrite a richer
  # guide. Channel count is a better quality signal than raw programme count (one
  # Italian site alone can dwarf the FR channels we actually care about).
  if [ "$CHANS" -ge 30 ] && [ "$PROGS" -gt 1000 ]; then
    mv -f "$TMPOUT" "$OUT"
    gzip -f -c "$OUT" > "$HOSTED"
    echo "[$(date -u +%FT%TZ)] hosted $CHANS channels / $PROGS programmes -> $HOSTED"
  else
    echo "[$(date -u +%FT%TZ)] ABORT: only $CHANS channels / $PROGS programmes, keeping previous guide"
    rm -f "$TMPOUT"
  fi
fi
rm -rf "$PARTS"
