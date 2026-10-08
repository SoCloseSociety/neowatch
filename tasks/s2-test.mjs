#!/usr/bin/env node
// NEOWATCH lot S2 test -- catalog resilience (stale-while-revalidate, stale disk cache),
// id stability (alternate index, id aliases, ?channelId= fallback, collisions), takedown
// blocklist on alternates + atomic saves, /api/health honesty, routes hardening (JSON 404,
// no stack traces, bounded paging, /assets 404, document headers, proxy before the gate),
// localized home rails + online-only spotlights.
//
// It starts NO NEOWATCH server: run one, then point BASE at it. MODE picks the scenario:
//   MODE=live  (default) a normal server on a real (seeded) cache.
//   MODE=fake  the server reads iptv-org from a crafted upstream this script serves on
//              UPSTREAM_PORT (default 8913). Start the server AFTER (or right after) this
//              script with an EMPTY cache dir and a tiny TTL, e.g.
//                IPTV_API_BASE=http://127.0.0.1:8913 CATALOG_TTL_HOURS=0.001 (TTL_MS=3600)
//              Optional: REQUIRE_AUTH=true (proves the proxy is not behind the gate), a
//              DATA_DIR pre-seeded with a truncated blocklist.json + CORRUPT_SEEDED=1.
//   MODE=stale IPTV_API_BASE=http://127.0.0.1:9 CATALOG_TTL_HOURS=0.001 + an old seeded cache:
//              the catalog keeps answering 200 from the stale copy, health says 503.
//   MODE=empty IPTV_API_BASE=http://127.0.0.1:9 + an empty cache: health and meta 503.
// Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, TTL_MS (the server's TTL in ms, fake/stale),
//      SERVER_LOG (path of the server's log, enables the log checks), DATA_DIR (the
//      server's data dir, enables the alias-file + blocklist save-failure checks).
import http from 'node:http';
import { readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { stableId } from '../server/src/util.js';

const BASE = process.env.BASE || 'http://localhost:8787';
const MODE = process.env.MODE || 'live';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TTL_MS = Number(process.env.TTL_MS) || 3600;
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT) || 8913;
const SERVER_LOG = process.env.SERVER_LOG || '';
const DATA_DIR = process.env.DATA_DIR || '';

let pass = 0, fail = 0, skip = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} -- ${why}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const log = () => (SERVER_LOG && existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8') : null);

let TOKEN = null;
const req = async (path, { method = 'GET', token = TOKEN, body, timeout = 15000, headers: extra = {} } = {}) => {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text().catch(() => '');
    let data = text;
    if (ct.includes('json')) { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: res.status, data, text, ct, ms: Date.now() - t0, headers: Object.fromEntries(res.headers) };
  } catch {
    return { status: 0, data: null, text: '', ct: '', ms: Date.now() - t0, headers: {} };
  } finally {
    clearTimeout(timer);
  }
};
const anon = (path, o = {}) => req(path, { ...o, token: null });

async function login() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return null;
  const r = await anon('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  return r.data?.token || null;
}

