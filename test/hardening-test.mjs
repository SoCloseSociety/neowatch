#!/usr/bin/env node
// NEOWATCH server hardening regressions (QA round 2): stores that must never be saved
// over when corrupt, a search that must not block the event loop, EPG caps that keep
// what is airing now, a hung provider that must not stall source changes, races on the
// admin user store, and long-lived caching of hashed assets.
//
// Run against a THROWAWAY server (warm catalog, ALLOW_PRIVATE_SOURCES=true: the crafted
// upstream is on 127.0.0.1), e.g. through `npm test` (test/run.mjs), or:
//   BASE=http://localhost:8931 ADMIN_EMAIL=... ADMIN_PASSWORD=... UPSTREAM_PORT=8932 node test/hardening-test.mjs
// The corrupt-users.json check boots its own short-lived server on a free port.
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const UP = Number(process.env.UPSTREAM_PORT) || 8933;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function req(p, { method = 'GET', token, body, timeout = 20000 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    return { status: res.status, data, headers: res.headers, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, data: null, headers: new Headers(), ms: Date.now() - t0, error: String(e?.name || e) };
  }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = netServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const fmt = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const prog = (ch, start, stop, title) => `<programme start="${fmt(start)}" stop="${fmt(stop)}" channel="${ch}"><title>${title}</title></programme>`;

// ── crafted upstream: a playlist that can switch to a drip (one byte every 2 s, forever) ──
let dripMode = false;
const dripping = new Set();
const RUN = Date.now();
const upstream = createServer((q, s) => {
  if (q.url.startsWith('/pl.m3u')) {
    if (!dripMode) {
      s.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
      return s.end(`#EXTM3U\n#EXTINF:-1 group-title="News",Zzhardendrip ${RUN}\nhttp://127.0.0.1:${UP}/stream/drip.m3u8\n`);
    }
    s.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    s.write('#EXTM3U\n');
    const t = setInterval(() => s.write('#\n'), 2000);
    dripping.add(s);
    s.on('close', () => { clearInterval(t); dripping.delete(s); });
    return;
  }
  s.writeHead(404); s.end();
});

(async () => {
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));
  let token = null;
  const cleanup = [];
  try {
    // ── SRV-1 (unit): a store is never read as "empty" unless the file is missing ──
    section('JSON stores: only a missing file is empty (unit)');
    const { readJsonArray } = await import(path.join(ROOT, 'server/src/util.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-harden-'));
    cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const quiet = console.error;
    console.error = () => {}; // the helper logs loudly by design
    const missing = await readJsonArray(path.join(tmp, 'none.json'), 't');
    fs.writeFileSync(path.join(tmp, 'bad.json'), '[{"a":1},]');
    const bad = await readJsonArray(path.join(tmp, 'bad.json'), 't');
    fs.writeFileSync(path.join(tmp, 'obj.json'), '{"a":1}');
    const obj = await readJsonArray(path.join(tmp, 'obj.json'), 't');
    fs.writeFileSync(path.join(tmp, 'ok.json'), '[1,2]');
    const ok = await readJsonArray(path.join(tmp, 'ok.json'), 't');
    console.error = quiet;
    check('missing file -> [] (a fresh store)', Array.isArray(missing.data) && missing.data.length === 0);
    check('trailing comma -> null (never []) + a .corrupt-*.bak copy', bad.data === null && fs.readdirSync(tmp).some((f) => /^bad\.json\.corrupt-\d+\.bak$/.test(f)));
    check('an object, not an array -> null', obj.data === null);
    check('a valid array -> its data', JSON.stringify(ok.data) === '[1,2]');

    // ── SRV-1 (boot): a corrupt users.json stops the boot and is left untouched ──
    section('corrupt users.json: boot refused, accounts kept');
    {
      const dataDir = path.join(tmp, 'data');
      fs.mkdirSync(dataDir);
      const usersFile = path.join(dataDir, 'users.json');
      const original = JSON.stringify([
        { id: 'a1', email: 'boss@corrupt.local', role: 'admin', status: 'active', passwordHash: 'x' },
        { id: 'u1', email: 'alice@corrupt.local', role: 'user', status: 'active', plan: 'premium', planSource: 'stripe', passwordHash: 'y', favorites: ['http://x/1.m3u8'] },
      ]).replace(/]$/, ',]');
      fs.writeFileSync(usersFile, original);
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], {
        cwd: ROOT,
        env: {
          ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, CACHE_DIR: path.join(tmp, 'cache'),
          ADMIN_EMAIL: 'fresh-admin@corrupt.local', ADMIN_PASSWORD: 'fresh-password-123', JWT_SECRET: 'test-only-hardening-secret-'.padEnd(48, 'x'),
          EPG_DEFAULT_URL: '', HEALTH_SWEEP: 'false', REQUIRE_AUTH: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { out += b; });
      const code = await Promise.race([new Promise((r) => child.once('exit', r)), sleep(20000).then(() => 'timeout')]);
      if (code === 'timeout') child.kill('SIGKILL');
      check('the server exits 1 instead of booting on an empty store', code === 1, `exit=${code}`);
      check('users.json is byte-identical (no lone admin saved over it)', fs.readFileSync(usersFile, 'utf8') === original);
      check('a users.json.corrupt-*.bak copy is kept', fs.readdirSync(dataDir).some((f) => /^users\.json\.corrupt-\d+\.bak$/.test(f)));
      check('the log says why (FATAL + the file)', /FATAL/.test(out) && out.includes('users.json'), out.slice(-200));
      check('no admin account was created', !/admin account created/.test(out));
    }

    // ── SRV-1 (follow-up): a broken sources.json / epg.json refuses changes up front ──
    section('corrupt sources.json + epg.json: admin changes refused (503), files kept');
    {
      const dataDir = path.join(tmp, 'data-stores');
      fs.mkdirSync(dataDir);
      const srcFile = path.join(dataDir, 'sources.json');
      const epgFile = path.join(dataDir, 'epg.json');
      const srcOrig = '[{"id":"s1","name":"Provider","url":"http://127.0.0.1:9/pl.m3u","count":12},]';
      const epgOrig = '[{"id":"e1","name":"Guide","url":"http://127.0.0.1:9/epg.xml","count":40},]';
      fs.writeFileSync(srcFile, srcOrig);
      fs.writeFileSync(epgFile, epgOrig);
      const port = await freePort();
      const child = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], {
        cwd: ROOT,
        env: {
          ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, CACHE_DIR: path.join(tmp, 'cache-stores'),
          ADMIN_EMAIL: 'stores-admin@corrupt.local', ADMIN_PASSWORD: 'stores-password-123', JWT_SECRET: 'test-only-hardening-secret-'.padEnd(48, 'x'),
          EPG_DEFAULT_URL: '', HEALTH_SWEEP: 'false', REQUIRE_AUTH: 'false', IPTV_API_BASE: 'http://127.0.0.1:9',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      try {
        const own = `http://127.0.0.1:${port}`;
        const call = (p, opt = {}) => fetch(own + p, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(opt.token ? { Authorization: `Bearer ${opt.token}` } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined, signal: AbortSignal.timeout(10000) })
          .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }), () => ({ status: 0, data: null }));
        let lg = { status: 0 };
        for (let i = 0; i < 60 && lg.status !== 200; i++) {
          lg = await call('/api/auth/login', { method: 'POST', body: { email: 'stores-admin@corrupt.local', password: 'stores-password-123' } });
          if (lg.status !== 200) await sleep(250);
        }
        const tk = lg.data?.token;
        check('the server boots (users.json is fine) and the admin logs in', !!tk, `status=${lg.status}`);
        const m3u = '#EXTM3U\n#EXTINF:-1,Zzhardenbroken\nhttp://127.0.0.1:9/s.m3u8\n';
        const addS = await call('/api/admin/sources', { method: 'POST', token: tk, body: { name: 'x', text: m3u } });
        const delS = await call('/api/admin/sources/s1', { method: 'DELETE', token: tk });
        check('POST + DELETE /api/admin/sources -> 503 (not a 500 after merging into memory)', addS.status === 503 && delS.status === 503, `post=${addS.status} delete=${delS.status}`);
        check('... and nothing was merged: /api/sources stays empty', ((await call('/api/sources')).data?.sources || []).length === 0);
        const xml = `<tv>${prog('Zz.test', Date.now(), Date.now() + 3600000, 'Zz')}</tv>`;
        const addE = await call('/api/admin/epg', { method: 'POST', token: tk, body: { name: 'x', text: xml } });
        const delE = await call('/api/admin/epg/e1', { method: 'DELETE', token: tk });
        check('POST + DELETE /api/admin/epg -> 503', addE.status === 503 && delE.status === 503, `post=${addE.status} delete=${delE.status}`);
        check('sources.json + epg.json are byte-identical', fs.readFileSync(srcFile, 'utf8') === srcOrig && fs.readFileSync(epgFile, 'utf8') === epgOrig);
      } finally {
        child.kill('SIGKILL');
      }
    }

    // ── SRV-2: a long search query must not block the event loop ──
    section('catalog search: q and its tokens are capped');
    const longQ = Array(4000).fill('a').join('+'); // ~8 KB request line (fits nginx's default)
    const t0 = Date.now();
    const healthDuring = (async () => { await sleep(50); return req('/api/health'); })();
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => req(`/api/catalog/channels?q=${longQ}&page=${i + 1}`, { timeout: 30000 })));
    const hd = await healthDuring;
    const total = Date.now() - t0;
    check('20 parallel 8 KB queries all answer 200', burst.every((r) => r.status === 200), burst.map((r) => r.status).join(','));
    check(`... in under 3 s in total (was ~6.6 s), /api/health stays responsive (${hd.ms} ms)`, total < 3000 && hd.status === 200 && hd.ms < 1500, `total=${total} ms health=${hd.ms} ms`);
    const multi = await req('/api/catalog/channels?q=bbc%20news&limit=5');
    check('a normal multi-word search still works', multi.status === 200 && (multi.data?.items || []).length > 0, `status=${multi.status}`);

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      skipped('admin sections', 'set ADMIN_EMAIL + ADMIN_PASSWORD');
      return;
    }
    const login = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    token = login.data?.token;
    check('admin login', !!token, `status=${login.status}`);
    if (!token) return;

    // ── SRV-5: two parallel creates with one email ──
    section('admin create user: a double click makes one account');
    const dupEmail = `dup${RUN}@harden.local`;
    const dups = await Promise.all([
      req('/api/admin/users', { method: 'POST', token, body: { email: dupEmail, password: 'first-pass-1' } }),
      req('/api/admin/users', { method: 'POST', token, body: { email: dupEmail, password: 'second-pass-2' } }),
    ]);
    const list = await req('/api/admin/users', { token });
    const sameEmail = (list.data?.users || []).filter((u) => u.email === dupEmail);
    check('statuses are one 200 + one 409', dups.map((r) => r.status).sort().join(',') === '200,409', dups.map((r) => r.status).join(','));
    check('exactly one account with that email', sameEmail.length === 1, `${sameEmail.length} accounts`);
    for (const u of sameEmail) cleanup.push(() => req(`/api/admin/users/${u.id}`, { method: 'DELETE', token }));

    // ── QA-1 + SRV-4: EPG caps keep what airs now ──
    section('EPG: duplicates folded, the day cap keeps now + next, search finds live shows');
    const chans = (await req('/api/catalog/channels?q=news&limit=120')).data?.items || [];
    const withCid = chans.filter((c) => c.channelId);
    const ids = [...new Set(withCid.map((c) => c.channelId))];
    if (ids.length < 2) skipped('EPG sections', 'fewer than 2 channels with a tvg-id');
    else {
      const [cidA, cidB] = ids;
      const now = Date.now();
      const slot = 5 * 60000;
      const base = Math.floor((now - 3 * 3600000) / slot) * slot;
      let xml = '<?xml version="1.0"?><tv>';
      // A dense guide (5 min slots, -3 h .. +5 h) listed twice: two @feeds of one channel.
      for (let t = base; t < now + 5 * 3600000; t += slot) {
        for (const feed of ['HardenDense.fr@SD', 'HardenDense.fr@HD']) xml += prog(feed, t, t + slot, `Dense ${new Date(t).toISOString().slice(11, 16)}`);
      }
      // Channel A: 70 upcoming reruns matching the query; channel B: one show on air now.
      for (let i = 0; i < 70; i++) xml += prog(cidA, now + 3600000 + i * 3600000, now + 3600000 + i * 3600000 + 1800000, `Zzhardenq rerun ${i}`);
      xml += prog(cidB, now - 600000, now + 1800000, 'Zzhardenq live now');
      xml += '</tv>';
      const add = await req('/api/admin/epg', { method: 'POST', token, body: { name: `harden-${RUN}`, text: xml } });
      const src = (add.data?.sources || []).find((s) => s.name === `harden-${RUN}`);
      check('admin pastes the XMLTV', add.status === 200 && !!src, `status=${add.status} ${JSON.stringify(add.data)?.slice(0, 120)}`);
      if (src) cleanup.push(() => req(`/api/admin/epg/${src.id}`, { method: 'DELETE', token }));

      const day = (await req('/api/epg/day?id=HardenDense.fr')).data?.programmes || [];
      const nn = (await req('/api/epg/now?ids=HardenDense.fr')).data?.channels?.['HardenDense.fr'];
      const keys = day.map((p) => `${p.start}|${p.title}`);
      check('epg/day: the frozen shape (start, stop, title, desc)', day.length > 0 && day.every((p) => typeof p.start === 'number' && typeof p.title === 'string' && 'stop' in p && 'desc' in p));
      check('epg/day: no duplicate (same start + title) from the two feeds', new Set(keys).size === keys.length, `${keys.length - new Set(keys).size} duplicates`);
      check('epg/day: still capped at 60', day.length === 60, `n=${day.length}`);
      check('epg/day: the programme on air now is in the list', !!nn?.now && day.some((p) => p.start === nn.now.start && p.title === nn.now.title), `now=${nn?.now?.title} last=${day.at(-1)?.title}`);
      const upcoming = day.filter((p) => p.start > now).length;
      check('epg/day: most of the cap goes to what comes next (>= 40 upcoming)', upcoming >= 40, `upcoming=${upcoming}`);
      check('epg/day: a few past shows are kept for context', day.some((p) => (p.stop || 0) <= now), '');

      const search = await req('/api/epg/search?q=zzhardenq');
      const res = search.data?.results || [];
      check('epg/search: the show on air now on the LATER channel is found, first', res[0]?.live === true && res[0]?.title === 'Zzhardenq live now', `first=${res[0]?.title} n=${res.length}`);
      check('epg/search: one channel fills at most 5 results', res.filter((r) => r.channelId === cidA.toLowerCase().split('@')[0]).length <= 5, `${res.filter((r) => r.title.startsWith('Zzhardenq rerun')).length} reruns`);
    }

    // ── SRV-3: a dripping provider must not stall source changes ──
    section('custom sources: a hung refresh never blocks a delete or an add');
    const addSrc = await req('/api/admin/sources', { method: 'POST', token, body: { name: `drip-${RUN}`, url: `http://127.0.0.1:${UP}/pl.m3u` } });
    const dripSrc = (addSrc.data?.sources || []).find((s) => s.name === `drip-${RUN}`);
    check('a URL source is added, with its channel count (not 0 until the next refresh)', addSrc.status === 200 && !!dripSrc && dripSrc.count === 1, `status=${addSrc.status} count=${dripSrc?.count} ${JSON.stringify(addSrc.data)?.slice(0, 160)}`);
    if (addSrc.status === 400 && /blocked|private/i.test(JSON.stringify(addSrc.data))) skipped('drip section', 'start the server with ALLOW_PRIVATE_SOURCES=true');
    else if (dripSrc) {
      cleanup.push(() => req(`/api/admin/sources/${dripSrc.id}`, { method: 'DELETE', token }));
      const listed = async () => ((await req(`/api/catalog/channels?q=${enc(`zzhardendrip ${RUN}`)}`)).data?.items || []).length;
      check('its channel is listed', (await listed()) === 1);
      dripMode = true;
      const refreshT0 = Date.now();
      const refresh = req('/api/admin/sources/refresh', { method: 'POST', token, timeout: 120000 });
      let waited = 0;
      while (!dripping.size && waited < 5000) { await sleep(100); waited += 100; }
      check('the refresh is stuck on the dripping provider', dripping.size > 0);
      const del = await req(`/api/admin/sources/${dripSrc.id}`, { method: 'DELETE', token, timeout: 10000 });
      check('DELETE answers at once (not after the refresh)', del.status === 200 && del.ms < 3000, `status=${del.status} ${del.ms} ms`);
      check('... and its channel is gone from the catalog at once', (await listed()) === 0);
      const inline = await req('/api/admin/sources', { method: 'POST', token, timeout: 10000, body: { name: `inline-${RUN}`, text: `#EXTM3U\n#EXTINF:-1,Zzhardeninline ${RUN}\nhttp://127.0.0.1:${UP}/stream/i.m3u8\n` } });
      const inl = (inline.data?.sources || []).find((s) => s.name === `inline-${RUN}`);
      if (inl) cleanup.push(() => req(`/api/admin/sources/${inl.id}`, { method: 'DELETE', token }));
      check('a new inline source is added at once too', inline.status === 200 && !!inl && inline.ms < 3000, `status=${inline.status} ${inline.ms} ms`);
      const r = await refresh;
      const took = Date.now() - refreshT0;
      check(`the stuck refresh ends on its own deadline (${Math.round(took / 1000)} s, 60 s cap; the agent's 300 s timeout never fired)`, r.status === 200 && took < 90000, `status=${r.status} ${took} ms`);
      check('the inline source survived the refresh that was in flight', ((await req(`/api/catalog/channels?q=${enc(`zzhardeninline ${RUN}`)}`)).data?.items || []).length === 1);
    }

    // ── PERF-2: hashed assets are cacheable forever ──
    section('hashed /assets: Cache-Control max-age=1y, immutable');
    const home = await req('/');
    const asset = typeof home.data === 'string' ? (home.data.match(/\/assets\/[A-Za-z0-9_.-]+\.js/) || [])[0] : null;
    if (!asset) skipped('/assets caching', 'web/dist not built');
    else {
      const a = await req(asset);
      const cc = a.headers.get('cache-control') || '';
      check(`${asset} -> 200 with max-age=31536000 + immutable`, a.status === 200 && /max-age=31536000/.test(cc) && /immutable/.test(cc), `status=${a.status} cache-control=${cc}`);
      const miss = await req('/assets/does-not-exist-0000.js');
      check('a missing hashed chunk is still a real 404 (never index.html)', miss.status === 404, `status=${miss.status}`);
    }
  } finally {
    for (const f of cleanup.reverse()) { try { await f(); } catch { /* best effort */ } }
    for (const s of dripping) s.destroy();
    upstream.closeAllConnections?.();
    upstream.close();
    console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
    if (fails.length) console.log('FAILED:\n  ' + fails.join('\n  '));
    process.exit(fail ? 1 : 0);
  }
})();
