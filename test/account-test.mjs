#!/usr/bin/env node
// NEOWATCH lot S3 test: auth inputs + roaming storage + pairing, billing (mock / prod
// closed / Stripe webhook with signed fake events), sources + EPG (public projections,
// admin lists, keep-last-good, serialized rebuilds, save-chain recovery, linear XMLTV
// parser, streaming size cap, throttled search), films (listed ids only).
//
// The suite starts no NEOWATCH server; it starts tiny local upstreams (M3U/XMLTV feed,
// fake Stripe API). Pick the mode matching how the server was started:
//
//  S3_MODE=dev     (default) server: ALLOW_PRIVATE_SOURCES=true (the local feed is 127.0.0.1)
//  S3_MODE=prod    server: NODE_ENV=production (mock billing must be closed)
//  S3_MODE=stripe  server: BILLING_PROVIDER=stripe STRIPE_SECRET=sk_test_x STRIPE_PRICE_ID=price_x
//                  STRIPE_WEBHOOK_SECRET=<same as below> STRIPE_API_BASE=http://127.0.0.1:<STRIPE_PORT>
//
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, DATA_DIR (the server's, for the write-failure
// checks), FEED_PORT (8781), STRIPE_PORT (8782), STRIPE_WEBHOOK_SECRET.
// Admin creds come from env only -- never hardcode them.
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { parseXmltv } from '../server/src/epg.js';

const BASE = process.env.BASE || 'http://localhost:8787';
const MODE = process.env.S3_MODE || 'dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || '';
const FEED_PORT = Number(process.env.FEED_PORT) || 8781;
const STRIPE_PORT = Number(process.env.STRIPE_PORT) || 8782;
const WHSEC = process.env.STRIPE_WEBHOOK_SECRET || '';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n=== ${t} ===`);
const req = async (path, { method = 'GET', token, body, raw, headers: extra = {}, timeout = 20000, retry429 = true } = {}) => {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && raw === undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), signal: ctrl.signal });
    // Auth routes are limited to 30/min per IP; this suite makes more. Wait the window out once.
    if (res.status === 429 && retry429) {
      const wait = Number(res.headers.get('retry-after')) || 5;
      console.log(`  .. 429 on ${path}, waiting ${wait}s`);
      await sleep((wait + 0.5) * 1000);
      return req(path, { method, token, body, raw, headers: extra, timeout, retry429: false });
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    return { status: res.status, data, headers: res.headers };
  } catch (e) {
    return { status: 0, data: null, headers: new Headers(), error: e?.name };
  } finally {
    clearTimeout(timer);
  }
};
const cc = (r) => r.headers.get('cache-control') || '';
let n = 0;
const ts = Date.now();
async function register(tag) {
  const r = await req('/api/auth/register', { method: 'POST', body: { email: `s3${tag}${ts}${n++}@test.local`, password: 'secret123' } });
  if (!r.data?.token) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.data)}`);
  return { token: r.data.token, user: r.data.user };
}

// ── local upstream: M3U + XMLTV feed with switchable failure / delay ──
const feed = { m3uFail: false, xmlFail: false, slowMs: 0, hugeBytes: 0 };
const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const xmltvNow = () => {
  const now = Date.now();
  return `<?xml version="1.0"?><tv><programme start="${fmt(now - 3600e3)}" stop="${fmt(now + 3600e3)}" channel="S3Test.fr"><title>Grand Journal S3 ${ts}</title></programme></tv>`;
};
const feedServer = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, 'http://x');
  if (u.pathname.startsWith('/slow')) await sleep(feed.slowMs);
  if (u.pathname.endsWith('.m3u')) {
    if (feed.m3uFail && !u.pathname.startsWith('/slow')) { rs.writeHead(500); return rs.end('down'); }
    const tag = u.searchParams.get('tag') || 'a';
    rs.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    return rs.end(`#EXTM3U\n#EXTINF:-1 tvg-id="S3${tag}.x" group-title="News",S3 ${tag} channel\nhttps://example.com/s3-${tag}-${ts}/stream.m3u8\n`);
  }
  if (u.pathname === '/guide.xml') {
    if (feed.xmlFail) { rs.writeHead(503); return rs.end('busy'); }
    rs.writeHead(200, { 'Content-Type': 'application/xml' });
    return rs.end(xmltvNow());
  }
  if (u.pathname === '/huge.xml') {
    // Chunked (no content-length): only an incremental cap can stop it.
    rs.writeHead(200, { 'Content-Type': 'application/xml' });
    const chunk = Buffer.alloc(1 << 20, 'a');
    let sent = 0;
    rs.write('<tv>');
    const pump = () => {
      while (sent < feed.hugeBytes) {
        sent += chunk.length;
        if (!rs.write(chunk)) return rs.once('drain', pump);
      }
      rs.end('</tv>');
    };
    rs.on('error', () => {});
    return pump();
  }
  rs.writeHead(404); rs.end();
});