// ── crafted iptv-org upstream (MODE=fake) ──────────────────────
const U = (h, p) => `http://${h}.example.com/live/${p}.m3u8`;
// Two real catalog URLs whose djb2 ids collide (found by the audit: id 1f0qez1).
const COL_A = 'http://213.91.179.28:8000/play/a0c1';
const COL_B = 'http://213.91.179.28:8000/play/a0as';
const ch = (id, name) => ({ id, name, country: 'FR', categories: ['news'], is_nsfw: false, closed: null, website: null });
const st = (channel, url, quality = '720p') => ({ channel, feed: null, title: channel, url, quality, user_agent: null, referrer: null });
const DATA_V1 = {
  channels: [ch('Alpha.fr', 'Alpha'), ch('Bravo.fr', 'Bravo'), ch('Charlie.fr', 'Charlie'), ch('Delta.fr', 'Delta'), ch('History.fr', 'History'), ch('MaxSport.fr', 'Max Sport 1')],
  streams: [
    st('Alpha.fr', U('alpha', 'a1')), st('Alpha.fr', U('alpha', 'a2')),
    st('Bravo.fr', U('bravo', 'b1')),
    st('Charlie.fr', U('charlie', 'c1')), st('Charlie.fr', U('charlie', 'c2')),
    st('Delta.fr', U('delta', 'd1')), st('Delta.fr', U('delta', 'd2')),
    st('History.fr', COL_A), st('MaxSport.fr', COL_B),
  ],
  categories: [{ id: 'news', name: 'News' }],
  countries: [{ code: 'FR', name: 'France', flag: '🇫🇷', languages: ['fra'] }],
  languages: [{ code: 'fra', name: 'French' }],
  logos: [],
  feeds: [],
};
// v2: Alpha's feeds reordered (a1 becomes an alternate), Charlie lost c1 for good.
const DATA_V2 = { ...DATA_V1, streams: [
  st('Alpha.fr', U('alpha', 'a2')), st('Alpha.fr', U('alpha', 'a1')),
  st('Bravo.fr', U('bravo', 'b1')),
  st('Charlie.fr', U('charlie', 'c2')),
  st('Delta.fr', U('delta', 'd1')), st('Delta.fr', U('delta', 'd2')),
  st('History.fr', COL_A), st('MaxSport.fr', COL_B),
] };
const DATA_V3 = { ...DATA_V2, channels: [...DATA_V2.channels, ch('Echo.fr', 'Echo')], streams: [...DATA_V2.streams, st('Echo.fr', U('echo', 'e1'))] };
const upstream = { data: DATA_V1, down: false, hits: 0 };
function startUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      upstream.hits++;
      const name = (rq.url || '').replace(/^\//, '').replace(/\.json$/, '');
      if (upstream.down || !(name in upstream.data)) { rs.writeHead(503); return rs.end('down'); }
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(upstream.data[name]));
    });
    srv.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function waitCatalog(maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const h = await anon('/api/health', { timeout: 5000 });
    if (h.data?.catalog?.total > 0) return h;
    if (MODE === 'empty' && h.status && h.data?.catalog && !h.data.catalog.building && h.data.catalog.total === 0) return h;
    await sleep(1000);
  }
  return null;
}

// ── checks shared by every mode that has a catalog ─────────────
async function commonChecks() {
  section('routes: JSON contract');
  // REQUIRE_AUTH=true: the per-router content gates answer an anonymous caller first (401 JSON).
  const gated = (await anon('/api/config')).data?.requireAuth === true;
  const nope = await anon('/api/nope-s2');
  check('unknown /api route -> JSON (404, or 401 when gated)', nope.ct.includes('json') && (gated ? nope.status === 401 : nope.status === 404 && nope.data?.error === 'not found'), `${nope.status} ${nope.ct}`);
  if (gated) {
    const nopeAuth = await req('/api/nope-s2');
    check('unknown /api route, signed in -> 404 JSON', nopeAuth.status === 404 && nopeAuth.data?.error === 'not found', `${nopeAuth.status}`);
  }
  const bad = await req('/api/catalog/channel/%E0%A4%A');
  check('bad URI escape -> 400 JSON', bad.status === 400 && bad.ct.includes('json'), `${bad.status} ${bad.ct}`);
  check('error body has no stack trace / path', !/\bat \w|node_modules|\/Users\/|URIError/.test(bad.text), bad.text.slice(0, 120));
  const p = await req('/api/catalog/channels?page=1e400&limit=2');
  check('page=1e400 -> page 1 (finite)', p.status === 200 && p.data?.page === 1, `page=${p.data?.page}`);
  const big = await req('/api/catalog/channels?page=999999999&limit=1e9');
  check('page clamped to 10000, limit to 120', big.status === 200 && big.data?.page === 10000 && big.data?.limit === 120, `page=${big.data?.page} limit=${big.data?.limit}`);
  const l0 = await req('/api/catalog/channels?limit=0');
  check('limit=0 keeps the default (60)', l0.data?.limit === 60, `limit=${l0.data?.limit}`);

  section('health: shape + privacy');
  const h = await anon('/api/health');
  check('health keeps key ok', typeof h.data?.ok === 'boolean');
  check('health has catalog status', typeof h.data?.catalog?.total === 'number' && 'ageMin' in (h.data?.catalog || {}) && 'building' in (h.data?.catalog || {}));
  check('health has epg + streams status', typeof h.data?.epg?.enabled === 'boolean' && typeof h.data?.streams?.checked === 'number');
  check('health: no user counts for anonymous', !('users' in (h.data || {})) && !('admins' in (h.data || {})) && !('active' in (h.data || {})));
  check('health: never cached', /no-store/.test(h.headers['cache-control'] || ''));
  if (TOKEN) {
    const ha = await req('/api/health');
    check('health: user counts for an admin', typeof ha.data?.users?.users === 'number' && typeof ha.data?.users?.admins === 'number');
  } else skipped('health admin counts', 'no admin creds');

  section('document + static');
  const doc = await anon('/');
  if (doc.status === 200 && doc.ct.includes('html')) {
    check('document X-Frame-Options DENY', doc.headers['x-frame-options'] === 'DENY', doc.headers['x-frame-options']);
    check("document CSP frame-ancestors 'none'", /frame-ancestors 'none'/.test(doc.headers['content-security-policy'] || ''));
    check('document nosniff', doc.headers['x-content-type-options'] === 'nosniff');
    check('document Referrer-Policy', !!doc.headers['referrer-policy']);
    const spa = await anon('/chaine/abc');
    check('SPA route /chaine/<id> still serves the app', spa.status === 200 && spa.ct.includes('html'));
    const miss = await anon('/assets/Player-DOESNOTEXIST.js');
    check('missing /assets chunk -> 404, never index.html', miss.status === 404 && !miss.ct.includes('html'), `${miss.status} ${miss.ct}`);
  } else skipped('document headers + /assets 404', 'web/dist not built');
  const api = await anon('/api/config');
  check('no frame-ancestors CSP forced onto /api', !/frame-ancestors/.test(api.headers['content-security-policy'] || ''));
}

