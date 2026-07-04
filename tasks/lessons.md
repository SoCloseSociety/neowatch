# NEOWATCH -- Lessons

> Append a pattern here after every user correction or non-obvious discovery.
> Format: **Context** -> **Lesson** -> **How to apply**.

- **Context:** iptv-org data model. -> **Lesson:** streams join to channels via `stream.channel` (often null); logos/feeds join by channel id; many streams carry custom `user_agent`/`referrer` that browsers cannot set. -> **How to apply:** keep the normalization in `catalog.js`; route UA/Referrer streams through `/api/proxy`.

- **Context:** channel identity. -> **Lesson:** the normalized `id` is index-based and unstable across catalog rebuilds. -> **How to apply:** always key favorites/recents/health on the stream **url**, never on `id`.

- **Context:** deployment. -> **Lesson:** the user runs localhost first, optionally a low-resource shared "helper" server for friends. -> **How to apply:** keep playback DIRECT-first with proxy fallback so the host serves mostly JSON + the static bundle; gate content with `REQUIRE_AUTH=true` on shared deploys.

- **Context:** TS build. -> **Lesson:** `tsc -b` needs `composite: true` on referenced projects and was friction here. -> **How to apply:** web uses a single `tsconfig.json` + `tsc --noEmit` for typecheck; add `vite-env.d.ts` for `import.meta.env`.

- **Context:** Express middleware mounting. -> **Lesson:** `app.use('/api', requireUser, billingRouter)` applied `requireUser` to the ENTIRE `/api` prefix (every request, not just billing), 401-ing anonymous users on the public catalog. -> **How to apply:** put auth guards on the individual routes inside a router, not on a broad `app.use(prefix, mw, router)` mount, unless you really mean the whole prefix.

- **Context:** Monetizing free/public streams. -> **Lesson:** you can't technically paywall a publicly reachable URL; enforce the paywall by stripping premium stream URLs from API responses for non-premium users and 402-ing the proxy, and frame the charge as paying for the SERVICE (curation/EPG/multi-screen/no-ads/own playlists), not the streams. -> **How to apply:** keep `project()`-style URL stripping in `catalog.js` + the proxy premium gate; never expose premium URLs to free users.

- **Context:** Server crashed ("nothing works online") after the background health sweep shipped. -> **Lesson:** a streaming proxy that fetches thousands of flaky CDNs WILL hit upstream sockets that drop mid-stream; undici emits an unhandled 'error' event (esp. on HTTP/2 streams, UND_ERR_SOCKET) that crashes the whole Node process. A leaked/undrained response body makes it worse (pool exhaustion). -> **How to apply:** ALWAYS register `process.on('uncaughtException')` + `process.on('unhandledRejection')` (log, don't exit) in any proxy/fetch-heavy server; set `allowH2:false` + bounded headers/body/connect timeouts on the undici Agent; and ALWAYS consume or `body.cancel()` every fetch response (every branch), never leave one undrained.

- **Context:** User direction style. -> **Lesson:** the user fires many rapid scope additions and says "continue, don't ask"; payment/ads keys will come later. -> **How to apply:** build the full mechanics with a mock/seam (mock billing, AdSense-on-config), keep it working without keys, and don't block on AskUserQuestion for things they've said they'll provide later.

- **Context:** The e2e "player mounts a <video>" check kept failing (11/12); I first wrote it off as "the known headless-autoplay flake." -> **Lesson:** don't dismiss a red test as a flake without reproducing the root cause. The real cause was a fixed `waitForTimeout(2500)` that was too tight for the lazy ~530KB HlsVideo chunk to fetch+parse in headless -- the player works perfectly (verified: video mounts at ~5s via both the card-click and detail "Regarder" paths, no console/chunk errors). -> **How to apply:** for anything gated on a lazy/code-split chunk, POLL for the element (`locator.waitFor({state:'attached', timeout})`), never a fixed sleep; and when tempted to call a failure a "flake," prove it with an instrumented run (console + pageerror + requestfailed) before moving on.

- **Context:** "Online" badge overstated playability ("beaucoup de chaînes ne fonctionnent pas") because the sweep only checked manifest reachability. -> **Lesson:** a 200 on an HLS manifest does NOT mean the stream plays -- measured ~12pp MORE channels offline under a deep probe (real 4KB segment download) than under the shallow manifest probe. -> **How to apply:** the periodic health sweep is now DEEP (`runSweep(false,true)`); the `runSweep` priority filter must re-probe fresh-but-shallow entries (priority 2) on a deep pass or the upgrade never happens. Boot stays shallow (fast badge fill), interval goes deep (truth).
