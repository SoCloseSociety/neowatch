# EPG (TV guide) -- how it's wired on the VPS

NEOWATCH shows real now/next + day schedules on the home rails and channel detail
pages. The guide is grabbed on the VPS and hosted as a static file the server polls.

## On the VPS (helper-vps)
- `iptv-org/epg` grabber lives at `/root/epg/epg` (clone, no chromium -- `PUPPETEER_SKIP_DOWNLOAD=1`).
- `grab.sh` pulls several EU TV-guide sites, merges them with `merge.mjs`, gzips, and
  hosts the result at `/var/www/neowatch/epg.xml.gz`. It only swaps the live guide when
  the merge yields >1000 programmes (so a partial/failed grab never blanks the guide).
- Nightly cron: `12 4 * * * /root/epg/grab.sh >> /root/epg/grab.log 2>&1`.
- The server reads it via `EPG_DEFAULT_URL=https://neowatch.soclose.co/epg.xml.gz` in
  `/root/neowatch/.env`.

## Matching (important)
Grabber channel ids carry a feed suffix and vary in case (`Arte.fr@SD`, `BabyTV.uk@UK`),
while the catalog tvg-id is the bare id (`arte.fr`). `server/src/epg.js` (`normEpgId`) and
`catalog.js#getByChannelId` strip the `@feed` suffix and lowercase both sides so now/next,
day and search actually match. Don't remove that normalization or coverage drops to ~0.

## Reliability notes (learned the hard way)
- The full `programme-tv.net` channels.xml (~299 ch) is too slow/flaky to finish under
  the grab budget, so `curate-fr.sh` builds `/root/epg/curated/programme-tv.net.channels.xml`
  (~48 popular FR channels: TF1, Arte, CNews, M6, BFM, France2-5, W9, TMC, LCI, RMC, Gulli...).
  `grab.sh` prefers a `curated/<site>.channels.xml` when present. The curated FR grab pulls
  ~4350 programmes in ~5 min reliably.
- BFMTV + C8 are NOT on programme-tv.net (and 404 on the FR aggregators), so `curate-fr.sh`
  also builds `curated/tv.blue.ch.channels.xml` (Swiss site, has both) and `grab.sh` includes
  `tv.blue.ch`. That closes the last gap -> 14/14 popular FR channels.
- `grab.sh` guards on **channel count >= 30** (not raw programme count) before swapping the
  live guide, so a partial france.tv-only run (8 ch) can't overwrite a richer guide.
- The Node server re-fetches the hosted guide **every 6h in-process** (`epg.js` refreshTimer),
  so the nightly grab reaches users without a restart. (Before this, the server only loaded
  EPG at boot -- the file updated but users saw a stale guide.)

## Refresh manually
```bash
ssh helper-vps 'bash /root/epg/curate-fr.sh'                       # rebuild the curated FR list
ssh helper-vps 'SITES="france.tv programme-tv.net" bash /root/epg/grab.sh'   # fast FR-only (~5 min)
ssh helper-vps 'bash /root/epg/grab.sh'                            # full (FR + IT), slower
```
Coverage: **14/14 popular FR channels** (incl. BFMTV + C8 via tv.blue.ch) + ~55 channels total
after the curated grab. The long tail has no public guide; the detail page degrades gracefully
("Programme non disponible").
