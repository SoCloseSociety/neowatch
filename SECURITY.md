# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Email **sin.soclose@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version / commit.

We aim to acknowledge within a few days and to fix confirmed issues promptly. Responsible disclosure is appreciated — please give us reasonable time to ship a fix before any public disclosure.

## Scope

In scope: authentication/authorization, the HLS proxy (SSRF / open-relay), stream-URL signing, rate-limiting, user-data handling, and the admin surface.

Out of scope: the availability or content of third-party streams (they belong to their broadcasters — use the in-app legal-page contact or the admin takedown blocklist for removal requests), and denial-of-service via volumetric traffic.

## Hardening already in place

- **SSRF guard** on every user-supplied-URL path (proxy, health, M3U import, EPG, films, radio): connect-time DNS pinning + per-redirect-hop revalidation against a private-range blocklist.
- **Signed proxy URLs** (HMAC, expiring) — the proxy refuses unsigned/tampered targets, closing open-relay abuse.
- **Rate-limiting** on auth, admin, health and proxy endpoints.
- **Secrets** are never committed: `.env`, user data, caches and signing material are git-ignored; production refuses to boot without an explicit `JWT_SECRET`.
- **Atomic** JSON persistence, decompression-bomb guards on XMLTV, request size caps.
- **GDPR:** password-confirmed self-service account deletion; no third-party ad/tracking cookies by default.
