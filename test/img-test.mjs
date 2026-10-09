#!/usr/bin/env node
// NEOWATCH logo relay test: GET /api/img?u=<url> (server/src/img.js). A crafted upstream
// (a tiny local http server started HERE) serves lying labels, HTML disguised as PNG,
// SVG, oversized and endless bodies, redirects into the private network, a stalled
// answer and hostile headers; the relay must refuse each one and answer with OUR
// headers only.
//
// The crafted logos are vended the only way the relay accepts: as the tvg-logo of a
// custom M3U source imported by the admin. The server must run with
// ALLOW_PRIVATE_SOURCES=true (the upstream is on 127.0.0.1; that opens the guard for a
// custom logo's OWN host only, never for a redirect elsewhere):
//   ALLOW_PRIVATE_SOURCES=true ADMIN_EMAIL=... ADMIN_PASSWORD=... JWT_SECRET=... PORT=8920 node server/src/index.js
//   BASE=http://localhost:8920 ADMIN_EMAIL=... ADMIN_PASSWORD=... node test/img-test.mjs
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, UPSTREAM_PORT (default 8921). `npm test` runs it.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const UP = Number(process.env.UPSTREAM_PORT) || 8921;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0, skip = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} (${why})`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

const req = async (path, { method = 'GET', token, body, headers = {}, timeout = 20000 } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body) h['Content-Type'] = 'application/json';
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    let data = buf.toString('utf8');
    if (ct.includes('json')) { try { data = JSON.parse(data); } catch { /* keep text */ } }
    return { status: res.status, data, buf, ct, headers: res.headers, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, data: null, buf: Buffer.alloc(0), ct: '', headers: new Headers(), ms: Date.now() - t0, error: String(e?.cause?.code || e?.name || e) };
  }
};
const img = (u, opts) => req(`/api/img?u=${enc(u)}`, opts);

// ── crafted images ──
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x11), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(52, 0)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.from([0, 0, 0, 0]), Buffer.from('avifmif1miaf'), Buffer.alloc(40, 0)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(80, 0x22)]);
const HTML = '<html><body><script>alert(localStorage.getItem("neowatch.token"))</script></body></html>';
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const POLYGLOT = Buffer.concat([GIF.subarray(0, 13), Buffer.from('<script>alert(document.domain)</script>')]);

const hits = {};
const up = (p) => `http://127.0.0.1:${UP}${p}`;
const upstream = createServer((q, s) => {
  const path = q.url.split('?')[0];
  hits[path] = (hits[path] || 0) + 1;
  const send = (code, headers, body) => { s.writeHead(code, headers); s.end(body); };
  switch (path) {
    case '/logo/real.png':
    case '/logo/real2.png':
    case '/logo/real3.png':
    case '/logo/takedown.png':
      return send(200, {
        'Content-Type': 'image/png',
        'Set-Cookie': 'pwn=1; Path=/',
        'Access-Control-Allow-Origin': 'https://attacker.example',
        'Content-Security-Policy': 'default-src *',
        'X-Renewed-Token': 'forged.token.value',
        'X-Frame-Options': 'ALLOWALL',
        'Cache-Control': 'private, max-age=5',
        'Link': '<https://attacker.example/x.css>; rel=preload',
        'Refresh': '0; url=https://attacker.example/',
      }, PNG);
    case '/logo/html.png': return send(200, { 'Content-Type': 'image/png' }, HTML);
    case '/logo/html-label': return send(200, { 'Content-Type': 'text/html' }, PNG);
    case '/logo/octet.jpg': return send(200, { 'Content-Type': 'application/octet-stream' }, JPEG);
    case '/logo/mislabelled': return send(200, { 'Content-Type': 'image/png' }, GIF);
    case '/logo/logo.svg': return send(200, { 'Content-Type': 'image/svg+xml' }, SVG);
    case '/logo/svg-as-png': return send(200, { 'Content-Type': 'image/png' }, SVG);
    case '/logo/webp': return send(200, { 'Content-Type': 'image/webp' }, WEBP);
    case '/logo/avif': return send(200, { 'Content-Type': 'image/avif' }, AVIF);
    case '/logo/favicon.ico': return send(200, { 'Content-Type': 'image/vnd.microsoft.icon' }, ICO);
    case '/logo/polyglot.gif': return send(200, { 'Content-Type': 'image/gif' }, POLYGLOT);
    case '/logo/big.png': {
      // PNG magic, then 1.5 MB, chunked (no Content-Length): the cap must hold mid-body.
      s.writeHead(200, { 'Content-Type': 'image/png' });
      s.write(PNG.subarray(0, 16));
      let left = 24;
      const pump = () => { while (left > 0 && !s.destroyed) { left--; if (!s.write(Buffer.alloc(65536, 0x33))) return s.once('drain', pump); } if (!s.destroyed) s.end(); };
      return pump();
    }
    case '/logo/big-len.png': return send(200, { 'Content-Type': 'image/png', 'Content-Length': String(2_000_000) }, Buffer.concat([PNG, Buffer.alloc(2_000_000 - PNG.length, 0x33)]));
    case '/logo/redir-other': return send(302, { Location: `http://localhost:${UP}/logo/real.png` }, '');
    case '/logo/redir-meta': return send(302, { Location: 'http://169.254.169.254/latest/meta-data/' }, '');
    case '/logo/redir-same': return send(302, { Location: '/logo/real2.png' }, '');
    case '/logo/slow': return undefined; // never answers: the 10 s timeout must end it
    case '/logo/gone': return send(404, { 'Content-Type': 'text/html' }, 'not here');
    case '/logo/inflight.png': return setTimeout(() => send(200, { 'Content-Type': 'image/png' }, PNG), 400);
    default: return send(404, { 'Content-Type': 'text/plain' }, 'nope');
  }
});
upstream.on('connection', (sock) => sock.unref()); // a stalled /logo/slow must not hold the exit

