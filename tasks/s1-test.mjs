#!/usr/bin/env node
// NEOWATCH lot S1 test: stream proxy + URL signing + radio signing + health probes
// + SSRF guard. Every audit finding of the lot is reproduced as an attack (a crafted
// upstream served by a tiny local http server started HERE) and must now fail.
//
// Run against a live (throwaway) server started with ALLOW_PRIVATE_SOURCES=true
// (the crafted upstream is on 127.0.0.1) and a known JWT_SECRET:
//   ALLOW_PRIVATE_SOURCES=true JWT_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... PORT=8918 node server/src/index.js
//   BASE=http://localhost:8918 JWT_SECRET=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node tasks/s1-test.mjs
// Env: BASE, JWT_SECRET (the TEST server's, to sign/forge proxy URLs), ADMIN_EMAIL,
// ADMIN_PASSWORD, UPSTREAM_PORT (default 8919). Secrets come from env only.
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8787';
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const UP = Number(process.env.UPSTREAM_PORT) || 8919;
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

const req = async (path, { method = 'GET', token, body, headers = {}, timeout = 15000 } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body) h['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    let data = buf.toString('utf8');
    if (ct.includes('json')) { try { data = JSON.parse(data); } catch { /* keep text */ } }
    return { status: res.status, data, buf, ct, headers: res.headers, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, data: null, buf: Buffer.alloc(0), ct: '', headers: new Headers(), ms: Date.now() - t0, error: String(e?.cause?.code || e?.name || e) };
  } finally {
    clearTimeout(timer);
  }
};

// ── v2 signing, re-implemented from the contract (independent of signing.js) ──
const KEY = JWT_SECRET ? createHmac('sha256', JWT_SECRET).update('neowatch:url-signing:v1').digest('hex') : '';
const TTL = 2 * 3600 * 1000;
const rootTag = (u) => createHash('sha256').update(u).digest('base64url').slice(0, 11);
const sigV2 = (exp, url, { ua, ref, r, lan } = {}) =>
  createHmac('sha256', KEY).update(JSON.stringify(['v2', exp, url, ua || '', ref || '', r || '', lan ? 1 : 0])).digest('base64url');
const sigV1 = (exp, url) => createHmac('sha256', KEY).update(`${exp}\n${url}`).digest('base64url');
function link(url, opts = {}, exp = Date.now() + TTL - 1000) {
  let u = `/api/proxy?url=${enc(url)}`;
  if (opts.ua) u += `&ua=${enc(opts.ua)}`;
  if (opts.ref) u += `&ref=${enc(opts.ref)}`;
  if (opts.r) u += `&r=${enc(opts.r)}`;
  if (opts.lan) u += '&lan=1';
  return `${u}&exp=${exp}&sig=${sigV2(exp, url, opts)}`;
}
const up = (p) => `http://127.0.0.1:${UP}${p}`;
const firstUri = (t) => String(t).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));

