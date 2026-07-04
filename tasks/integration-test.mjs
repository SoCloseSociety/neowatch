#!/usr/bin/env node
// NEOWATCH integral integration test suite.
// Run against a live server:  node tasks/integration-test.mjs
// Env: BASE (default http://localhost:8787), ADMIN_EMAIL, ADMIN_PASSWORD.
import { parseXmltv } from '../server/src/epg.js';

const BASE = process.env.BASE || 'http://localhost:8787';
// Admin creds for the admin-gated checks. Pass them via env -- never hardcode:
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node tasks/integration-test.mjs
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const enc = encodeURIComponent;
const req = async (path, { method = 'GET', token, body, timeout = 12000 } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    return { status: res.status, data, ct, headers: Object.fromEntries(res.headers) };
  } catch {
    // Network/timeout (e.g. our proxy waiting on a slow upstream) -> status 0.
    return { status: 0, data: null, ct: '', headers: {} };
  } finally {
    clearTimeout(timer);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

(async () => {
  // ── config / health ──
  section('config & health');
  const cfg = await req('/api/config');
  check('GET /api/config 200', cfg.status === 200);
  check('config name = NEOWATCH', cfg.data?.name === 'NEOWATCH');
  check('config exposes billing', !!cfg.data?.billing?.provider);
  const health = await req('/api/health');
  check('GET /api/health ok', health.status === 200 && health.data?.ok === true);

  // ── catalog ──
  section('catalog');
  const meta = await req('/api/catalog/meta');
  check('meta total > 10000', meta.data?.total > 10000, `total=${meta.data?.total}`);
  check('meta has categories', (meta.data?.categories?.length || 0) >= 10);
  check('meta free+premium = total', (meta.data?.freeCount + meta.data?.premiumCount) === meta.data?.total);
  const news = await req('/api/catalog/channels?category=news&limit=5');
  check('news returns items', (news.data?.items?.length || 0) > 0);
  check('anon news is free + has url', news.data?.items?.[0]?.tier === 'free' && !!news.data?.items?.[0]?.url);
  const sports = await req('/api/catalog/channels?category=sports&limit=5');
  // Legal-safe model: NO content is gated by category -- sports is free + playable.
  check('anon sports is free + has url (not content-locked)', sports.data?.items?.[0]?.tier === 'free' && sports.data?.items?.[0]?.locked === false && !!sports.data?.items?.[0]?.url);
  const foot = await req('/api/catalog/channels?foot=1&limit=5');
  check('foot filter returns items', (foot.data?.total || 0) > 0, `total=${foot.data?.total}`);
  const search = await req('/api/catalog/channels?q=france&limit=5');
  check('search q=france returns items', (search.data?.total || 0) > 0);
  const p2 = await req('/api/catalog/channels?category=news&page=2&limit=5');
  check('pagination page 2 works', p2.status === 200 && p2.data?.page === 2);
  // Homepage rails (Netflix/Molotov discover)
  const home = await req('/api/catalog/home');
  check('home rails returned', (home.data?.rails?.length || 0) >= 3, `${home.data?.rails?.length} rails`);
  check('home rails have channels', (home.data?.rails?.[0]?.channels?.length || 0) > 0);
  check('home featured present', Array.isArray(home.data?.featured));

  const oneId = news.data?.items?.[0]?.id;
  const deep = await req(`/api/catalog/channel/${oneId}`);
  check('deep-link channel by id', deep.status === 200 && deep.data?.id === oneId);
  // Alternate-feed fallback: some channels expose signed alternate stream URLs.
  const big = await req('/api/catalog/channels?category=general&limit=120');
  const withAlt = (big.data?.items || []).find((i) => i.alternates && i.alternates.length);
  check('alternate feeds present + signed', !!withAlt && /[?&]sig=/.test(withAlt.alternates[0].proxyUrl || ''), withAlt ? `${withAlt.alternates.length} alts` : 'none in sample');

  // ── auth ──
  section('auth & roles');
  const badLogin = await req('/api/auth/login', { method: 'POST', body: { email: 'x@y.z', password: 'nope' } });
  check('bad login -> 401', badLogin.status === 401);
  const ts = Date.now();
  const reg = await req('/api/auth/register', { method: 'POST', body: { email: `it${ts}@test.local`, password: 'secret123' } });
  check('register -> token + free plan', !!reg.data?.token && reg.data?.user?.plan === 'free');
  const userTok = reg.data?.token;
  const me = await req('/api/auth/me', { token: userTok });
  check('GET /me ok', me.status === 200 && me.data?.user?.premium === false);
  const admin = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  check('admin login ok', !!admin.data?.token && admin.data?.user?.role === 'admin', admin.data?.error);
  const adminTok = admin.data?.token;

  // ── admin gating ──
  section('admin gating');
  check('admin API without token -> 401', (await req('/api/admin/users')).status === 401);
  check('admin API as normal user -> 403', (await req('/api/admin/users', { token: userTok })).status === 403);
  const users = await req('/api/admin/users', { token: adminTok });
  check('admin lists users', Array.isArray(users.data?.users));
  const shortPw = await req('/api/admin/users', { method: 'POST', token: adminTok, body: { email: `z${ts}@t.l`, password: '123' } });
  check('admin create short pwd -> 400', shortPw.status === 400);

  // ── billing / paywall ──
  section('billing & paywall');
  check('GET /billing/plans public', (await req('/api/billing/plans')).data?.plans?.length === 2);
  // Content is never category-locked now: sports is free + playable for a free user.
  const beforeUp = await req('/api/catalog/channels?category=sports&limit=1', { token: userTok });
  check('free user sports free + playable', beforeUp.data?.items?.[0]?.locked === false && !!beforeUp.data?.items?.[0]?.url);
  const checkout = await req('/api/billing/checkout', { method: 'POST', token: userTok, body: { plan: 'premium' } });
  check('checkout activates premium (feature plan)', checkout.data?.activated === true && checkout.data?.user?.premium === true);

  // ── signed proxy (no credential in query; open-relay closed) ──
  section('proxy (HMAC-signed URLs)');
  const newsItem = news.data?.items?.[0];
  check('free channel carries a signed proxyUrl', !!newsItem?.proxyUrl && /[?&]sig=/.test(newsItem.proxyUrl));
  const unsigned = await req(`/api/proxy?url=${enc(newsItem.url)}`);
  check('UNSIGNED proxy url -> 403 (open relay closed)', unsigned.status === 403);
  const tampered = await req(`${newsItem.proxyUrl}&url=${enc('http://169.254.169.254/')}`);
  check('tampered/extra url param does not bypass -> not 200 metadata', tampered.status !== 200 || !String(tampered.data).includes('ami-'));
  const signedFree = await req(newsItem.proxyUrl, { timeout: 9000 });
  check('SIGNED free proxy accepted (not 403/400)', signedFree.status !== 403 && signedFree.status !== 400, `status=${signedFree.status}`);
  const sportsItem = sports.data?.items?.[0];
  const signedSport = await req(sportsItem.proxyUrl, { timeout: 9000 });
  check('SIGNED sports proxy accepted (not 403/400)', signedSport.status !== 403 && signedSport.status !== 400, `status=${signedSport.status}`);
  const ssrf = await req(`/api/proxy?url=${enc('http://169.254.169.254/latest/meta-data/')}`);
  check('unsigned SSRF metadata -> 403', ssrf.status === 403);

  // ── prefs (premium-gated) ──
  section('preferences (premium)');
  const freshFree = await req('/api/auth/register', { method: 'POST', body: { email: `pf${ts}@test.local`, password: 'secret123' } });
  const freePut = await req('/api/me/prefs', { method: 'PUT', token: freshFree.data?.token, body: { prefs: { hiddenCategories: ['news'] } } });
  check('free PUT /me/prefs -> 402', freePut.status === 402);
  const admPut = await req('/api/me/prefs', { method: 'PUT', token: adminTok, body: { prefs: { hiddenCategories: ['shop'], pinnedCategories: ['sports'], home: { category: 'news' } } } });
  check('premium PUT /me/prefs -> 200', admPut.status === 200 && admPut.data?.prefs?.hiddenCategories?.includes('shop'));

  // ── account: self password change ──
  section('account (password change)');
  const acc = await req('/api/auth/register', { method: 'POST', body: { email: `acc${ts}@test.local`, password: 'secret123' } });
  const accTok = acc.data?.token;
  const wrongCur = await req('/api/auth/password', { method: 'PUT', token: accTok, body: { currentPassword: 'WRONG', newPassword: 'newsecret1' } });
  check('password change wrong current -> 401', wrongCur.status === 401);
  const okCur = await req('/api/auth/password', { method: 'PUT', token: accTok, body: { currentPassword: 'secret123', newPassword: 'newsecret1' } });
  check('password change correct -> 200', okCur.status === 200);
  const reLogin = await req('/api/auth/login', { method: 'POST', body: { email: `acc${ts}@test.local`, password: 'newsecret1' } });
  check('login with new password works', !!reLogin.data?.token);

  // ── custom M3U sources ──
  section('custom M3U sources');
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="TestCh.x" tvg-logo="http://x/l.png" group-title="Sports",Test Channel, FR\n#EXTVLCOPT:http-user-agent=UA/1.0\nhttps://example.com/integration-test/stream.m3u8\n';
  const addSrc = await req('/api/admin/sources', { method: 'POST', token: adminTok, body: { name: `IT ${ts}`, text: m3u } });
  check('import inline M3U', addSrc.status === 200 && addSrc.data?.sources?.some((s) => s.name === `IT ${ts}`));
  const custom = await req('/api/catalog/channels?category=custom&limit=20', { token: adminTok });
  const mine = custom.data?.items?.find((i) => i.url?.includes('integration-test'));
  check('custom channel in catalog, comma name kept, UA captured', mine?.name === 'Test Channel, FR' && mine?.userAgent === 'UA/1.0', mine?.name);
  const srcId = addSrc.data?.sources?.find((s) => s.name === `IT ${ts}`)?.id;
  const delSrc = await req(`/api/admin/sources/${srcId}`, { method: 'DELETE', token: adminTok });
  check('delete source', delSrc.status === 200);

  // ── EPG ──
  section('EPG');
  const xml = '<?xml version="1.0"?><tv><programme start="20260101120000 +0000" stop="20260101130000 +0000" channel="CNN.us"><title>News &amp; Sport</title></programme><programme start="20260101130000 +0200" channel="TF1.fr"><title>Le Foot</title></programme></tv>';
  const { total } = parseXmltv(xml);
  check('XMLTV parser extracts 2 programmes', total === 2, `total=${total}`);
  const epgNow = await req('/api/epg/now?ids=CNN.us');
  check('GET /epg/now ok', epgNow.status === 200);
  const epgSearch = await req('/api/epg/search?q=foot');
  check('GET /epg/search ok (array)', Array.isArray(epgSearch.data?.results));

  // ── health checker ──
  section('stream health check');
  const hc = await req('/api/catalog/check', { method: 'POST', body: { items: [{ id: 'a', url: news.data?.items?.[0]?.url }] } });
  check('health check returns result', Array.isArray(hc.data?.results) && hc.data.results.length === 1);

  // ── v2 features: detail page, sort, lang-home, dedup, search, pagination, EPG day ──
  {
  section('home rails (Netflix-style)');
  const homeV2 = await req('/api/catalog/home');
  check('home returns rails', (homeV2.data?.rails?.length || 0) >= 10, `rails=${homeV2.data?.rails?.length}`);
  check('home rail has ~30 channels', (homeV2.data?.rails?.[0]?.channels?.length || 0) >= 20, `len=${homeV2.data?.rails?.[0]?.channels?.length}`);
  check('home rail filter is complete', homeV2.data?.rails?.[0]?.filter && 'onlineOnly' in homeV2.data.rails[0].filter);
  check('home featured present', (homeV2.data?.featured?.length || 0) > 0);

  section('language-aware home');
  const homeRu = await req('/api/catalog/home?lang=ru');
  const homeFr = await req('/api/catalog/home?lang=fr');
  const genRu = homeRu.data?.rails?.find((r) => r.key === 'general')?.channels?.[0]?.name;
  const genFr = homeFr.data?.rails?.find((r) => r.key === 'general')?.channels?.[0]?.name;
  check('home adapts to language (ru != fr top channel)', !!genRu && !!genFr && genRu !== genFr, `ru=${genRu} fr=${genFr}`);

  section('dedup, sort, accent search');
  const newsPage = await req('/api/catalog/channels?category=news&limit=40');
  const cids = (newsPage.data?.items || []).map((i) => i.channelId).filter(Boolean);
  check('no duplicate channelId in a page', new Set(cids).size === cids.length, `${cids.length} ids, ${new Set(cids).size} unique`);
  const sortName = await req('/api/catalog/channels?category=news&sort=name&limit=3');
  const sortLat = await req('/api/catalog/channels?category=news&sort=latency&limit=3');
  check('sort=name and sort=latency differ', JSON.stringify(sortName.data?.items?.map((i) => i.name)) !== JSON.stringify(sortLat.data?.items?.map((i) => i.name)));
  const accent = await req('/api/catalog/channels?q=tele&limit=10');
  check('accent-insensitive search (tele -> matches)', (accent.data?.items?.length || 0) > 0 && accent.data.items.some((i) => /t[eé]l[eé]|television/i.test(i.name)));
  check('_search not leaked to client', accent.data?.items?.length ? !('_search' in accent.data.items[0]) : true);

  section('horizontal pagination');
  const pgA = await req('/api/catalog/channels?category=news&page=1&limit=30');
  const pgB = await req('/api/catalog/channels?category=news&page=2&limit=30');
  const pgAfirst = pgA.data?.items?.[0]?.url;
  const pgBurls = new Set((pgB.data?.items || []).map((i) => i.url));
  check('page 2 continues (no overlap with page 1 head)', !!pgAfirst && (pgB.data?.items?.length || 0) > 0 && !pgBurls.has(pgAfirst));

  section('channel detail + EPG day');
  const someId = news.data?.items?.[0]?.id;
  const detail = await req(`/api/catalog/channel/${someId}`);
  check('GET /catalog/channel/:id 200 + name', detail.status === 200 && !!detail.data?.name);
  const someChId = news.data?.items?.find((i) => i.channelId)?.channelId || 'CNN.us';
  const day = await req(`/api/epg/day?id=${enc(someChId)}`);
  check('GET /epg/day 200 (programmes array)', day.status === 200 && Array.isArray(day.data?.programmes));
  }

  // ── v3: robustness + security hardening (audit-driven) ──
  {
  section('robustness & security');
  // Repeated query keys arrive as arrays -> must coerce, not 503 + leak internals.
  const arrQ = await req('/api/catalog/channels?q=a&q=b&limit=3');
  check('array query param -> 200 (not 503)', arrQ.status === 200, `status=${arrQ.status}`);
  check('catalog error does not leak internal detail', !(arrQ.data && arrQ.data.detail));
  // page/limit clamped to sane bounds.
  const clamp = await req('/api/catalog/channels?category=news&page=-5&limit=99999');
  check('page/limit clamped', clamp.status === 200 && (clamp.data?.items?.length || 0) <= 120 && (clamp.data?.page || 0) >= 1);
  // Unknown channel id -> clean 404 (has try/catch now).
  const nf = await req('/api/catalog/channel/__nope_does_not_exist__');
  check('unknown channel id -> 404', nf.status === 404);
  // /catalog/check: null item + non-catalog url filtered (no hang, no SSRF emit).
  const chkNull = await req('/api/catalog/check', { method: 'POST', timeout: 8000, body: { items: [null, { id: 'x', url: 'http://10.0.0.1/x' }] } });
  check('check filters null + non-catalog urls (no hang)', chkNull.status === 200 && Array.isArray(chkNull.data?.results) && chkNull.data.results.length === 0, `n=${chkNull.data?.results?.length}`);
  // Baseline security headers.
  check('security headers present', arrQ.headers?.['x-content-type-options'] === 'nosniff' && !!arrQ.headers?.['x-frame-options']);
  // Malformed JSON body -> JSON 400 (not Express HTML). Manual fetch (req stringifies).
  let badStatus = 0, badJsonErr = false;
  try {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    badStatus = r.status;
    badJsonErr = !!(await r.json().catch(() => null))?.error;
  } catch { /* ignore */ }
  check('malformed JSON body -> 400 JSON', badStatus === 400 && badJsonErr, `status=${badStatus}`);
  }

  // ── summary ──
  console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