// ── fake Stripe API (records every call) ──
const stripeCalls = [];
const fakeStripe = { failDelete: false };
const stripeServer = http.createServer((rq, rs) => {
  let b = '';
  rq.on('data', (c) => { b += c; });
  rq.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(b));
    stripeCalls.push({ method: rq.method, path: rq.url, form, auth: rq.headers.authorization });
    const json = (code, o) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)); };
    if (rq.url === '/checkout/sessions' && rq.method === 'POST') {
      // Real Stripe refuses the pair.
      if (form.customer && form.customer_email) return json(400, { error: { message: 'You may only specify one of these parameters: customer, customer_email.' } });
      return json(200, { id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' });
    }
    if (rq.url.startsWith('/subscriptions/')) {
      if (rq.method === 'DELETE' && fakeStripe.failDelete) return json(500, { error: { message: 'boom' } });
      return json(200, { id: rq.url.split('/')[2], status: rq.method === 'DELETE' ? 'canceled' : 'active' });
    }
    json(404, { error: { message: 'no route' } });
  });
});
const sign = (payload, secret = WHSEC, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
let evtSeq = 0;
const created0 = Math.floor(Date.now() / 1000);
async function hook(type, object, { id, created, sigHeader } = {}) {
  const evt = { id: id || `evt_s3_${ts}_${evtSeq++}`, type, created: created ?? created0 + evtSeq, data: { object } };
  const payload = JSON.stringify(evt);
  const r = await req('/api/billing/webhook', { method: 'POST', raw: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sigHeader || sign(payload) } });
  return { ...r, evt };
}
const userById = async (adminTok, id) => (await req('/api/admin/users', { token: adminTok })).data?.users?.find((u) => u.id === id);

const listen = (srv, port) => new Promise((ok, ko) => { srv.once('error', ko); srv.listen(port, '127.0.0.1', ok); });

