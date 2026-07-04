# Contributing to NEOWATCH

Thanks for helping improve NEOWATCH! This is the SoClose community's open live-TV/radio/film aggregator. Contributions of all sizes are welcome.

## Getting set up

```bash
git clone https://github.com/SoCloseSociety/neowatch.git
cd neowatch
npm install
npm run dev        # web → http://localhost:5273 · api → http://localhost:8787
```

You need **Node 20+**. No database or external service is required for local dev — the catalog is fetched from the public iptv-org API and cached to disk on first boot.

## Project layout

- `server/src/` — Express API (ESM). Thin route handlers + dedicated modules: `catalog` (iptv-org normalization), `proxy` (HLS manifest rewriting), `health` (availability sweep), `auth`, `epg`, `films`, `radio`, `billing`, `netguard` (SSRF), `ratelimit`.
- `web/src/` — React 18 + Vite + Tailwind + Zustand. Components are presentational and read from stores (`store/*`); theming via CSS variables.
- `CLAUDE.md` — the detailed architecture and house rules. **Read it before a non-trivial change.**

## Before you open a PR

Everything must pass:

```bash
npm run typecheck        # web TypeScript
npm run build            # typecheck + production build
node tasks/integration-test.mjs           # API suite (set BASE, ADMIN_EMAIL, ADMIN_PASSWORD)
```

And sanity-check the runtime:

```bash
curl localhost:8787/api/health
curl "localhost:8787/api/catalog/meta"   # non-zero total
```

Then open the app, play one HLS channel, and open the multi-screen mosaic.

## Conventions

- **Simplicity first** — smallest change that solves the problem; touch only what's necessary.
- **React components** PascalCase in `web/src/components`; Zustand stores `useX` in `web/src/store`; server modules lowercase ESM in `server/src`. API routes under `/api`.
- Match the surrounding code's style, naming and comment density. Comments explain *why*, not *what*.
- **i18n:** no hard-coded user-facing strings — add keys to `web/src/lib/i18n.ts` in all three languages (fr/en/ru).
- **Security:** any new user-supplied URL must pass the SSRF guard (`assertPublicHost`/`safeFetch`) and a size cap. Any new content route must respect premium gating & the takedown blocklist.
- **Legal:** NEOWATCH only aggregates publicly-available free streams. Do not add scrapers for paywalled/pirated content, and don't gate third-party content behind payment.
- **No em dashes** in output — use `--`.

## Good first contributions

- New XMLTV/EPG source adapters, more public-domain film collections, additional locales.
- Player robustness (codecs, edge cases), accessibility, TV-remote UX.
- Performance (bundle size, rendering on huge lists).

## Reporting bugs

Open an issue with steps to reproduce, expected vs actual, and logs/console output. Security issues: **do not** open a public issue — see [SECURITY.md](SECURITY.md).
