#!/usr/bin/env node
// NEOWATCH frozen-contract test. These routes and fields are consumed OUTSIDE this repo
// (Sentinel House direct.py / media.py / integrations.py, the Android shell widgets, Neo
// bot/config.py health monitor). They may grow (additive fields) but never be renamed or
// removed: this suite fails the build if one of them moves. See NEO_CONNECTOR.md.
//
// Run against a live (throwaway) server whose catalog is warm:
//   BASE=http://localhost:8931 ADMIN_EMAIL=... ADMIN_PASSWORD=... node test/contract-test.mjs
// Admin creds (env only) enable the EPG checks: a tiny XMLTV is pasted as an admin EPG
// source for one real channel, checked through /api/epg/now + /api/epg/day, then removed.

const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let pass = 0, fail = 0, skip = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} (${why})`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const ID_RE = /^[0-9a-z]+$/; // djb2 of the stream url, base36 (util.js stableId)

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    return { status: res.status, data, ct };
  } catch (e) {
    return { status: 0, data: null, ct: '', error: e?.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  section('GET /api/health (Neo: status < 500 = healthy, key `ok`)');
  const h = await req('/api/health');
  check('200 with ok:true', h.status === 200 && h.data?.ok === true, `status=${h.status}`);
  check('catalog.total > 0', Number(h.data?.catalog?.total) > 0);
  check('no user counts for an anonymous caller', !has(h.data, 'users'));

  section('GET /api/catalog/meta');
  const meta = await req('/api/catalog/meta');
  check('200', meta.status === 200, `status=${meta.status}`);
  check('categories is a non-empty array', Array.isArray(meta.data?.categories) && meta.data.categories.length > 0);
  check('total is a positive number', Number(meta.data?.total) > 0);
  check('online is a number', typeof meta.data?.online === 'number');

  section('GET /api/catalog/channels?q=');
  const list = await req('/api/catalog/channels?q=news&limit=10');
  const items = list.data?.items || [];
  check('200 with items', list.status === 200 && items.length > 0, `status=${list.status} n=${items.length}`);
  check('every item has id (djb2 base36), name, online', items.every((c) => ID_RE.test(String(c.id)) && typeof c.name === 'string' && has(c, 'online')));
  check('limit is honoured', items.length <= 10, `n=${items.length}`);

  section('GET /api/catalog/channel/:id');
  // Prefer a channel with a tvg-id: it also exercises the ?channelId= fallback below.
  const pick = items.find((c) => c.channelId && !c.locked) || items.find((c) => !c.locked) || items[0];
  if (!pick) {
    check('a channel to inspect', false, 'empty search result');
  } else {
    const one = await req(`/api/catalog/channel/${encodeURIComponent(pick.id)}`);
    const c = one.data || {};
    check('200', one.status === 200, `status=${one.status}`);
    for (const k of ['url', 'alternates', 'online', 'quality', 'logo', 'channelId', 'name']) check(`field \`${k}\` present`, has(c, k));
    check('alternates is an array', Array.isArray(c.alternates));
    check('id is the requested one', c.id === pick.id);
    check('additive canonicalId present', ID_RE.test(String(c.canonicalId || '')));
    check('additive checkedAt key present', has(c, 'checkedAt'));
    check('unknown id -> 404 JSON', (await req('/api/catalog/channel/zzzzzzzzzz')).status === 404);
    if (pick.channelId) {
      const fb = await req(`/api/catalog/channel/zzzzzzzzzz?channelId=${encodeURIComponent(pick.channelId)}`);
      check('?channelId= fallback resolves a dead id (additive)', fb.status === 200 && ID_RE.test(String(fb.data?.canonicalId || '')), `status=${fb.status}`);
    } else skipped('?channelId= fallback', 'no channel with a tvg-id in the sample');

    section('page /chaine/<id>');
    const page = await req(`/chaine/${encodeURIComponent(pick.id)}`);
    if (page.status === 404 && !String(page.ct).includes('html')) skipped('/chaine/<id> serves the app', 'web/dist not built');
    else check('/chaine/<id> -> 200 HTML', page.status === 200 && page.ct.includes('text/html'), `status=${page.status} ct=${page.ct}`);
    const play = await req(`/chaine/${encodeURIComponent(pick.id)}?play=1`);
    if (page.status === 200) check('/chaine/<id>?play=1 -> 200 HTML (additive)', play.status === 200 && play.ct.includes('text/html'));

    section('GET /api/epg/now?ids= and /api/epg/day?id=');
    const empty = await req('/api/epg/now?ids=nothing.example');
    check('epg/now answers {channels:{}} for an unknown id', empty.status === 200 && empty.data && typeof empty.data.channels === 'object');
    const emptyDay = await req('/api/epg/day?id=nothing.example');
    check('epg/day answers {programmes:[]} for an unknown id', emptyDay.status === 200 && Array.isArray(emptyDay.data?.programmes));
    const cid = pick.channelId;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) skipped('epg shapes with data', 'needs ADMIN_EMAIL/ADMIN_PASSWORD');
    else if (!cid) skipped('epg shapes with data', 'no tvg-id in the sample');
    else {
      const login = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
      const token = login.data?.token;
      check('admin login', !!token, `status=${login.status}`);
      if (token) {
        const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
        const t0 = Date.now() - 30 * 60000;
        const xml = `<?xml version="1.0"?><tv><channel id="${cid}"><display-name>x</display-name></channel>`
          + `<programme start="${fmt(t0)}" stop="${fmt(t0 + 3600000)}" channel="${cid}"><title>Contract now</title></programme>`
          + `<programme start="${fmt(t0 + 3600000)}" stop="${fmt(t0 + 7200000)}" channel="${cid}"><title>Contract next</title></programme></tv>`;
        const add = await req('/api/admin/epg', { method: 'POST', token, body: { name: 'contract-test', text: xml } });
        const src = (add.data?.sources || []).find((s) => s.name === 'contract-test');
        check('admin pastes a tiny XMLTV', add.status === 200 && !!src, `status=${add.status} ${JSON.stringify(add.data)?.slice(0, 120)}`);
        try {
          const now = await req(`/api/epg/now?ids=${encodeURIComponent(cid)}`);
          const nn = now.data?.channels?.[cid];
          check('epg/now: channels[<tvg-id>].now.title', nn?.now?.title === 'Contract now', JSON.stringify(nn)?.slice(0, 160));
          check('epg/now: next.title', nn?.next?.title === 'Contract next');
          const day = await req(`/api/epg/day?id=${encodeURIComponent(cid)}`);
          const progs = day.data?.programmes || [];
          check('epg/day: programmes[] with start/stop/title', progs.length >= 2 && progs.every((p) => typeof p.start === 'number' && typeof p.title === 'string' && has(p, 'stop')));
        } finally {
          if (src) await req(`/api/admin/epg/${src.id}`, { method: 'DELETE', token });
        }
      }
    }
  }

  section('GET /api/config (additive androidApk)');
  const cfg = await req('/api/config');
  check('200', cfg.status === 200);
  check('androidApk absent or a site path ending in .apk', cfg.data && (!('androidApk' in cfg.data) || /^\/[\w./-]+\.apk$/.test(cfg.data.androidApk)), JSON.stringify(cfg.data?.androidApk));

  section('GET /api/img?u= (logo relay, read by Sentinel House)');
  check('no u -> 400', (await req('/api/img')).status === 400);
  check('a URL the server does not vend -> 404 (never fetched)', (await req('/api/img?u=' + encodeURIComponent('https://example.com/x.png'))).status === 404);
  const logo = items.map((c) => c.logo).find((u) => u && /^https?:/.test(u) && !/\.svg(\?|$)/i.test(u));
  if (!logo) skipped('a catalog logo through the relay', 'no raster logo in the search sample');
  else {
    const r = await fetch(`${BASE}/api/img?u=${encodeURIComponent(logo)}`).catch(() => null);
    if (!r || r.status !== 200) skipped('a catalog logo through the relay', `upstream answered ${r?.status ?? 'nothing'}`);
    else {
      check('vended logo -> 200 image/*', (r.headers.get('content-type') || '').startsWith('image/'), r.headers.get('content-type'));
      check('relay answer carries nosniff + sandbox CSP', r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy') || ''));
    }
  }

  section('stream proxy (opaque, signed)');
  const px = await req('/api/proxy?url=' + encodeURIComponent('https://example.com/a.m3u8'));
  check('unsigned proxy URL -> 403', px.status === 403, `status=${px.status}`);
  check('unknown /api route -> 404 JSON', (await req('/api/nothing-here')).status === 404);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  x ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