// ── MODE=live ──────────────────────────────────────────────────
async function liveChecks() {
  section('home: localized rails + spotlights');
  const en = await req('/api/catalog/home?lang=en');
  const fr = await req('/api/catalog/home?lang=fr');
  const ru = await req('/api/catalog/home?lang=ru');
  const def = await req('/api/catalog/home');
  const title = (r, k) => r.data?.rails?.find((x) => x.key === k)?.title;
  check('lang=en rail titles in English', title(en, 'uk') === 'United Kingdom' && title(en, 'series') === 'Series', `${title(en, 'uk')} / ${title(en, 'series')}`);
  check('lang=fr rail titles in French', title(fr, 'uk') === 'Royaume-Uni' && title(fr, 'series') === 'Séries');
  check('lang=ru rail titles in Russian', title(ru, 'uk') === 'Великобритания');
  check('no lang -> English', title(def, 'uk') === 'United Kingdom', title(def, 'uk'));
  const feat = en.data?.featured || [];
  check('spotlights present', feat.length > 0, `${feat.length}`);
  check('every spotlight is confirmed online', feat.every((c) => c.online === true), feat.map((c) => c.online).join(','));
  check('every spotlight carries heroCategory', feat.every((c) => typeof c.heroCategory === 'string' && c.heroCategory && c.heroCategory !== 'undefined'));
  check('spotlight railTitle localized', feat.every((c) => c.railTitle === title(en, c.railKey)));
  const footPick = feat.find((c) => c.railKey === 'foot');
  check('foot spotlight -> heroCategory sports', !footPick || footPick.heroCategory === 'sports');
  check('one spotlight per rail, distinct', new Set(feat.map((c) => c.railKey)).size === feat.length && new Set(feat.map((c) => c.url)).size === feat.length);
  const frRail = en.data?.rails?.find((r) => r.key === 'fr');
  const frPick = feat.find((c) => c.railKey === 'fr');
  check('fr spotlight is a French channel', !frPick || frPick.country === 'FR');
  if (frRail && frPick) {
    const firstOnline = frRail.channels.find((c) => c.online === true && c.logo && !c.locked);
    console.log(`        (fr rail first online: ${firstOnline?.name}; spotlight: ${frPick.name})`);
  }

  section('ids: exact, alternate, ?channelId=, collision');
  const list = await req('/api/catalog/channels?category=general&limit=120');
  const items = list.data?.items || [];
  const one = items[0];
  const exact = await req(`/api/catalog/channel/${one.id}`);
  check('exact id -> 200, canonicalId === id', exact.status === 200 && exact.data?.id === one.id && exact.data?.canonicalId === one.id);
  const primaryIds = new Set(items.map((i) => i.id));
  const withAlt = items.find((i) => i.alternates?.length && !primaryIds.has(stableId(i.alternates[0].url)));
  if (withAlt) {
    const altUrl = withAlt.alternates[0].url;
    const altId = stableId(altUrl);
    const viaAlt = await req(`/api/catalog/channel/${altId}`);
    check('id of an alternate URL resolves to its channel', viaAlt.status === 200 && viaAlt.data?.canonicalId === withAlt.id && viaAlt.data?.channelId === withAlt.channelId, `${viaAlt.status} ${viaAlt.data?.canonicalId} vs ${withAlt.id}`);
    if (TOKEN) {
      section('blocklist: alternates filtered, never mutated');
      const add = await req('/api/admin/blocklist', { method: 'POST', body: { url: altUrl } });
      check('block an alternate -> 200', add.status === 200 && add.data?.added === 1, JSON.stringify(add.data));
      const after = await req(`/api/catalog/channel/${withAlt.id}`);
      check('blocked alternate gone from alternates', after.status === 200 && !(after.data?.alternates || []).some((a) => a.url === altUrl) && after.data?.url !== altUrl);
      const gone = await req(`/api/catalog/channel/${altId}`);
      check('blocked alternate id no longer resolves', gone.status === 404, `${gone.status}`);
      const del = await req(`/api/admin/blocklist?url=${enc(altUrl)}`, { method: 'DELETE' });
      check('unblock -> 200', del.status === 200 && del.data?.removed === true);
      const back = await req(`/api/catalog/channel/${withAlt.id}`);
      check('unblocked alternate is back (base item was not mutated)', (back.data?.alternates || []).some((a) => a.url === altUrl) || back.data?.url === altUrl);
    }
  } else skipped('alternate id resolution', 'no channel with a non-colliding alternate in the sample');
  const withCid = items.find((i) => i.channelId);
  const fb = await req(`/api/catalog/channel/zzzzzzz?channelId=${enc(withCid.channelId)}`);
  check('?channelId= fallback for an unknown id', fb.status === 200 && fb.data?.channelId === withCid.channelId && !!fb.data?.canonicalId, `${fb.status}`);
  const fbAt = await req(`/api/catalog/channel/zzzzzzz?channelId=${enc(withCid.channelId.toUpperCase() + '@SD')}`);
  check('?channelId= is case/@feed-insensitive', fbAt.status === 200 && fbAt.data?.channelId === withCid.channelId);
  const no = await req('/api/catalog/channel/zzzzzzz');
  check('unknown id without channelId -> 404 JSON', no.status === 404 && no.data?.error === 'not found');
  const col = await req('/api/catalog/channel/1f0qez1');
  if (col.status === 200) check('collision id keeps the first winner (History)', col.data?.name === 'History', col.data?.name);
  else skipped('collision winner', 'id 1f0qez1 not in this catalog');
  const L = log();
  if (L) check('collisions are logged', /djb2 id collision/.test(L));

  section('proxy: not compressed');
  const online = items.find((i) => i.online === true && i.proxyUrl);
  if (online) {
    const pr = await anon(online.proxyUrl, { headers: { 'Accept-Encoding': 'gzip' }, timeout: 12000 });
    if (pr.status === 200) check('proxied response has no Content-Encoding', !pr.headers['content-encoding'], pr.headers['content-encoding']);
    else skipped('proxy compression', `upstream answered ${pr.status}`);
  } else skipped('proxy compression', 'no online channel in the sample');

  if (TOKEN && DATA_DIR) {
    section('blocklist: a failed save answers 500');
    try {
      chmodSync(DATA_DIR, 0o500);
      const r = await req('/api/admin/blocklist', { method: 'POST', body: { url: 'http://s2-test.example.com/never.m3u8' } });
      check('unwritable data dir -> 500 JSON', r.status === 500 && r.data?.error === 'blocklist not saved', `${r.status} ${JSON.stringify(r.data)}`);
    } finally {
      chmodSync(DATA_DIR, 0o755);
    }
    await req(`/api/admin/blocklist?url=${enc('http://s2-test.example.com/never.m3u8')}`, { method: 'DELETE' });
    const lst = await req('/api/admin/blocklist');
    check('blocklist clean after the test', !(lst.data?.urls || []).includes('http://s2-test.example.com/never.m3u8'));
  } else skipped('blocklist save failure', 'needs admin creds + DATA_DIR');
}