const LOGOS = [
  'real.png', 'real3.png', 'takedown.png', 'html.png', 'html-label', 'octet.jpg', 'mislabelled', 'logo.svg', 'svg-as-png',
  'webp', 'avif', 'favicon.ico', 'polyglot.gif', 'big.png', 'big-len.png', 'redir-other', 'redir-meta', 'redir-same',
  'slow', 'gone', 'inflight.png',
];
const RUN = Date.now();
const logo = (name) => up(`/logo/${name}`);
const streamOf = (name) => up(`/stream/${enc(name)}.m3u8?run=${RUN}`);

const ourHeaders = (r) => {
  const h = r.headers;
  const bad = [];
  if (h.get('x-content-type-options') !== 'nosniff') bad.push(`nosniff=${h.get('x-content-type-options')}`);
  if (h.get('content-security-policy') !== "default-src 'none'; sandbox") bad.push(`csp=${h.get('content-security-policy')}`);
  if (h.get('cross-origin-resource-policy') !== 'same-origin') bad.push(`corp=${h.get('cross-origin-resource-policy')}`);
  for (const k of ['set-cookie', 'access-control-allow-origin', 'x-renewed-token', 'link', 'refresh']) if (h.get(k)) bad.push(`${k}=${h.get(k)}`);
  if (h.get('x-frame-options') && h.get('x-frame-options') !== 'DENY') bad.push(`xfo=${h.get('x-frame-options')}`);
  return bad;
};