(async () => {
  await listen(feedServer, FEED_PORT);
  if (MODE === 'stripe') await listen(stripeServer, STRIPE_PORT);
  const FEED = `http://127.0.0.1:${FEED_PORT}`;

  const admin = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const adminTok = admin.data?.token;
  check('admin login', !!adminTok, admin.data?.error);

  // ════════════════ common ════════════════
  section('auth: typed + capped inputs (SEC-6)');
  {
    const t0 = Date.now();
    const arr = await req('/api/auth/register', { method: 'POST', body: { email: `arr${ts}@test.local`, password: ['a', 'b', 'c', 'd', 'e', 'f'] }, timeout: 5000 });
    check('register with an array password -> 400, no hang', arr.status === 400 && Date.now() - t0 < 4000, `status=${arr.status}`);
    const objName = await req('/api/auth/register', { method: 'POST', body: { email: `obj${ts}@test.local`, password: 'secret123', name: { evil: true } } });
    check('register with an object name -> 400', objName.status === 400, `status=${objName.status}`);
    const longEmail = await req('/api/auth/register', { method: 'POST', body: { email: `${'a'.repeat(260)}@test.local`, password: 'secret123' } });
    check('register with a 270-char email -> 400', longEmail.status === 400);
    const badEmail = await req('/api/auth/register', { method: 'POST', body: { email: 'not-an-email', password: 'secret123' } });
    check('register with a malformed email -> 400', badEmail.status === 400);
    const longPw = await req('/api/auth/register', { method: 'POST', body: { email: `lp${ts}@test.local`, password: 'x'.repeat(129) } });
    check('register with a 129-char password -> 400', longPw.status === 400);
    const longName = await req('/api/auth/register', { method: 'POST', body: { email: `ln${ts}@test.local`, password: 'secret123', name: 'N'.repeat(500) } });
    check('long name is capped to 60', longName.status === 200 && longName.data?.user?.name?.length === 60, `len=${longName.data?.user?.name?.length}`);
    const loginArr = await req('/api/auth/login', { method: 'POST', body: { email: ['x'], password: { a: 1 } }, timeout: 5000 });
    check('login with non-string fields -> 401 (no hang)', loginArr.status === 401, `status=${loginArr.status}`);
    const u = await register('pw');
    const pwArr = await req('/api/auth/password', { method: 'PUT', token: u.token, body: { currentPassword: 'secret123', newPassword: ['a', 'b', 'c', 'd', 'e', 'f'] }, timeout: 5000 });
    check('PUT /auth/password with array newPassword -> 400', pwArr.status === 400, `status=${pwArr.status}`);
    const admArr = await req('/api/admin/users', { method: 'POST', token: adminTok, body: { email: `aa${ts}@test.local`, password: ['1', '2', '3', '4', '5', '6'] }, timeout: 5000 });
    check('admin POST /users with array password -> 400', admArr.status === 400, `status=${admArr.status}`);
    const admPatch = await req(`/api/admin/users/${u.user.id}`, { method: 'PATCH', token: adminTok, body: { password: ['1', '2', '3', '4', '5', '6'] }, timeout: 5000 });
    check('admin PATCH with array password -> 400', admPatch.status === 400, `status=${admPatch.status}`);
    const admPatchShort = await req(`/api/admin/users/${u.user.id}`, { method: 'PATCH', token: adminTok, body: { password: '123' } });
    check('admin PATCH with a short password -> 400 (no silent ignore)', admPatchShort.status === 400);
    const admPatchName = await req(`/api/admin/users/${u.user.id}`, { method: 'PATCH', token: adminTok, body: { name: 'Renamed' } });
    check('admin PATCH name only still works', admPatchName.status === 200 && admPatchName.data?.user?.name === 'Renamed');
  }

  section('roaming storage: favorites + multi validated, no proxyUrl (SEC-7)');
  const roam = await register('roam');
  {
    const fav = await req('/api/auth/favorites', { method: 'PUT', token: roam.token, body: { favorites: ['https://a.example/x.m3u8', { evil: 1 }, 42, 'javascript:alert(1)', `https://b.example/${'x'.repeat(3000)}`, 'https://a.example/x.m3u8', 'https://c.example/y.m3u8'] } });
    check('favorites keep only http(s) url strings <= 2048, deduped', JSON.stringify(fav.data?.favorites) === JSON.stringify(['https://a.example/x.m3u8', 'https://c.example/y.m3u8']), JSON.stringify(fav.data?.favorites));
    const tile = { id: 'abc', name: 'Tile', url: 'https://a.example/x.m3u8', kind: 'hls', proxyUrl: '/api/proxy?url=x&sig=y', online: true, latency: 12, junk: 'z'.repeat(5000), alternates: [{ url: 'https://alt.example/1.m3u8', proxyUrl: '/api/proxy?sig=1' }] };
    const multi = await req('/api/auth/multi', { method: 'PUT', token: roam.token, body: { multi: [tile, { name: 'no url' }, 'str', ...Array(12).fill(tile)] } });
    const m0 = multi.data?.multi?.[0] || {};
    check('multi tile keeps url/name/kind', m0.url === tile.url && m0.name === 'Tile' && m0.kind === 'hls');
    check('multi tile drops proxyUrl + volatile + unknown fields', !('proxyUrl' in m0) && !('online' in m0) && !('latency' in m0) && !('junk' in m0), Object.keys(m0).join(','));
    check('multi alternates carry no signed proxyUrl', m0.alternates?.[0]?.url === 'https://alt.example/1.m3u8' && m0.alternates?.[0]?.proxyUrl === null);
    check('multi capped at 9 valid tiles', (multi.data?.multi?.length || 0) <= 9, `len=${multi.data?.multi?.length}`);
  }

  section('prefs no-store scoped to its routes (BIZ-M1)');
  {
    const meta = await req('/api/catalog/meta');
    check('/api/catalog/meta no longer carries no-store', !/no-store/.test(cc(meta)), `cache-control=${cc(meta)}`);
    const prefs = await req('/api/me/prefs', { token: roam.token });
    check('/api/me/prefs keeps private, no-store', prefs.status === 200 && /no-store/.test(cc(prefs)) && /private/.test(cc(prefs)), cc(prefs));
    const health = await req('/api/films');
    check('/api/films not marked no-store', !/no-store/.test(cc(health)), cc(health));
  }

  section('GDPR export (BIZ-19)');
  {
    const ex = await req('/api/auth/me/export', { token: roam.token });
    const body = JSON.stringify(ex.data || {});
    check('export 200 as an attachment', ex.status === 200 && /attachment/.test(ex.headers.get('content-disposition') || ''));
    check('export holds the account + favorites + multi', ex.data?.account?.email === roam.user.email && ex.data?.account?.favorites?.length === 2 && Array.isArray(ex.data?.account?.multi));
    check('export never carries the password hash / token version', !/passwordHash|tokenVersion|\$2[aby]\$/.test(body));
    check('export is no-store', /no-store/.test(cc(ex)));
    check('export without a token -> 401', (await req('/api/auth/me/export')).status === 401);
  }

  section('TV pairing: per-IP cap with eviction, /device/info throttled (SEC-12)');
  {
    const starts = [];
    for (let i = 0; i < 7; i++) starts.push((await req('/api/auth/device/start', { method: 'POST', body: {} })).data);
    check('7 starts from one IP all answered (no global 503)', starts.every((s) => s?.deviceCode));
    const poll0 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: starts[0].deviceCode } });
    const poll1 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: starts[1].deviceCode } });
    const poll6 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: starts[6].deviceCode } });
    check('oldest 2 of this IP evicted (cap 5)', poll0.data?.status === 'expired' && poll1.data?.status === 'expired', `${poll0.data?.status},${poll1.data?.status}`);
    check('newest pairing still pending', poll6.data?.status === 'pending');
    const info = await req(`/api/auth/device/info?code=${starts[6].userCode}`);
    check('device/info sees the pending code', info.data?.valid === true);
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) limited = (await req('/api/auth/device/info?code=AAAAAA', { retry429: false })).status === 429;
    check('device/info is rate limited', limited);
  }

  section('sources: public projection vs admin list (SEC-3 / BIZ-6 / SRV-7)');
  const canFeed = MODE === 'dev';
  if (!canFeed) {
    const priv = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: 'ssrf', url: `${FEED}/a.m3u` } });
    check('admin source on 127.0.0.1 refused without ALLOW_PRIVATE_SOURCES (SSRF)', priv.status === 400, `status=${priv.status}`);
  }
  {
    const inline = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: `inl${ts}`, text: `#EXTM3U\n#EXTINF:-1,S3 inline\nhttps://example.com/s3-inline-${ts}/i.m3u8\n` } });
    check('admin import inline M3U', inline.status === 200);
    const badName = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: { x: 1 }, text: '#EXTM3U' } });
    check('admin source with an object name -> 400', badName.status === 400);
    const pub = await req('/api/sources');
    const pubBody = JSON.stringify(pub.data);
    check('public /api/sources lists the source', pub.status === 200 && pub.data?.sources?.some((s) => s.name === `inl${ts}`));
    check('public /api/sources has no url / lastError', !/"url"|"lastError"/.test(pubBody), pubBody.slice(0, 200));
    const adm = await req('/api/admin/sources', { token: adminTok });
    check('GET /api/admin/sources (admin) has url + lastError fields', adm.status === 200 && adm.data?.sources?.every((s) => 'url' in s && 'lastError' in s));
    check('GET /api/admin/sources as a user -> 403', (await req('/api/admin/sources', { token: roam.token })).status === 403);
    const id = adm.data?.sources?.find((s) => s.name === `inl${ts}`)?.id;
    await req(`/api/admin/sources/${id}`, { method: 'DELETE', token: adminTok });
  }

  if (canFeed) {
    section('sources: keep last good on a failed fetch, serialized rebuilds (SRV-8 / SRV-20)');
    const find = async (tag) => (await req(`/api/catalog/channels?category=custom&limit=120`, { token: adminTok })).data?.items?.some((i) => i.url?.includes(`s3-${tag}-${ts}`));
    const addA = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: `A${ts}`, url: `${FEED}/a.m3u?tag=a` } });
    check('add URL source A', addA.status === 200, JSON.stringify(addA.data));
    check('source A channel in the catalog', await find('a'));
    feed.m3uFail = true;
    const ref = await req('/api/admin/sources/refresh', { method: 'POST', token: adminTok });
    const srcA = ref.data?.sources?.find((s) => s.name === `A${ts}`);
    check('refresh with the provider down records lastError', !!srcA?.lastError, JSON.stringify(srcA));
    check('... but keeps the channels (count + catalog)', srcA?.count === 1 && (await find('a')));
    feed.m3uFail = false;
    // Race: a slow refresh in flight, then a delete. The deleted source must not come back.
    const addB = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: `B${ts}`, url: `${FEED}/slow/b.m3u?tag=b` } });
    check('add slow source B', addB.status === 200);
    feed.slowMs = 2500;
    const idA = addB.data?.sources?.find((s) => s.name === `A${ts}`)?.id;
    const idB = addB.data?.sources?.find((s) => s.name === `B${ts}`)?.id;
    const slowRefresh = req('/api/admin/sources/refresh', { method: 'POST', token: adminTok });
    await sleep(300);
    const del = await req(`/api/admin/sources/${idA}`, { method: 'DELETE', token: adminTok });
    await slowRefresh;
    feed.slowMs = 0;
    check('delete during a slow refresh -> 200', del.status === 200);
    check('deleted source A does not reappear after the slow refresh finishes', !(await find('a')));
    check('source B still there', await find('b'));
    await req(`/api/admin/sources/${idB}`, { method: 'DELETE', token: adminTok });

    section('EPG: projections, keep last good, single download, size cap (SRV-8 / SRV-14 / SEC-3)');
    const addE = await req('/api/admin/epg', { method: 'POST', token: adminTok, body: { name: `G${ts}`, url: `${FEED}/guide.xml` } });
    check('admin add XMLTV url', addE.status === 200, JSON.stringify(addE.data));
    const now1 = await req('/api/epg/now?ids=S3Test.fr');
    check('now/next from the new guide', now1.data?.channels?.['S3Test.fr']?.now?.title === `Grand Journal S3 ${ts}`);
    const pubE = await req('/api/epg/sources');
    check('public /api/epg/sources has no url / lastError', pubE.status === 200 && !/"url"|"lastError"/.test(JSON.stringify(pubE.data)));
    const admE = await req('/api/admin/epg', { token: adminTok });
    check('GET /api/admin/epg (admin) lists urls', admE.status === 200 && admE.data?.sources?.some((s) => s.url === `${FEED}/guide.xml`));
    check('GET /api/admin/epg as a user -> 403', (await req('/api/admin/epg', { token: roam.token })).status === 403);
    feed.xmlFail = true;
    const refE = await req('/api/admin/epg/refresh', { method: 'POST', token: adminTok });
    check('EPG refresh with the feed down -> 200', refE.status === 200);
    const now2 = await req('/api/epg/now?ids=S3Test.fr');
    check('guide kept after a failed refresh', now2.data?.channels?.['S3Test.fr']?.now?.title === `Grand Journal S3 ${ts}`);
    const admE2 = await req('/api/admin/epg', { token: adminTok });
    check('admin sees lastError on the failing source', !!admE2.data?.sources?.find((s) => s.name === `G${ts}`)?.lastError);
    feed.xmlFail = false;
    const search = await req(`/api/epg/search?q=${encodeURIComponent('grand journal s3')}`);
    check('EPG search 200 (precomputed titles)', search.status === 200 && Array.isArray(search.data?.results));
    const s1 = await req('/api/epg/search?q=a');
    check('1-char EPG query returns nothing (min 2)', s1.status === 200 && s1.data?.results?.length === 0);
    feed.hugeBytes = 90 * 1024 * 1024;
    const huge = await req('/api/admin/epg', { method: 'POST', token: adminTok, body: { name: 'huge', url: `${FEED}/huge.xml` }, timeout: 60000 });
    check('chunked 90 MB XMLTV refused by the streaming cap', huge.status === 400 && /too large/.test(huge.data?.error || ''), `${huge.status} ${huge.data?.error}`);
    const gid = admE2.data?.sources?.find((s) => s.name === `G${ts}`)?.id;
    await req(`/api/admin/epg/${gid}`, { method: 'DELETE', token: adminTok });
  }

  section('EPG search throttled (SEC-11)');
  {
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) limited = (await req('/api/epg/search?q=zz', { retry429: false })).status === 429;
    check('/api/epg/search rate limited', limited);
  }

  section('XMLTV parser linear on unclosed tags (SEC-10)');
  {
    const bomb = '<programme a>'.repeat(40_000); // 520 kB, used to take ~2.7 s
    let t = Date.now();
    parseXmltv(bomb);
    const tBomb = Date.now() - t;
    check('520 kB of unclosed <programme> parses in < 200 ms', tBomb < 200, `${tBomb} ms`);
    const titles = `<tv><programme start="20260101120000 +0000" channel="x.y">${'<title>'.repeat(40_000)}</programme></tv>`;
    t = Date.now();
    const r = parseXmltv(titles);
    check('unclosed <title> x40k inside one programme is linear too', Date.now() - t < 200 && r.total === 1, `${Date.now() - t} ms`);
    const xml = '<tv><programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="CNN.us@SD"><title lang="en">News &amp; Sport</title><desc>D</desc></programme><programmes/><programme start="20260101130000 +0200" channel="TF1.fr"><title>Le Foot</title></programme><programme start="20260101140000" channel="trunc.fr"><title>cut';
    const p = parseXmltv(xml);
    check('parser still reads normal programmes (2) and stops on a truncated tail', p.total === 2 && p.map.get('cnn.us')?.[0]?.title === 'News & Sport' && p.map.get('cnn.us')?.[0]?.desc === 'D', `total=${p.total}`);
  }

  section('films: only listed ids are resolved (SRV-15)');
  {
    const rnd = await req('/api/films/not-a-listed-item-' + ts + '/play');
    check('unlisted archive.org id -> 404 (or 503 if archive.org is down), never 200', rnd.status === 404 || rnd.status === 503, `status=${rnd.status}`);
    const films = await req('/api/films', { timeout: 30000 });
    if (films.status === 200 && films.data?.films?.length) {
      const play = await req(`/api/films/${encodeURIComponent(films.data.films[0].id)}/play`, { timeout: 30000 });
      check('a listed film still resolves (200 or 404 no playable file)', play.status === 200 || play.status === 404, `status=${play.status}`);
    } else console.log(`  SKIP  archive.org unreachable (films ${films.status})`);
  }

  if (DATA_DIR) {
    section('save chain survives a failed write, no hang (SRV-9)');
    await chmod(DATA_DIR, 0o555);
    const t0 = Date.now();
    const failReg = await req('/api/auth/register', { method: 'POST', body: { email: `ro${ts}@test.local`, password: 'secret123' }, timeout: 8000 });
    const failSrc = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: `ro${ts}`, text: `#EXTM3U\n#EXTINF:-1,RO\nhttps://example.com/ro-${ts}.m3u8\n` }, timeout: 8000 });
    await chmod(DATA_DIR, 0o755);
    check('register on a read-only data dir -> 500 JSON, not a hang', failReg.status === 500 && Date.now() - t0 < 8000, `status=${failReg.status}`);
    check('source import on a read-only data dir -> 500 JSON, not a hang', failSrc.status === 500, `status=${failSrc.status}`);
    const okReg = await req('/api/auth/register', { method: 'POST', body: { email: `rw${ts}@test.local`, password: 'secret123' } });
    check('the next users.json write works again (queue not poisoned)', okReg.status === 200);
    const okSrc = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: `rw${ts}`, text: `#EXTM3U\n#EXTINF:-1,RW\nhttps://example.com/rw-${ts}.m3u8\n` } });
    check('the next sources.json write works again', okSrc.status === 200);
    for (const s of okSrc.data?.sources || []) if (/^(ro|rw)\d/.test(s.name)) await req(`/api/admin/sources/${s.id}`, { method: 'DELETE', token: adminTok });
  }

  // ════════════════ billing ════════════════
  const plansEn = await req('/api/billing/plans');
  section(`billing copy (BIZ-2 / UX-4 / BIZ-18), provider=${plansEn.data?.provider}`);
  {
    const fr = await req('/api/billing/plans?lang=fr');
    const ru = await req('/api/billing/plans', { headers: { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5' } });
    check('default language is English', plansEn.data?.lang === 'en' && plansEn.data?.plans?.[0]?.name === 'Free');
    check('?lang=fr gives French copy', fr.data?.lang === 'fr' && fr.data?.plans?.[0]?.name === 'Gratuit' && fr.data?.plans?.[1]?.period === 'mois');
    check('Accept-Language ru gives Russian copy', ru.data?.lang === 'ru' && /Бесплатно/.test(ru.data?.plans?.[0]?.name || ''));
    check('period derived from PREMIUM_PERIOD_DAYS (30 -> month)', plansEn.data?.plans?.[1]?.period === 'month' && plansEn.data?.plans?.[1]?.periodDays === 30);
    const all = JSON.stringify([plansEn.data, fr.data, ru.data]);
    check('no promise of unbuilt features (M3U, EPG perso, extended multi-screen, max quality)', !/M3U|EPG|étendu|extended|qualité max|max quality/i.test(all));
    const feats = JSON.stringify([plansEn.data, fr.data, ru.data].map((d) => d?.plans?.map((p) => p.features)));
    check('no ad claims while ads are off', plansEn.data?.plans?.[0]?.ads === true || !/publicit|ads|реклам/i.test(feats), feats.slice(0, 200));
    check('plans still exactly 2 (free + premium)', plansEn.data?.plans?.length === 2);
  }

  if (MODE === 'dev') {
    section('mock billing (dev): grant, already-premium guard, cancel at period end, resume (BIZ-5 / BIZ-7)');
    const u = await register('mock');
    check('plans: checkout open in dev, test-mode notice', plansEn.data?.checkout === true && /Test mode/.test(plansEn.data?.copy?.notice || ''));
    const co = await req('/api/billing/checkout', { method: 'POST', token: u.token, body: { plan: 'premium' } });
    check('mock checkout grants premium, planSource mock', co.data?.activated === true && co.data?.user?.premium === true && co.data?.user?.planSource === 'mock');
    const again = await req('/api/billing/checkout', { method: 'POST', token: u.token, body: { plan: 'premium' } });
    check('second checkout while premium -> 409', again.status === 409 && again.data?.code === 'already_premium');
    const exp = co.data?.user?.planExpires;
    const cancel = await req('/api/billing/cancel?lang=fr', { method: 'POST', token: u.token });
    check('cancel keeps premium until planExpires', cancel.status === 200 && cancel.data?.user?.premium === true && cancel.data?.user?.planExpires === exp && cancel.data?.cancelAtPeriodEnd === true);
    check('cancel answer names the end date', cancel.data?.endsAt === exp && /jusqu'au/.test(cancel.data?.message || ''), cancel.data?.message);
    const me = await req('/api/auth/me', { token: u.token });
    check('/auth/me shows cancelAtPeriodEnd', me.data?.user?.cancelAtPeriodEnd === true);
    const resume = await req('/api/billing/checkout', { method: 'POST', token: u.token, body: { plan: 'premium' } });
    check('checkout after cancel resumes (no extension)', resume.data?.resumed === true && resume.data?.user?.cancelAtPeriodEnd === false && resume.data?.user?.planExpires === exp);
    const adm = await req(`/api/admin/users/${u.user.id}/plan`, { method: 'POST', token: adminTok, body: { plan: 'premium', days: 10 } });
    check('admin grant marks planSource admin', adm.data?.user?.planSource === 'admin');
    const free = await register('mockfree');
    const fc = await req('/api/billing/cancel', { method: 'POST', token: free.token });
    check('cancel on a free account is harmless', fc.status === 200 && fc.data?.user?.premium === false);
  }

  if (MODE === 'prod') {
    section('mock billing refused in production (BIZ-1 / SEC-5)');
    const u = await register('prod');
    check('plans: checkout closed + honest notice', plansEn.data?.checkout === false && /not open yet/.test(plansEn.data?.copy?.notice || ''), JSON.stringify(plansEn.data?.copy));
    const co = await req('/api/billing/checkout', { method: 'POST', token: u.token, body: { plan: 'premium' } });
    check('mock checkout in production -> 503 checkout_unavailable', co.status === 503 && co.data?.code === 'checkout_unavailable');
    const me = await req('/api/auth/me', { token: u.token });
    check('user stays free', me.data?.user?.premium === false);
    const pp = await req('/api/me/prefs', { method: 'PUT', token: u.token, body: { prefs: { hiddenCategories: ['news'] } } });
    check('premium feature still 402 for that user', pp.status === 402);
  }

  if (MODE === 'stripe') {
    section('Stripe checkout: customer OR customer_email (BIZ-7)');
    check('STRIPE_WEBHOOK_SECRET given to the suite', !!WHSEC);
    const u = await register('stripe');
    const co1 = await req('/api/billing/checkout', { method: 'POST', token: u.token, body: { plan: 'premium' } });
    const call1 = stripeCalls.filter((c) => c.path === '/checkout/sessions').at(-1);
    check('first checkout -> hosted url', co1.status === 200 && co1.data?.url?.startsWith('https://checkout.stripe.test'));
    check('first checkout sends customer_email only', call1?.form?.customer_email === u.user.email && !call1?.form?.customer);
    check('checkout carries our user id in metadata', call1?.form?.['metadata[app_user_id]'] === u.user.id && call1?.form?.['subscription_data[metadata][app_user_id]'] === u.user.id);

    section('Stripe webhook: signature, unpaid checkout, invoice never downgrades (BIZ-4 / SEC-4)');
    const bad = await hook('invoice.paid', {}, { sigHeader: 't=1,v1=00' });
    check('bad signature -> 400', bad.status === 400);
    const unpaid = await hook('checkout.session.completed', { object: 'checkout.session', mode: 'subscription', payment_status: 'unpaid', client_reference_id: u.user.id, customer: `cus_${ts}`, subscription: `sub_${ts}` });
    check('webhook 200', unpaid.status === 200);
    let su = await userById(adminTok, u.user.id);
    check('unpaid subscription checkout does NOT grant premium', su?.premium === false, JSON.stringify(su));
    await req('/api/billing/checkout', { method: 'POST', token: u.token, body: { plan: 'premium' } });
    const call2 = stripeCalls.filter((c) => c.path === '/checkout/sessions').at(-1);
    check('returning customer checkout sends customer only (Stripe accepts it)', call2?.form?.customer === `cus_${ts}` && !call2?.form?.customer_email);
    const end1 = Math.floor(Date.now() / 1000) + 30 * 86400;
    const inv = await hook('invoice.paid', { object: 'invoice', status: 'paid', customer: `cus_${ts}`, subscription: `sub_${ts}`, lines: { data: [{ period: { start: end1 - 30 * 86400, end: end1 } }] } });
    su = await userById(adminTok, u.user.id);
    check('invoice.paid (status paid) GRANTS premium until the line period end', inv.status === 200 && su?.premium === true && su?.planExpires === end1 * 1000 && su?.planSource === 'stripe', JSON.stringify(su));
    const dup = await hook('invoice.paid', inv.evt.data.object, { id: inv.evt.id, created: inv.evt.created });
    check('same event id again -> acknowledged as duplicate', dup.status === 200 && dup.data?.duplicate === true);
    // Rotation: Stripe sends two v1 values; the second one is ours.
    const end2 = end1 + 86400;
    const evtRot = { id: `evt_rot_${ts}`, type: 'customer.subscription.updated', created: created0 + 50, data: { object: { object: 'subscription', id: `sub_${ts}`, status: 'active', customer: `cus_${ts}`, items: { data: [{ current_period_end: end2 }] } } } };
    const pRot = JSON.stringify(evtRot);
    const tRot = Math.floor(Date.now() / 1000);
    const rot = await req('/api/billing/webhook', { method: 'POST', raw: pRot, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${tRot},v1=${'0'.repeat(64)},v1=${createHmac('sha256', WHSEC).update(`${tRot}.${pRot}`).digest('hex')}` } });
    check('two v1 signatures (secret rotation): accepted when one matches', rot.status === 200, `status=${rot.status}`);
    su = await userById(adminTok, u.user.id);
    check('subscription period end read from items[] (2025+ API)', su?.planExpires === end2 * 1000, `${su?.planExpires} vs ${end2 * 1000}`);
    await hook('customer.subscription.created', { object: 'subscription', id: `sub_${ts}`, status: 'incomplete', customer: `cus_${ts}` }, { created: created0 + 60 });
    su = await userById(adminTok, u.user.id);
    check('a late subscription.created (incomplete) does not downgrade', su?.premium === true);

    section('Stripe cancel = cancel_at_period_end, keeps access (BIZ-5 / SEC-5)');
    const cancel = await req('/api/billing/cancel', { method: 'POST', token: u.token });
    const ccall = stripeCalls.filter((c) => c.path === `/subscriptions/sub_${ts}` && c.method === 'POST').at(-1);
    check('cancel calls Stripe with cancel_at_period_end=true', ccall?.form?.cancel_at_period_end === 'true');
    check('premium kept until the period end', cancel.data?.user?.premium === true && cancel.data?.cancelAtPeriodEnd === true && cancel.data?.endsAt === end2 * 1000);

    section('Stripe webhook ordering + idempotency (BIZ-8)');
    const del = await hook('customer.subscription.deleted', { object: 'subscription', id: `sub_${ts}`, status: 'canceled', customer: `cus_${ts}` }, { created: created0 + 100 });
    su = await userById(adminTok, u.user.id);
    check('subscription.deleted -> free', del.status === 200 && su?.premium === false);
    await hook('customer.subscription.updated', { object: 'subscription', id: `sub_${ts}`, status: 'active', customer: `cus_${ts}`, current_period_end: end2 }, { created: created0 + 90 });
    su = await userById(adminTok, u.user.id);
    check('a LATE (older) subscription.updated active does not re-grant', su?.premium === false, JSON.stringify(su));

    if (DATA_DIR) {
      const evtId = `evt_persist_${ts}`;
      await chmod(DATA_DIR, 0o555);
      const endP = end2 + 86400;
      const obj = { object: 'invoice', status: 'paid', customer: `cus_${ts}`, subscription: `sub2_${ts}`, lines: { data: [{ period: { end: endP } }] } };
      const f = await hook('invoice.paid', obj, { id: evtId, created: created0 + 200 });
      await chmod(DATA_DIR, 0o755);
      check('persistence failure -> 500 so Stripe retries', f.status === 500, `status=${f.status}`);
      const r = await hook('invoice.paid', obj, { id: evtId, created: created0 + 200 });
      su = await userById(adminTok, u.user.id);
      check('the retried event is applied (not swallowed as duplicate)', r.status === 200 && !r.data?.duplicate && su?.premium === true && su?.planExpires === endP * 1000);
    }

    section('account deletion cancels the Stripe subscription (BIZ-5)');
    const v = await register('stripedel');
    await hook('invoice.paid', { object: 'invoice', status: 'paid', customer: `cusd_${ts}`, subscription: `subd_${ts}`, parent: { subscription_details: { subscription: `subd_${ts}`, metadata: { app_user_id: v.user.id } } }, lines: { data: [{ period: { end: end1 } }] } });
    let sv = await userById(adminTok, v.user.id);
    check('invoice resolved via parent.subscription_details metadata (no prior link)', sv?.premium === true);
    fakeStripe.failDelete = true;
    const d1 = await req('/api/auth/me', { method: 'DELETE', token: v.token, body: { password: 'secret123' } });
    sv = await userById(adminTok, v.user.id);
    check('Stripe down: deletion refused (502), account kept', d1.status === 502 && !!sv);
    fakeStripe.failDelete = false;
    const d2 = await req('/api/auth/me', { method: 'DELETE', token: v.token, body: { password: 'secret123' } });
    const dcall = stripeCalls.filter((c) => c.method === 'DELETE' && c.path === `/subscriptions/subd_${ts}`);
    check('deletion -> Stripe DELETE /subscriptions/{id} then account gone', d2.status === 200 && dcall.length >= 2 && !(await userById(adminTok, v.user.id)));
  }

  // Last: it burns this IP's sync budget for a minute.
  section('roaming writes throttled (SEC-7)');
  {
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) limited = (await req('/api/auth/favorites', { method: 'PUT', token: roam.token, body: { favorites: [] }, retry429: false })).status === 429;
    check('PUT /auth/favorites rate limited', limited);
  }

  feedServer.close();
  stripeServer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); for (const f of fails) console.log(`  - ${f}`); }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('suite crashed:', e);
  if (DATA_DIR) chmod(DATA_DIR, 0o755).catch(() => {});
  process.exit(2);
});