// ── MODE=fake ──────────────────────────────────────────────────
async function fakeChecks() {
  const cfg = await anon('/api/config');
  const gated = cfg.data?.requireAuth === true;
  section(`fake upstream: cold build (REQUIRE_AUTH=${gated})`);
  const meta = await req('/api/catalog/meta');
  check('meta 200 from the crafted upstream', meta.status === 200 && meta.data?.total === 6, `${meta.status} total=${meta.data?.total}`);
  const id = (u) => stableId(u);
  check('the two collision URLs do share an id', id(COL_A) === id(COL_B));
  const col = await req(`/api/catalog/channel/${id(COL_A)}`);
  check('collision id -> first winner (History)', col.status === 200 && col.data?.name === 'History', col.data?.name);
  const L = log();
  if (L) check('collision logged', /djb2 id collision\(s\): \w+: "History" keeps it, "Max Sport 1"/.test(L));
  else skipped('collision log', 'no SERVER_LOG');

  if (gated) {
    section('REQUIRE_AUTH=true: the stream proxy is not behind the gate');
    const anonCat = await anon('/api/catalog/meta');
    check('catalog gated for anonymous (401)', anonCat.status === 401);
    const alpha = await req(`/api/catalog/channel/${id(U('alpha', 'a1'))}`);
    const pu = alpha.data?.proxyUrl;
    check('signed proxyUrl vended to the signed-in user', !!pu && /[?&]sig=/.test(pu));
    const pr = await anon(pu, { timeout: 10000 });
    check('proxyUrl without a Bearer token is NOT 401', pr.status !== 401 && pr.status !== 0, `${pr.status} ${pr.text.slice(0, 80)}`);
    const anonHealth = await anon('/api/health');
    check('health stays public in SaaS mode', anonHealth.status === 200 && anonHealth.data?.ok === true);
  }

  if (process.env.CORRUPT_SEEDED === '1' && TOKEN) {
    section('corrupt blocklist.json at boot');
    const bl = await req('/api/admin/blocklist');
    check('salvaged URLs from the truncated file', (bl.data?.urls || []).includes('http://x.example.com/a.m3u8') && (bl.data?.urls || []).includes('http://x.example.com/b.m3u8'), JSON.stringify(bl.data));
    if (DATA_DIR) check('a .bak copy was kept', readdirSync(DATA_DIR).some((f) => /^blocklist\.json\.corrupt-\d+\.bak$/.test(f)));
    if (L) check('loud CORRUPT log line', /\[blocklist\] CORRUPT/.test(L));
    for (const u of bl.data?.urls || []) await req(`/api/admin/blocklist?url=${enc(u)}`, { method: 'DELETE' });
  }

  if (TOKEN) {
    section('blocklist: alternate + primary (crafted)');
    const dId = id(U('delta', 'd1')), d2Id = id(U('delta', 'd2'));
    const before = await req(`/api/catalog/channel/${d2Id}`);
    check('alternate id resolves before the takedown', before.status === 200 && before.data?.canonicalId === dId);
    await req('/api/admin/blocklist', { method: 'POST', body: { url: U('delta', 'd2') } });
    const d = await req(`/api/catalog/channel/${dId}`);
    check('blocked alternate removed from alternates', d.status === 200 && (d.data?.alternates || []).length === 0, JSON.stringify(d.data?.alternates));
    check('blocked alternate id -> 404', (await req(`/api/catalog/channel/${d2Id}`)).status === 404);
    await req('/api/admin/blocklist', { method: 'POST', body: { url: U('delta', 'd1') } });
    check('blocked primary -> channel 404', (await req(`/api/catalog/channel/${dId}`)).status === 404);
    const m2 = await req('/api/catalog/meta');
    check('blocked channel left the facets', m2.data?.total === 5, `total=${m2.data?.total}`);
    await req(`/api/admin/blocklist?url=${enc(U('delta', 'd1'))}`, { method: 'DELETE' });
    await req(`/api/admin/blocklist?url=${enc(U('delta', 'd2'))}`, { method: 'DELETE' });
    const d3 = await req(`/api/catalog/channel/${dId}`);
    check('unblock restores card + alternate', d3.status === 200 && (d3.data?.alternates || []).some((a) => a.url === U('delta', 'd2')));
  }

  section('id stability across an upstream rotation');
  upstream.data = DATA_V2;
  await sleep(TTL_MS + 600); // disk cache older than the TTL -> the next build downloads
  const ref = await req('/api/catalog/refresh', { method: 'POST' });
  const refreshedAt = Date.now(); // the data age clock restarts here
  check('admin refresh picks the rotated data', ref.status === 200, `${ref.status}`);
  const a1 = await req(`/api/catalog/channel/${id(U('alpha', 'a1'))}`);
  check('old id whose URL became an ALTERNATE still resolves', a1.status === 200 && a1.data?.name === 'Alpha' && a1.data?.canonicalId === id(U('alpha', 'a2')), `${a1.status} ${a1.data?.canonicalId}`);
  const c1 = await req(`/api/catalog/channel/${id(U('charlie', 'c1'))}`);
  check('old id whose URL is GONE resolves through the alias', c1.status === 200 && c1.data?.name === 'Charlie' && c1.data?.canonicalId === id(U('charlie', 'c2')), `${c1.status} ${c1.data?.canonicalId}`);
  const fb = await req('/api/catalog/channel/zzzzzzz?channelId=bravo.fr');
  check('?channelId= fallback', fb.status === 200 && fb.data?.name === 'Bravo');
  check('unknown id -> 404', (await req('/api/catalog/channel/zzzzzzz')).status === 404);

  section('iptv-org outage: stale-while-revalidate');
  upstream.down = true;
  await sleep(TTL_MS + 600);
  const hitsBefore = upstream.hits;
  const m = await req('/api/catalog/meta');
  check('meta 200 after the TTL with iptv-org down', m.status === 200 && m.data?.total === 6, `${m.status}`);
  check('answered from memory, not after a download', m.ms < 1500, `${m.ms}ms`);
  const chA = await req(`/api/catalog/channel/${id(U('alpha', 'a2'))}`);
  check('channel/:id 200 with iptv-org down', chA.status === 200);
  const q = await req('/api/catalog/channels?q=bravo');
  check('channels?q= 200 with iptv-org down', q.status === 200 && q.data?.items?.[0]?.name === 'Bravo');
  await sleep(800);
  check('a background refresh was attempted', upstream.hits > hitsBefore, `hits ${hitsBefore} -> ${upstream.hits}`);
  const m2 = await req('/api/catalog/meta');
  check('failed refresh keeps the current catalog', m2.status === 200 && m2.data?.total === 6);
  const hitsAfter = upstream.hits;
  await req('/api/catalog/meta'); await req('/api/catalog/meta');
  await sleep(300);
  check('no refetch storm during the backoff', upstream.hits === hitsAfter, `hits ${hitsAfter} -> ${upstream.hits}`);
  const hs = await anon('/api/health');
  if (Date.now() - refreshedAt < 2 * TTL_MS) check('health 200 while data < 2 x TTL (stale flagged)', hs.status === 200 && hs.data?.ok === true && hs.data?.catalog?.stale === true, `${hs.status} ${JSON.stringify(hs.data?.catalog)}`);
  await sleep(Math.max(0, 2 * TTL_MS - (Date.now() - refreshedAt)) + 800);
  const h503 = await anon('/api/health');
  check('health 503 ok:false once data > 2 x TTL', h503.status === 503 && h503.data?.ok === false && h503.data?.catalog?.total === 6, `${h503.status}`);
  check('...while the catalog still answers 200', (await req('/api/catalog/meta')).status === 200);

  section('recovery');
  upstream.down = false;
  upstream.data = DATA_V3;
  const rec = await req('/api/catalog/refresh', { method: 'POST' });
  check('admin refresh after the outage -> new data', rec.status === 200 && rec.data?.total === 7, `${rec.status} total=${rec.data?.total}`);
  const hOk = await anon('/api/health');
  check('health back to 200', hOk.status === 200 && hOk.data?.ok === true && hOk.data?.catalog?.stale === false);
  upstream.down = true;
  await sleep(TTL_MS + 600);
  const refFail = await req('/api/catalog/refresh', { method: 'POST' });
  check('forced refresh with iptv-org down -> 503, catalog kept', refFail.status === 503 && (await req('/api/catalog/meta')).data?.total === 7, `${refFail.status}`);
  if (DATA_DIR) {
    await sleep(5600); // alias saves are debounced 5s (already elapsed here, kept for safety)
    const f = join(DATA_DIR, 'id-aliases.json');
    const al = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
    check('id-aliases.json persisted (old ids kept)', al[id(U('charlie', 'c1'))] === 'Charlie.fr' && al[id(U('alpha', 'a1'))] === 'Alpha.fr');
  }
}

