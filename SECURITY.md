# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Email **sin.soclose@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (proof of concept if possible),
- the affected version or commit.

We aim to acknowledge within a few days and to fix confirmed issues promptly. Responsible
disclosure is appreciated: please give us reasonable time to ship a fix before any public
disclosure.

## Scope

In scope: authentication and sessions (sliding tokens, TV pairing), authorization and admin
routes, the stream proxy (SSRF, open relay, header injection), stream-URL signing, billing and
the Stripe webhook, rate limits, user-data handling (export, deletion), the Android shell's
host allowlist.

Out of scope: the availability or content of third-party streams (they belong to their
broadcasters: use "Report channel" in the app, the contact on the legal page, or the admin
takedown blocklist), and denial of service through volumetric traffic.

## Hardening in place

- **SSRF guard** on every user-supplied-URL path (proxy, health probes, M3U import, XMLTV,
  films, radio): DNS pinned at connect time, every redirect hop revalidated, private, link-local,
  metadata, NAT64, 6to4 and benchmark ranges blocked. `ALLOW_PRIVATE_SOURCES` opens LAN hosts
  for admin-added sources and their streams only.
- **Signed proxy URLs** (HMAC over the URL, expiry, User-Agent, Referer, root stream): unsigned or
  tampered links get 403, taken-down streams 410. The proxy forwards an allowlist of response
  headers only, forces media content types and sends a sandbox CSP + `nosniff` +
  `Cross-Origin-Resource-Policy: same-origin`.
- **Sessions:** HS256 pinned, revocation by `tokenVersion` (password change, admin reset,
  disable), token-carrying responses `no-store` and never 304, no token on `/api/proxy`.
- **Documents** refuse framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), `nosniff`,
  a strict Referrer-Policy. JSON errors without stack traces.
- **Rate limits** on auth, pairing, admin, health checks, guide search, roaming writes and the proxy.
- **Secrets** are never committed: `.env`, user data, caches, keystores and signing material are
  git-ignored and docker-ignored; production refuses to boot without an explicit `JWT_SECRET`.
- **Atomic** JSON persistence, size caps on bodies, playlists and guides, a linear XMLTV parser.
- **Dependencies:** the lockfile is what production installs (`npm ci`); CI fails on any high or
  critical advisory in production dependencies.
- **GDPR:** data export (`GET /api/auth/me/export`), password-confirmed self-service deletion
  (it also cancels a Stripe subscription), ads only after consent.