// ── The crafted upstream ──
const hits = {};           // path -> count
const seen = {};           // path -> last request headers
const upstream = createServer((q, s) => {
  const path = q.url.split('?')[0];
  hits[path] = (hits[path] || 0) + 1;
  seen[path] = q.headers;
  const send = (code, headers, body) => { s.writeHead(code, headers); s.end(body); };
  switch (path) {
    case '/evil':
      return send(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'pwn=1; Path=/',
        'Clear-Site-Data': '"storage"',
        'Content-Security-Policy': 'x',
        'Strict-Transport-Security': 'max-age=31536000',
        'Access-Control-Allow-Origin': 'https://attacker.example',
        'Access-Control-Allow-Credentials': 'true',
        'Link': '<https://attacker.example/x.css>; rel=preload',
        'Refresh': '0; url=https://attacker.example/',
        'X-Content-Type-Options': 'x',
        'X-Frame-Options': 'ALLOWALL',
        'X-Renewed-Token': 'forged.token.value',
        'Cache-Control': 'public, max-age=60',
      }, '<script>alert(localStorage.getItem("neowatch.token"))</script>');
    case '/img': return send(200, { 'Content-Type': 'image/png' }, Buffer.alloc(400, 0x47));
    case '/svg': return send(200, { 'Content-Type': 'image/svg+xml' }, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    case '/vtt': return send(200, { 'Content-Type': 'text/vtt; charset=utf-8' }, 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n');
    case '/seg1.ts': return send(200, { 'Content-Type': 'video/mp2t' }, Buffer.alloc(1880, 0x47));
    case '/len': return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': '5000', 'Accept-Ranges': 'bytes' }, Buffer.alloc(5000, 1));
    case '/range': {
      if (q.headers.range === 'bytes=0-99') return send(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-99/5000', 'Content-Length': '100', 'Accept-Ranges': 'bytes' }, Buffer.alloc(100, 2));
      return send(200, { 'Content-Type': 'video/mp4', 'Content-Length': '5000' }, Buffer.alloc(5000, 2));
    }
    case '/gz': {
      const z = gzipSync(Buffer.alloc(10000, 0x41));
      return send(200, { 'Content-Type': 'video/mp2t', 'Content-Encoding': 'gzip', 'Content-Length': String(z.length) }, z);
    }
    case '/plain.php': return send(200, { 'Content-Type': 'text/plain' }, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n');
    case '/bom': return send(200, { 'Content-Type': 'application/octet-stream' }, '﻿\n#EXTM3U\n#EXTINF:4,\nseg1.ts\n');
    case '/notfound.m3u8': return send(404, { 'Content-Type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n#EXTINF:4,\nseg1.ts\n');
    case '/fake.m3u8': return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, '<html><script>alert(1)</script></html>\nhttps://example.com/x.html\n');
    case '/keys.m3u8': return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' },
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAAAAAAAAAAAAAAAAAAAA=="\n' +
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key-id-123"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.ts\n');
    case '/uris.m3u8': {
      let b = '#EXTM3U\n';
      for (let i = 0; i < 20_001; i++) b += `s${i}.ts\n`;
      return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, b);
    }
    case '/huge.m3u8': {
      // An endless playlist: never ends on its own, the proxy must cap it.
      s.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      s.write('#EXTM3U\n');
      const chunk = '#EXTINF:1,\n'.repeat(6000);
      const pump = () => { while (!s.destroyed && s.write(chunk)) { /* fill */ } if (!s.destroyed) s.once('drain', pump); };
      s.on('close', () => s.removeAllListeners('drain'));
      return pump();
    }
    case '/reset': {
      // 1000 bytes, then the upstream dies mid-body.
      s.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '50000' });
      s.write(Buffer.alloc(1000, 0x47));
      return setTimeout(() => s.socket.destroy(), 150);
    }
    case '/custom/master.m3u8':
      return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nchild.m3u8\n');
    case '/custom/child.m3u8':
      return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n');
    case '/custom/seg.ts': return send(200, { 'Content-Type': 'video/mp2t' }, Buffer.alloc(1880, 0x47));
    default: return send(404, { 'Content-Type': 'text/plain' }, 'nope');
  }
});