// ── MODE=stale ─────────────────────────────────────────────────
async function staleChecks() {
  section('dead iptv-org + stale disk cache');
  const m = await req('/api/catalog/meta');
  check('meta 200 from the stale disk cache', m.status === 200 && m.data?.total > 0, `${m.status} total=${m.data?.total}`);
  const one = (await req('/api/catalog/channels?limit=1')).data?.items?.[0];
  check('channel/:id 200', !!one && (await req(`/api/catalog/channel/${one.id}`)).status === 200);
  await sleep(2 * TTL_MS + 800);
  const m2 = await req('/api/catalog/meta');
  check('meta still 200 after 2 x TTL', m2.status === 200 && m2.data?.total === m.data?.total, `${m2.status}`);
  check('channel/:id still 200 after 2 x TTL', (await req(`/api/catalog/channel/${one.id}`)).status === 200);
  const q = await req(`/api/catalog/channels?q=${enc(one.name.split(' ')[0])}`);
  check('channels?q= still 200', q.status === 200 && q.data?.items?.length > 0);
  const h = await anon('/api/health');
  check('health 503 ok:false (data older than 2 x TTL), total > 0', h.status === 503 && h.data?.ok === false && h.data?.catalog?.total > 0 && h.data?.catalog?.stale === true, `${h.status} ${JSON.stringify(h.data?.catalog)}`);
  const L = log();
  if (L) check('stale fallback logged', /serving the stale disk cache/.test(L));
}

