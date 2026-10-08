# Contributing to NEOWATCH

Thanks for helping improve NEOWATCH, the SoClose community's open live TV, radio and film
aggregator. Contributions of all sizes are welcome.

## Getting set up

```bash
git clone https://github.com/SoCloseSociety/neowatch.git
cd neowatch
npm install
npm run dev        # web: http://localhost:5273 · api: http://localhost:8787
```

You need **Node 20.19+** (production runs 20.20.2, see `.nvmrc`). No database or external service
is required: the catalog is fetched from the public iptv-org API and cached on first boot.

## Project layout

- `server/src/`: Express API (ESM). Thin route handlers + modules: `catalog` (iptv-org
  normalization, ids), `proxy` + `signing` (stream relay), `health`, `auth`, `billing`, `sources`
  (M3U), `epg` (XMLTV), `films`, `radio`, `netguard` (SSRF), `ratelimit`, `config`.
- `web/src/`: React 18 + Vite + Tailwind + Zustand. Components read from stores (`store/*`);
  design tokens in `index.css`, primitives in `components/ui.tsx`, copy in `lib/i18n/*`.
- `android/`: the Android TV / phone WebView shell.
- `test/`: `run.mjs` (the `npm test` runner) and the suites; `scripts/`: deploy and the guide grabber.
- `CLAUDE.md`: the detailed architecture and house rules. **Read it before a non-trivial change.**
- `NEO_CONNECTOR.md`: the frozen API contract other systems rely on. Additive changes only.

## Before you open a PR

Everything must pass:

```bash
npm run typecheck                      # web TypeScript
npm run build                          # typecheck + production build
npm test                               # server suites on throwaway servers (see docs/TESTS.md)
node test/verify-design.mjs --keys     # every t() key exists in EN, FR and RU
npm audit --omit=dev --audit-level=high
```

For UI changes, also measure your pages in a real Chrome against a throwaway server and look at
the screenshots: `node test/verify-design.mjs <port> --pages <yours> --formats desktop,phone,tv --measure`.
Then open the app, play one HLS channel, and open the multi-view mosaic.

## Conventions

- **Simplicity first:** the smallest change that solves the problem; touch only what is necessary.
- React components PascalCase in `web/src/components`; Zustand stores `useX` in `web/src/store`;
  server modules lowercase ESM in `server/src`. API routes under `/api`.
- Match the surrounding style, naming and comment density. Comments explain *why*, not *what*.
- **Design:** use the tokens and primitives (`Button`, `Pill`, `EmptyState`...). One primary
  action per screen, a visible focus ring on every control, text never under 12 px.
- **i18n:** no hard-coded user-facing strings. Add keys to the right fragment in
  `web/src/lib/i18n/` with EN, FR and RU. Wrap data (channel names, titles) with `translate="no"`.
- **Security:** any new user-supplied URL must pass the SSRF guard (`assertPublicHost` /
  `safeFetch`) and a size cap. Any new content route must respect `gateContent`, the takedown
  blocklist and custom-source locking.
- **Legal:** NEOWATCH only aggregates publicly available free streams. Do not add scrapers for
  paywalled or pirated content, and never gate public channels behind payment.
- **No em dashes** anywhere (CI checks it): use `--` in code and docs, `·` or `:` in UI copy.

## Good first contributions

- New XMLTV guide sources, more public-domain film collections, more locales.
- Player robustness (codecs, edge cases), accessibility, TV remote UX.
- Performance (bundle size, rendering of large lists).

## Reporting bugs

Open an issue with steps to reproduce, expected vs actual, and logs or console output. Security
issues: **do not** open a public issue, see [SECURITY.md](SECURITY.md).