(async () => {
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  try {
    // ── netguard (unit) ──
    section('SSRF guard: ranges + IPv6 literal parsing (SEC-17)');
    const ng = await import(resolve(ROOT, 'server/src/netguard.js'));
    const ipCases = {
      '64:ff9b::a00:1': true, '2002:a00:1::': true, '::7f00:1': true, 'fec0::1': true, '198.18.0.1': true,
      '192.0.0.1': true, '192.0.2.5': true, '198.51.100.7': true, '203.0.113.9': true, '::ffff:10.0.0.1': true,
      '2001::1': true, '2001:db8::1': true, 'fd00::1': true, 'fe80::1%en0': true, '::1': true, '[::1]': true,
      '169.254.169.254': true, '100.64.0.1': true,
      '8.8.8.8': false, '2606:4700::1111': false, '[2606:4700::1111]': false, '::ffff:8.8.8.8': false, '64:ff9b::808:808': false,
    };
    const wrong = Object.entries(ipCases).filter(([ip, want]) => ng.isPrivateIp(ip) !== want).map(([ip]) => ip);
    check(`isPrivateIp: ${Object.keys(ipCases).length} cases (NAT64, 6to4, fec0, benchmark, TEST-NETs, mapped, brackets)`, !wrong.length, wrong.join(', '));
    const rejects = async (u) => ng.assertPublicHost(u).then(() => false, () => true);
    check('assertPublicHost: public IPv6 literal [2606:4700::1111] accepted (was blocked by accident)', !(await rejects('http://[2606:4700::1111]/x')));
    check('assertPublicHost: [::1] / [64:ff9b::a00:1] / [2002:a00:1::] / [::ffff:127.0.0.1] refused',
      (await rejects('http://[::1]/')) && (await rejects('http://[64:ff9b::a00:1]/')) && (await rejects('http://[2002:a00:1::]/')) && (await rejects('http://[::ffff:127.0.0.1]/')));
    check('assertPublicHost: 198.18.0.1 refused', await rejects('http://198.18.0.1/'));

    section('bounded body read (SRV-17 / SEC-9)');
    const endless = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(65536).fill(0x47)); } }));
    let t0 = Date.now();
    const peeked = await ng.readCapped(endless(), 512 * 1024, { truncate: true, peek: ng.startsWithHls });
    check('readCapped stops at the first bytes of a non-playlist (raw live .ts)', peeked.length <= 65536 && Date.now() - t0 < 1000, `${peeked.length} B`);
    const capped = await ng.readCapped(endless(), 200_000, { truncate: true });
    check('readCapped truncate returns exactly the cap of an endless body', capped.length === 200_000);
    const thrown = await ng.readCapped(endless(), 200_000).then(() => null, (e) => e);
    check('readCapped without truncate throws TOO_LARGE', thrown?.code === 'TOO_LARGE');
    check('startsWithHls tolerates BOM + whitespace', ng.startsWithHls(Buffer.from('﻿ \n#EXTM3U\n')) && !ng.startsWithHls(Buffer.from('<html>#EXTM3U')));

    section('signing key never derived from a public literal (SEC-19)');
    const keyOf = () => execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { config } = await import(${JSON.stringify(resolve(ROOT, 'server/src/config.js'))}); process.stdout.write(config.signingSecret);`],
    { env: { ...process.env, JWT_SECRET: '', SIGNING_SECRET: '' }, cwd: ROOT }).toString();
    const k1 = keyOf(), k2 = keyOf();
    const literal = createHmac('sha256', 'neowatch-dev').update('neowatch:url-signing:v1').digest('hex');
    check('JWT_SECRET unset: signing key != HMAC("neowatch-dev")', k1 && k1 !== literal);
    check('JWT_SECRET unset: signing key is per boot (random, like the dev JWT secret)', k1 !== k2);

    if (!JWT_SECRET) {
      skipped('proxy sections', 'set JWT_SECRET to the test server\'s');
      return;
    }
    const cfg = await req('/api/config');
    check('server reachable', cfg.status === 200, `status=${cfg.status}`);
    const probeLan = await req(link(up('/seg1.ts'), { lan: 1 }));
    if (probeLan.status === 502) {
      skipped('proxy sections', 'start the test server with ALLOW_PRIVATE_SOURCES=true');
      return;
    }

    // ── signature scope (SEC-15, SEC-20) ──
    section('signature covers ua/ref/r/lan (SEC-15) + LAN scope (SEC-20)');
    check('v2 link (lan=1) to the local upstream -> 200', probeLan.status === 200, `status=${probeLan.status}`);
    const noLan = await req(link(up('/seg1.ts')));
    check('ALLOW_PRIVATE_SOURCES=true but NOT a custom stream (lan unsigned) -> SSRF guard holds (502)', noLan.status === 502, `status=${noLan.status}`);
    const base = link(up('/seg1.ts'), { lan: 1, ua: 'CatalogUA/1' });
    check('signed ua is sent upstream', (await req(base)).status === 200 && seen['/seg1.ts']?.['user-agent'] === 'CatalogUA/1', seen['/seg1.ts']?.['user-agent']);
    check('ua swapped on a signed link -> 403', (await req(base.replace('ua=CatalogUA%2F1', `ua=${enc('Evil/1.0')}`))).status === 403);
    check('ref added to a signed link -> 403', (await req(base.replace('&exp=', `&ref=${enc('https://attacker.example/')}&exp=`))).status === 403);
    check('lan=1 added to a link signed without it -> 403', (await req(link(up('/seg1.ts')).replace('&exp=', '&lan=1&exp='))).status === 403);
    const withR = link(up('/seg1.ts'), { lan: 1, r: 'abcdefghijk' });
    check('root tag stripped from a signed child link -> 403', (await req(withR.replace('&r=abcdefghijk', ''))).status === 403);
    check('url swapped on a signed link -> 403', (await req(base.replace(enc(up('/seg1.ts')), enc(up('/evil'))))).status === 403);
    const e1 = Date.now() + 3600_000;
    const legacy = await req(`/api/proxy?url=${enc(up('/seg1.ts'))}&exp=${e1}&sig=${sigV1(e1, up('/seg1.ts'))}`);
    check('legacy v1 link vended before this boot still plays (deploy does not cut streams)', legacy.status === 200, `status=${legacy.status}`);
    const e2 = Date.now() + TTL; // "issued" now, i.e. after the server booted
    const forgedV1 = await req(`/api/proxy?url=${enc(up('/seg1.ts'))}&exp=${e2}&sig=${sigV1(e2, up('/seg1.ts'))}`);
    check('v1 link "issued" after this boot -> 403 (the v1 window closes)', forgedV1.status === 403, `status=${forgedV1.status}`);

    // ── response rebuilt, never copied (PLAY-1 / SEC-1) ──
    section('upstream headers + content-type on our origin (PLAY-1 / SEC-1)');
    const evil = await req(link(up('/evil'), { lan: 1 }));
    const H = (k) => evil.headers.get(k);
    check('text/html upstream -> application/octet-stream', H('content-type') === 'application/octet-stream', H('content-type'));
    check('no set-cookie / clear-site-data / HSTS / link / refresh relayed', !H('set-cookie') && !H('clear-site-data') && !H('strict-transport-security') && !H('link') && !H('refresh'));
    check('upstream ACAO/ACAC not relayed (ours: *, no credentials)', H('access-control-allow-origin') === '*' && !H('access-control-allow-credentials'));
    check('CSP forced: default-src \'none\'; sandbox', H('content-security-policy') === "default-src 'none'; sandbox", H('content-security-policy'));
    check('X-Content-Type-Options forced nosniff (upstream "x" overridden)', H('x-content-type-options') === 'nosniff', H('x-content-type-options'));
    check('Cross-Origin-Resource-Policy: same-origin', H('cross-origin-resource-policy') === 'same-origin');
    check('upstream X-Frame-Options ALLOWALL not relayed', H('x-frame-options') !== 'ALLOWALL', H('x-frame-options'));
    check('upstream X-Renewed-Token not relayed', !H('x-renewed-token'));
    check('allowlisted cache-control relayed', H('cache-control') === 'public, max-age=60', H('cache-control'));
    const ctOf = async (p) => (await req(link(up(p), { lan: 1 }))).headers.get('content-type');
    check('image/png (disguised segment) -> octet-stream', (await ctOf('/img')) === 'application/octet-stream');
    check('image/svg+xml -> octet-stream', (await ctOf('/svg')) === 'application/octet-stream');
    check('text/vtt kept', (await ctOf('/vtt')) === 'text/vtt');
    check('video/mp2t kept', (await ctOf('/seg1.ts')) === 'video/mp2t');

    section('content-length + range (PLAY-15)');
    const len = await req(link(up('/len'), { lan: 1 }));
    check('unencoded upstream: Content-Length forwarded', len.headers.get('content-length') === '5000' && len.buf.length === 5000, `len=${len.headers.get('content-length')}`);
    check('accept-ranges relayed', len.headers.get('accept-ranges') === 'bytes');
    const rng = await req(link(up('/range'), { lan: 1 }), { headers: { Range: 'bytes=0-99' } });
    check('Range forwarded: 206 + content-range + length', rng.status === 206 && rng.headers.get('content-range') === 'bytes 0-99/5000' && rng.buf.length === 100, `status=${rng.status} cr=${rng.headers.get('content-range')}`);
    const gz = await req(link(up('/gz'), { lan: 1 }));
    check('gzip upstream: decoded body, compressed length NOT forwarded', gz.buf.length === 10000 && gz.headers.get('content-length') !== String(gzipSync(Buffer.alloc(10000, 0x41)).length), `body=${gz.buf.length} len=${gz.headers.get('content-length')}`);

    // ── playlist detection + rewrite (PLAY-3, PLAY-14, SEC-1 part 4) ──
    section('playlist sniffing + rewrite (PLAY-3 / PLAY-14)');
    const plain = await req(link(up('/plain.php'), { lan: 1 }));
    const child = firstUri(plain.data);
    check('text/plain .php playlist is rewritten (sniffed #EXTM3U)', /^\/api\/proxy\?url=/.test(child || ''), child);
    check('rewritten playlist served as mpegurl + sandboxed', plain.ct.startsWith('application/vnd.apple.mpegurl') && plain.headers.get('content-security-policy') === "default-src 'none'; sandbox");
    check('child link carries the root tag + lan, and plays', child?.includes(`&r=${rootTag(up('/plain.php'))}`) && child?.includes('&lan=1') && (await req(child)).status === 200);
    const bom = await req(link(up('/bom'), { lan: 1 }));
    check('BOM + octet-stream playlist is rewritten', /^\/api\/proxy\?url=/.test(firstUri(bom.data) || ''));
    const nf = await req(link(up('/notfound.m3u8'), { lan: 1 }));
    check('404 playlist body is relayed raw, never rewritten/re-signed', nf.status === 404 && !String(nf.data).includes('/api/proxy') && String(nf.data).includes('seg1.ts'));
    const fake = await req(link(up('/fake.m3u8'), { lan: 1 }));
    check('mpegurl label on a non-HLS body: not rewritten (no URL signed), sandboxed', !String(fake.data).includes('/api/proxy') && fake.headers.get('content-security-policy') === "default-src 'none'; sandbox");
    const keys = await req(link(up('/keys.m3u8'), { lan: 1 }));
    const kt = String(keys.data);
    check('data: key URI left untouched', kt.includes('URI="data:text/plain;base64,AAAAAAAAAAAAAAAAAAAAAA=="'));
    check('skd: key URI left untouched', kt.includes('URI="skd://key-id-123"'));
    check('relative EXT-X-MAP URI still rewritten', /URI="\/api\/proxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Finit\.mp4/.test(kt));

    section('manifest bounds + micro-cache (PLAY-13 / SEC-9)');
    t0 = Date.now();
    const huge = await req(link(up('/huge.m3u8'), { lan: 1 }), { timeout: 25000 });
    check('endless playlist -> 502 (capped), not buffered forever', huge.status === 502, `status=${huge.status} after ${Date.now() - t0} ms`);
    const uris = await req(link(up('/uris.m3u8'), { lan: 1 }));
    check('playlist with > 20000 URIs -> 502', uris.status === 502, `status=${uris.status}`);
    const before = hits['/plain.php'] || 0;
    const l2 = link(up(`/plain.php?mc=${Date.now()}`), { lan: 1 }); // a target not cached yet
    await req(l2); await req(l2);
    check('micro-cache still collapses back-to-back manifest fetches (1 upstream hit)', (hits['/plain.php'] || 0) - before === 1, `hits=${(hits['/plain.php'] || 0) - before}`);
    check('server still healthy after the oversize attacks', (await req('/api/health')).status === 200);

    section('mid-stream upstream failure (PLAY-5)');
    const reset = await req(link(up('/reset'), { lan: 1 }), { timeout: 12000 });
    check('upstream reset mid-body -> client connection cut quickly (not left hanging)', reset.status === 0 && reset.ms < 5000 && reset.error !== 'AbortError', `status=${reset.status} ${reset.ms} ms ${reset.error || ''}`);

    // ── custom source end to end: LAN scope, health headers, takedown ──
    let admin = null;
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      const login = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
      admin = login.data?.token || null;
    }
    if (!admin) {
      skipped('custom source / health / takedown sections', 'set ADMIN_EMAIL + ADMIN_PASSWORD');
    } else {
      section('custom (M3U) source on the LAN: proxy allowed only for it (SEC-20)');
      // Unique per run: the health verdict of a previous run must not be reused.
      const master = up(`/custom/master.m3u8?run=${Date.now()}`);
      const m3u = `#EXTM3U\n#EXTINF:-1 tvg-id="s1test.lan",S1 Test LAN\n#EXTVLCOPT:http-user-agent=CatalogUA/1\n${master}\n`;
      const add = await req('/api/admin/sources', { method: 'POST', token: admin, body: { name: 's1-test', text: m3u } });
      check('admin imports a LAN M3U source', add.status === 200, `status=${add.status} ${JSON.stringify(add.data).slice(0, 120)}`);
      const srcId = (add.data?.sources || []).find((s) => s.name === 's1-test')?.id;
      try {
        let ch = null;
        for (let i = 0; i < 20 && !ch; i++) {
          const list = await req('/api/catalog/channels?category=custom&limit=50', { token: admin });
          ch = (list.data?.items || []).find((c) => c.url === master) || null;
          if (!ch) await sleep(300);
        }
        check('custom channel vended with a signed proxyUrl', !!ch?.proxyUrl, ch ? 'no proxyUrl' : 'not in catalog');
        if (ch?.proxyUrl) {
          let mres = null;
          for (let i = 0; i < 8; i++) { mres = await req(ch.proxyUrl); if (mres.status === 200) break; await sleep(800); }
          const c1 = firstUri(mres?.data);
          check('custom LAN master plays through the proxy (custom -> guard opened)', mres?.status === 200 && /^\/api\/proxy\?/.test(c1 || ''), `status=${mres?.status}`);
          check('catalog UA used for the custom stream', seen['/custom/master.m3u8']?.['user-agent'] === 'CatalogUA/1', seen['/custom/master.m3u8']?.['user-agent']);
          const cres = c1 ? await req(c1) : null;
          const segLink = firstUri(cres?.data);
          check('child playlist + segment of the custom stream play (lan inherited)', cres?.status === 200 && (await req(segLink)).status === 200);

          section('health probes: catalog headers, force admin-only (SEC-8 / SRV-13 / SRV-12)');
          const h0 = hits['/custom/master.m3u8'] || 0;
          const ck = await req('/api/catalog/check', { method: 'POST', body: { items: [{ id: 'x', url: master, ua: 'Evil/1.0', ref: 'https://attacker.example/' }], force: true } });
          const sawUa = seen['/custom/master.m3u8']?.['user-agent'];
          check('check probes once', ck.status === 200 && (hits['/custom/master.m3u8'] || 0) - h0 === 1, `status=${ck.status} hits=${(hits['/custom/master.m3u8'] || 0) - h0}`);
          check('client ua ignored: probe used the catalog UA', sawUa === 'CatalogUA/1', sawUa);
          check('client referer ignored', !seen['/custom/master.m3u8']?.referer, seen['/custom/master.m3u8']?.referer);
          check('verdict carries checkedAt', typeof ck.data?.results?.[0]?.checkedAt === 'number');
          const h1 = hits['/custom/master.m3u8'] || 0;
          await req('/api/catalog/check', { method: 'POST', body: { items: [{ id: 'x', url: master }], force: true } });
          check('anonymous force:true does NOT bypass the 5 min cache', (hits['/custom/master.m3u8'] || 0) === h1, `hits=${(hits['/custom/master.m3u8'] || 0) - h1}`);
          await req('/api/catalog/check', { method: 'POST', token: admin, body: { items: [{ id: 'x', url: master }], force: true } });
          check('admin force:true re-probes', (hits['/custom/master.m3u8'] || 0) === h1 + 1, `hits=${(hits['/custom/master.m3u8'] || 0) - h1}`);

          section('takedown enforced at serve time (SEC-15)');
          const bl = await req('/api/admin/blocklist', { method: 'POST', token: admin, body: { url: master } });
          check('admin blocklists the stream', bl.status === 200, `status=${bl.status}`);
          try {
            await sleep(2200); // root-tag snapshot refresh
            check('previously vended master link -> 410', (await req(ch.proxyUrl)).status === 410);
            check('previously vended child playlist link -> 410 (root tag)', (await req(c1)).status === 410);
            check('previously vended segment link -> 410 (root tag)', (await req(segLink)).status === 410);
          } finally {
            await req(`/api/admin/blocklist?url=${enc(master)}`, { method: 'DELETE', token: admin });
          }
        }
      } finally {
        if (srcId) await req(`/api/admin/sources/${srcId}`, { method: 'DELETE', token: admin });
      }
    }

    // ── radio (SRV-6 / SEC-13 / PLAY-21) ──
    section('radio proxy links signed per response (SRV-6)');
    const r1 = await req('/api/radios?limit=5', { timeout: 25000 });
    if (r1.status !== 200 || !r1.data?.items?.length) {
      skipped('radio checks', `radios answered ${r1.status} (radio-browser unreachable?)`);
    } else {
      await sleep(20);
      const r2 = await req('/api/radios?limit=5');
      const expOf = (u) => Number(new URL(u, BASE).searchParams.get('exp'));
      const x1 = expOf(r1.data.items[0].proxyUrl), x2 = expOf(r2.data.items[0].proxyUrl);
      check('radio proxyUrl expires ~2h from NOW (fresh signature)', x2 - Date.now() > TTL - 60_000, `${Math.round((x2 - Date.now()) / 60000)} min left`);
      check('two responses carry two signatures (not one cached for 6h)', x2 > x1);
      check('radio proxyUrl verifies on the proxy (not 403)', (await req(r2.data.items[0].proxyUrl, { timeout: 6000 })).status !== 403);
    }
  } finally {
    upstream.close();
    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
    if (fails.length) console.log('FAILED:\n  ' + fails.join('\n  '));
    process.exit(fail ? 1 : 0);
  }
})();
