#!/usr/bin/env bash
# Build a curated programme-tv.net channels.xml limited to the popular FR channels
# NEOWATCH surfaces. The full 299-channel grab is too slow/flaky to finish under the
# cron budget; ~50 channels grab reliably in a few minutes. Run once (re-run to refresh).
set -u
cd /root/epg/epg || exit 1
mkdir -p /root/epg/curated
SRC="$(ls sites/programme-tv.net/programme-tv.net*.channels.xml | head -1)"
OUT="/root/epg/curated/programme-tv.net.channels.xml"

POP="TF1.fr France2.fr France3.fr France4.fr France5.fr France24.fr FranceInfo.fr Franceinfo.fr \
M6.fr arte.fr Arte.fr CNews.fr BFMTV.fr BFMBusiness.fr LCI.fr W9.fr TMC.fr TFX.fr NRJ12.fr \
C8.fr CStar.fr Gulli.fr 6ter.fr Cherie25.fr RMCDecouverte.fr RMCStory.fr LEquipe.fr \
CanalPlus.fr Teva.fr ParisPremiere.fr RTL9.fr Numero23.fr ChantFrance.fr"

{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<channels>'
  for id in $POP; do
    grep -h "xmltv_id=\"${id}@" "$SRC" 2>/dev/null
  done | sort -u
  echo '</channels>'
} > "$OUT"

echo "curated channels written: $(grep -c '<channel' "$OUT") -> $OUT"

# tv.blue.ch (Swiss) -- covers FR channels programme-tv.net lacks (BFMTV, C8 both
# 404 on the FR aggregators). Curate just those gaps so the grab stays fast.
BLUE_SRC="$(ls sites/tv.blue.ch/tv.blue.ch*.channels.xml | head -1)"
BLUE_OUT="/root/epg/curated/tv.blue.ch.channels.xml"
BLUE_POP="BFMTV.fr C8.fr"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<channels>'
  for id in $BLUE_POP; do
    grep -h "xmltv_id=\"${id}@" "$BLUE_SRC" 2>/dev/null | head -1
  done
  echo '</channels>'
} > "$BLUE_OUT"
echo "curated blue.ch channels written: $(grep -c '<channel' "$BLUE_OUT") -> $BLUE_OUT"