(async () => {
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  let admin = null, srcId = null;
  try {
    // ── sniffer (unit) ──
    section('magic-byte sniffer (unit)');
    const { sniffImage, imgurRendition } = await import(resolve(ROOT, 'server/src/img.js'));
    const cases = [
      [PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp'], [AVIF, 'image/avif'], [ICO, 'image/x-icon'],
      [Buffer.from(HTML), null], [Buffer.from(SVG), null], [Buffer.from('%PDF-1.7\n'), null], [Buffer.from('BM6\0\0\0\0\0'), null],
      [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(12, 0)]), null], // an mp4 is not an image
      [Buffer.from([0, 0, 1, 0, 0, 0]), null], // ICO with 0 images
    ];
    const wrong = cases.filter(([b, want]) => sniffImage(b) !== want).map(([b, want]) => `${b.subarray(0, 8).toString('hex')} -> ${sniffImage(b)} (want ${want})`);
    check(`sniffImage: ${cases.length} cases (png jpeg gif webp avif ico; html svg pdf bmp mp4 refused)`, !wrong.length, wrong.join('; '));

    const rend = {
      'https://i.imgur.com/5BWm3bL.png': 'https://i.imgur.com/5BWm3bLl.webp', 'https://i.imgur.com/abcdE12.jpg': 'https://i.imgur.com/abcdE12l.webp',
      'https://i.imgur.com/abcdE12.gif': null, 'http://i.imgur.com/abcdE12.png': null, 'https://i.imgur.com.evil.example/abcdE12.png': null,
      'https://i.imgur.com/a/abcdE12.png': null, 'https://example.com/abcdE12.png': null, 'https://i.imgur.com/abcdE12.png?x=1': null,
    };
    const badRend = Object.entries(rend).filter(([u, want]) => imgurRendition(u) !== want).map(([u]) => u);
    check(`imgurRendition: ${Object.keys(rend).length} cases (only i.imgur.com/<id>.png|jpg|webp over https, never a gif, never another host)`, !badRend.length, badRend.join(', '));

    const cfg = await req('/api/config');
    check('server reachable', cfg.status === 200, `status=${cfg.status}`);

    section('only URLs the server vends (no open relay)');
    const h0 = hits['/logo/real.png'] || 0;
    const unknown = await img(logo('real.png'));
    check('not vended (yet) -> 404, upstream never asked', unknown.status === 404 && (hits['/logo/real.png'] || 0) === h0, `status=${unknown.status}`);
    check('404 answer carries our lockdown headers', !ourHeaders(unknown).length, ourHeaders(unknown).join(' '));
    check('no u -> 400', (await req('/api/img')).status === 400);
    check('u twice (array) -> 400', (await req(`/api/img?u=${enc(logo('real.png'))}&u=x`)).status === 400);
    check('javascript: / file: / data: -> 400', (await img('javascript:alert(1)')).status === 400 && (await img('file:///etc/passwd')).status === 400 && (await img('data:image/png;base64,AAAA')).status === 400);
    check('u over 2048 chars -> 400', (await img(`https://example.com/${'a'.repeat(2100)}.png`)).status === 400);
    check('a random public URL -> 404', (await img('https://example.com/logo.png')).status === 404);

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      skipped('relay sections', 'set ADMIN_EMAIL + ADMIN_PASSWORD (the crafted logos come from a custom M3U source)');
      return;
    }
    const login = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    admin = login.data?.token || null;
    if (!admin) { check('admin login', false, `status=${login.status}`); return; }

    const m3u = '#EXTM3U\n' + LOGOS.map((n, i) => `#EXTINF:-1 tvg-id="img${i}.test" tvg-logo="${logo(n)}",IMG Test ${n}\n${streamOf(n)}\n`).join('');
    const add = await req('/api/admin/sources', { method: 'POST', token: admin, body: { name: 'img-test', text: m3u } });
    check('admin imports an M3U source whose logos are the crafted upstream', add.status === 200, `status=${add.status}`);
    srcId = (add.data?.sources || []).find((s) => s.name === 'img-test')?.id || null;
    let vended = [];
    for (let i = 0; i < 25; i++) {
      const list = await req('/api/catalog/channels?category=custom&limit=120', { token: admin });
      vended = (list.data?.items || []).filter((c) => String(c.url).includes(`run=${RUN}`));
      if (vended.length === LOGOS.length) break;
      await sleep(300);
    }
    check('every crafted logo is vended by the catalog', vended.length === LOGOS.length && vended.every((c) => c.logo?.startsWith(up('/logo/'))), `${vended.length}/${LOGOS.length}`);
    const probe = await img(logo('real.png'));
    if (probe.status === 502) {
      skipped('relay sections', 'start the test server with ALLOW_PRIVATE_SOURCES=true (the upstream is on 127.0.0.1)');
      return;
    }

    section('a real image: 200 with OUR headers only');
    check('vended PNG -> 200, the same bytes', probe.status === 200 && probe.buf.equals(PNG), `status=${probe.status} ${probe.buf.length} B`);
    check('Content-Type is the sniffed one', probe.ct === 'image/png', probe.ct);
    check('Cache-Control public, max-age=86400 (not the upstream "private, max-age=5")', probe.headers.get('cache-control') === 'public, max-age=86400', probe.headers.get('cache-control'));
    check('nosniff + CSP sandbox + CORP same-origin; no Set-Cookie / ACAO / X-Renewed-Token / Link / Refresh / upstream XFO', !ourHeaders(probe).length, ourHeaders(probe).join(' '));
    check('Content-Length is ours (the body length)', Number(probe.headers.get('content-length')) === PNG.length, probe.headers.get('content-length'));
    const withToken = await img(logo('real.png'), { token: admin });
    check('a Bearer token on /api/img: no X-Renewed-Token, still public-cacheable (mounted before authenticate)', withToken.status === 200 && !withToken.headers.get('x-renewed-token') && withToken.headers.get('cache-control') === 'public, max-age=86400');

    section('cache, revalidation, one fetch per URL');
    const h1 = hits['/logo/real.png'] || 0;
    const again = await img(logo('real.png'));
    check('second request served from the relay cache (no upstream hit)', again.status === 200 && (hits['/logo/real.png'] || 0) === h1, `hits +${(hits['/logo/real.png'] || 0) - h1}`);
    const etag = again.headers.get('etag');
    // Cache-Control: max-age=0 is what a browser sends on revalidation; without it,
    // undici's fetch adds "no-cache" to a conditional request (and no-cache never 304s).
    const reval = etag ? await img(logo('real.png'), { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } }) : null;
    check('If-None-Match -> 304', reval?.status === 304, `etag=${etag} status=${reval?.status}`);
    const burst = await Promise.all(Array.from({ length: 6 }, () => img(logo('inflight.png'))));
    check('6 concurrent first requests -> 6 x 200, ONE upstream fetch', burst.every((r) => r.status === 200) && hits['/logo/inflight.png'] === 1, `statuses=${burst.map((r) => r.status)} hits=${hits['/logo/inflight.png']}`);

    section('content sniffing: the label is never trusted');
    const html = await img(logo('html.png'));
    check('HTML served as image/png -> 502 (sniffed: not an image)', html.status === 502, `status=${html.status} ct=${html.ct}`);
    check('the refusal is JSON with our lockdown headers, no upstream byte', html.ct.startsWith('application/json') && !html.buf.toString().includes('<script') && !ourHeaders(html).length, ourHeaders(html).join(' '));
    check('PNG bytes labelled text/html -> 502 (explicit non-image label refused)', (await img(logo('html-label'))).status === 502);
    const oct = await img(logo('octet.jpg'));
    check('JPEG labelled application/octet-stream -> 200 image/jpeg', oct.status === 200 && oct.ct === 'image/jpeg', `${oct.status} ${oct.ct}`);
    const mis = await img(logo('mislabelled'));
    check('GIF labelled image/png -> 200 image/gif (the sniffed type wins)', mis.status === 200 && mis.ct === 'image/gif', `${mis.status} ${mis.ct}`);
    const types = await Promise.all([['webp', 'image/webp'], ['avif', 'image/avif'], ['favicon.ico', 'image/x-icon']].map(async ([n, want]) => { const r = await img(logo(n)); return r.status === 200 && r.ct === want ? '' : `${n}: ${r.status} ${r.ct}`; }));
    check('webp / avif / ico (image/vnd.microsoft.icon) -> 200 with their sniffed type', types.every((x) => !x), types.filter(Boolean).join('; '));
    const poly = await img(logo('polyglot.gif'));
    check('GIF + <script> polyglot -> image/gif under nosniff + sandbox CSP (never rendered as a document)', poly.status === 200 && poly.ct === 'image/gif' && !ourHeaders(poly).length, `${poly.status} ${poly.ct}`);

    section('SVG refused (script risk)');
    const svg = await img(logo('logo.svg'));
    check('image/svg+xml -> 415, never served as SVG', svg.status === 415 && !svg.ct.includes('svg'), `${svg.status} ${svg.ct}`);
    const svg2 = await img(logo('svg-as-png'));
    check('SVG labelled image/png -> 415 (sniffed)', svg2.status === 415 && !svg2.ct.includes('svg'), `${svg2.status} ${svg2.ct}`);

    section('size cap (1 MB)');
    const big = await img(logo('big.png'), { timeout: 15000 });
    check('1.5 MB chunked PNG -> 502 (cap holds mid-body)', big.status === 502, `status=${big.status}`);
    const bigLen = await img(logo('big-len.png'), { timeout: 15000 });
    check('Content-Length 2 MB -> 502 (refused before the body)', bigLen.status === 502, `status=${bigLen.status}`);

    section('SSRF: redirects are re-checked');
    const hr = hits['/logo/real.png'] || 0;
    const other = await img(logo('redir-other'));
    check('LAN logo 302 -> another private host (localhost) -> 502, never fetched', other.status === 502 && (hits['/logo/real.png'] || 0) === hr, `status=${other.status} hits +${(hits['/logo/real.png'] || 0) - hr}`);
    const meta = await img(logo('redir-meta'));
    check('302 -> 169.254.169.254 (cloud metadata) -> 502', meta.status === 502, `status=${meta.status}`);
    const same = await img(logo('redir-same'));
    check('302 within the same LAN host -> 200', same.status === 200 && same.ct === 'image/png', `${same.status} ${same.ct}`);

    section('failures: timeout + negative cache');
    const slow = await img(logo('slow'), { timeout: 20000 });
    check('a stalled upstream -> 502 after the 10 s timeout', slow.status === 502 && slow.ms >= 9000 && slow.ms < 15000, `status=${slow.status} in ${slow.ms} ms`);
    const g1 = await img(logo('gone'));
    const gh = hits['/logo/gone'] || 0;
    const g2 = await img(logo('gone'));
    check('upstream 404 -> 502, then served from the negative cache (no second upstream hit)', g1.status === 502 && g2.status === 502 && (hits['/logo/gone'] || 0) === gh && gh === 1, `statuses=${g1.status},${g2.status} hits=${hits['/logo/gone']}`);
    check('failures are not browser-cacheable (no-store)', g2.headers.get('cache-control') === 'no-store', g2.headers.get('cache-control'));
    const quiet = await img(logo('gone'), { headers: { 'Sec-Fetch-Dest': 'image' } });
    check('an <img> request (Sec-Fetch-Dest: image) for a dead logo -> 204, empty, X-Img-Status 502 (onerror without a console error)',
      quiet.status === 204 && !quiet.buf.length && quiet.headers.get('x-img-status') === '502' && quiet.headers.get('cache-control') === 'no-store' && !ourHeaders(quiet).length,
      `status=${quiet.status} x-img-status=${quiet.headers.get('x-img-status')}`);
    const quietSvg = await img(logo('logo.svg'), { headers: { 'Sec-Fetch-Dest': 'image' } });
    check('... same for a refused SVG (X-Img-Status 415)', quietSvg.status === 204 && quietSvg.headers.get('x-img-status') === '415', `status=${quietSvg.status}`);
    check('... but a URL we do not vend stays a 404 for an <img> too', (await img(logo('real.png?nope'), { headers: { 'Sec-Fetch-Dest': 'image' } })).status === 404);

    section('takedown and source removal stop the relay at once');
    const tdStream = streamOf('takedown.png');
    check('logo relayed before the takedown', (await img(logo('takedown.png'))).status === 200);
    const bl = await req('/api/admin/blocklist', { method: 'POST', token: admin, body: { url: tdStream } });
    try {
      check('blocklisted stream -> its logo is no longer vended -> 404 (even though cached)', bl.status === 200 && (await img(logo('takedown.png'))).status === 404);
    } finally {
      await req(`/api/admin/blocklist?url=${enc(tdStream)}`, { method: 'DELETE', token: admin });
    }
    check('unblocked -> 200 again', (await img(logo('takedown.png'))).status === 200);

    section('catalog + radio logos (real hosts, network permitting)');
    const news = await req('/api/catalog/channels?category=news&limit=40');
    const withLogo = (news.data?.items || []).find((c) => c.logo && !/\.svg$/i.test(new URL(c.logo).pathname));
    if (!withLogo) skipped('iptv-org logo', 'no news channel with a logo');
    else {
      const r = await img(withLogo.logo, { timeout: 15000 });
      check('an iptv-org logo is vended (200, or 502 when its host is down/offline; never 404)', r.status === 200 || r.status === 502, `status=${r.status} ${withLogo.logo}`);
      if (r.status === 200) check('  ... served as a sniffed raster type', /^image\/(png|jpeg|gif|webp|avif|x-icon)$/.test(r.ct), r.ct);
    }
    const radios = await req('/api/radios?limit=60', { timeout: 25000 });
    const st = (radios.data?.items || []).find((s) => s.favicon && !/\.svg$/i.test(s.favicon));
    if (!st) skipped('radio favicon', `radios answered ${radios.status} (radio-browser unreachable?)`);
    else {
      const r = await img(st.favicon, { timeout: 15000 });
      check('a listed radio favicon is vended (200 or 502; never 404)', r.status === 200 || r.status === 502, `status=${r.status} ${st.favicon}`);
    }

    section('source removed -> its logos 404');
    if (srcId) {
      await req(`/api/admin/sources/${srcId}`, { method: 'DELETE', token: admin });
      srcId = null;
      let st404 = 0;
      for (let i = 0; i < 20 && st404 !== 404; i++) { st404 = (await img(logo('real.png'))).status; if (st404 !== 404) await sleep(250); }
      check('deleted source: a cached logo of it -> 404', st404 === 404, `status=${st404}`);
    }

    section('per-IP rate limit (last: it throttles this client for a minute)');
    let first429 = null;
    for (let i = 0; i < 14 && !first429; i++) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => req('/api/img?u=x')));
      first429 = batch.find((r) => r.status === 429) || null;
    }
    check('past 600 requests/min -> 429 with Retry-After', !!first429 && Number(first429.headers.get('retry-after')) > 0, first429 ? '' : 'never throttled');
  } finally {
    if (srcId && admin) await req(`/api/admin/sources/${srcId}`, { method: 'DELETE', token: admin });
    upstream.close();
    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
    if (fails.length) console.log('FAILED:\n  ' + fails.join('\n  '));
    process.exit(fail ? 1 : 0);
  }
})();