// ── MODE=empty ─────────────────────────────────────────────────
async function emptyChecks() {
  section('dead iptv-org + no cache');
  const h = await anon('/api/health');
  check('health 503 ok:false on an empty catalog', h.status === 503 && h.data?.ok === false && h.data?.catalog?.total === 0, `${h.status} ${JSON.stringify(h.data)}`);
  const m = await req('/api/catalog/meta');
  check('meta 503 JSON', m.status === 503 && m.data?.error === 'catalog unavailable');
  const t0 = Date.now();
  await req('/api/catalog/meta');
  check('cold retries are backoff-gated (instant 503)', Date.now() - t0 < 1000);
  const nope = await anon('/api/nope-s2');
  check('unknown /api route -> 404 JSON', nope.status === 404 && nope.ct.includes('json'));
}

(async () => {
  let srv = null;
  if (MODE === 'fake') {
    srv = await startUpstream();
    console.log(`crafted iptv-org upstream on http://127.0.0.1:${UPSTREAM_PORT} -- start the server now`);
  }
  console.log(`S2 test against ${BASE} (MODE=${MODE})`);
  const h = await waitCatalog();
  if (!h) { console.log('server/catalog never came up'); process.exit(1); }
  TOKEN = await login();
  if (!TOKEN) console.log('  (no admin token: admin checks skipped)');
  if (MODE === 'empty') await emptyChecks();
  else {
    await commonChecks();
    if (MODE === 'live') await liveChecks();
    if (MODE === 'fake') await fakeChecks();
    if (MODE === 'stale') await staleChecks();
  }
  srv?.close();
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  if (fails.length) console.log('Failures:\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
