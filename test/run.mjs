#!/usr/bin/env node
// NEOWATCH test runner (`npm test`). Starts THROWAWAY servers (free port, temp DATA_DIR,
// shared temp CACHE_DIR), never touches server/.data or the dev server, runs the server
// suites and exits non-zero on the first failing suite (all suites still run).
//
//   node test/run.mjs                 # every suite
//   node test/run.mjs contract proxy  # a subset (names below)
//   KEEP=1 node test/run.mjs          # keep the temp dir (logs, data) for inspection
//   NW_TEST_SEED=0 node test/run.mjs  # ignore server/.cache, build the catalog cold
//
// One fresh server per suite: rate limits and per-IP pairing caps are per process, so a
// suite never inherits another one's counters or accounts. The catalog cache is shared:
// seeded from server/.cache when present (fast, offline), else built once from iptv-org.
// Offline-safe: no cache and iptv-org unreachable -> every suite is SKIPPED (exit 0) with
// a clear message. NW_TEST_STRICT=1 turns that skip into a failure.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server/src/index.js');
const ADMIN_EMAIL = 'runner-admin@neowatch.local';
const ADMIN_PASSWORD = 'runner-password-123';
const JWT_SECRET = 'test-only-runner-secret-'.padEnd(48, 'x'); // never a real secret
const IPTV_API_BASE = process.env.IPTV_API_BASE || 'https://iptv-org.github.io/api';

// name -> { file, env for the suite, env for its server }
const SUITES = {
  contract: { file: 'contract-test.mjs' },
  integration: { file: 'integration-test.mjs' },
  proxy: { file: 'proxy-test.mjs', upstream: 'UPSTREAM_PORT' },
  img: { file: 'img-test.mjs', upstream: 'UPSTREAM_PORT' },
  account: { file: 'account-test.mjs', env: { S3_MODE: 'dev' }, ports: ['FEED_PORT', 'STRIPE_PORT'], dataDir: true },
  catalog: { file: 'catalog-test.mjs', env: { MODE: 'live' }, dataDir: true },
  hardening: { file: 'hardening-test.mjs', upstream: 'UPSTREAM_PORT' },
  session: {
    file: 'session-test.mjs', upstream: 'UPSTREAM_PORT',
    env: { TTL_S: '8', RENEW_S: '3' },
    server: { JWT_TTL: '8s', JWT_RENEW_AFTER: '3s' },
  },
};

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const w of wanted) if (!SUITES[w]) { console.error(`unknown suite "${w}" (known: ${Object.keys(SUITES).join(', ')})`); process.exit(2); }
const order = wanted.length ? wanted : Object.keys(SUITES);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neowatch-test-'));
const CACHE = path.join(TMP, 'cache');
fs.mkdirSync(CACHE);
const children = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch {
    return { status: 0, data: null };
  } finally { clearTimeout(t); }
}

// Seed the shared cache from the dev checkout (read-only copy). Health verdicts older than
// 12h count as unknown on the server, so the COPY is re-dated: suites that need "online"
// channels (home spotlights, online-first) then have some. The dev files are never changed.
function seedCache() {
  if (process.env.NW_TEST_SEED === '0') return false; // force a cold build (CI-like)
  const src = path.join(ROOT, 'server/.cache');
  if (!fs.existsSync(path.join(src, 'channels.json'))) return false;
  for (const f of fs.readdirSync(src)) {
    const from = path.join(src, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(CACHE, f));
  }
  const hp = path.join(CACHE, 'health.json');
  try {
    const h = JSON.parse(fs.readFileSync(hp, 'utf8'));
    const now = Date.now();
    if (Array.isArray(h)) for (const e of h) if (e?.[1]) e[1].checkedAt = now;
    fs.writeFileSync(hp, JSON.stringify(h));
  } catch { /* no or unreadable health cache: verdicts stay unknown */ }
  return true;
}

// Cold cache = no health verdicts: online-only paths (home spotlights, latency sort) would
// be empty. Probe a few categories through the server's own shared health check (real
// requests to real streams, the same path a browser uses); the verdicts land in the shared
// cache's health.json when that server stops, so every later server boots with them.
async function warmHealth(base) {
  let probed = 0, online = 0;
  for (const cat of ['news', 'sports', 'movies', 'music', 'kids']) {
    const list = await getJson(`${base}/api/catalog/channels?category=${cat}&limit=40`, 15000);
    const items = (list.data?.items || []).filter((c) => c.url).map((c) => ({ id: c.id, url: c.url }));
    if (!items.length) continue;
    try {
      const r = await fetch(`${base}/api/catalog/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(90_000),
      });
      const d = await r.json().catch(() => null);
      for (const x of d?.results || []) { probed++; if (x.online) online++; }
    } catch { /* a slow batch only means fewer verdicts */ }
  }
  console.log(`health warm-up: ${online} online of ${probed} streams probed`);
}

async function startServer(name, extra = {}) {
  const port = await freePort();
  const dataDir = path.join(TMP, `data-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const log = path.join(TMP, `server-${name}.log`);
  const out = fs.openSync(log, 'a');
  // Every setting a developer .env could carry is pinned here: dotenv never overrides a
  // variable that is already set (even empty), so the throwaway server is reproducible.
  const env = {
    ...process.env,
    NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, CACHE_DIR: CACHE,
    ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET, SIGNING_SECRET: '', JWT_TTL: '7d', JWT_RENEW_AFTER: '',
    ALLOW_PRIVATE_SOURCES: 'true', // the suites serve crafted upstreams on 127.0.0.1
    REQUIRE_AUTH: 'false', ALLOW_REGISTER: 'true', BILLING_PROVIDER: 'mock', ALLOW_MOCK_BILLING: '',
    STRIPE_SECRET: '', STRIPE_PRICE_ID: '', STRIPE_WEBHOOK_SECRET: '', ADSENSE_CLIENT: '',
    TRUST_PROXY: '', ALLOWED_ORIGINS: '', HEALTH_SWEEP: 'false', EPG_DEFAULT_URL: '',
    CUSTOM_PREMIUM: 'true', HIDE_NSFW: 'true', CATALOG_TTL_HOURS: '12', IPTV_API_BASE,
    ...extra,
  };
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['ignore', out, out] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const base = `http://127.0.0.1:${port}`;
  // Wait for a warm catalog (a cold build from iptv-org can take a minute or two).
  const started = Date.now();
  const deadline = started + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}), see ${log}`);
    const h = await getJson(base + '/api/health', 4000);
    if (h.data?.ok && Number(h.data?.catalog?.total) > 0) return { child, base, log, dataDir, total: h.data.catalog.total };
    if (h.data && !h.data.catalog?.building && Number(h.data.catalog?.total) === 0 && Date.now() - started > 40_000) {
      throw new Error(`catalog empty and not building (iptv-org unreachable?), see ${log}`);
    }
    await sleep(1000);
  }
  throw new Error(`catalog not ready after 240s, see ${log}`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const t = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

function runSuite(file, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'test', file)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(p);
    let tail = '';
    const keep = (b) => { tail = (tail + b.toString()).slice(-4000); };
    p.stdout.on('data', (b) => { process.stdout.write(b); keep(b); });
    p.stderr.on('data', (b) => { process.stderr.write(b); keep(b); });
    p.on('exit', (code) => { children.delete(p); resolve({ code, tail }); });
  });
}

async function cleanup(ok) {
  await Promise.all([...children].map((c) => stopServer(c)));
  if (ok && !process.env.KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`\n(temp dir kept: ${TMP})`);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(false).finally(() => process.exit(130)); });

(async () => {
  const seeded = seedCache();
  let needHealth = !fs.existsSync(path.join(CACHE, 'health.json'));
  if (!seeded) {
    const probe = await getJson(`${IPTV_API_BASE}/categories.json`, 10000);
    if (probe.status !== 200) {
      const msg = `SKIP  every server suite: no catalog cache (server/.cache) and ${IPTV_API_BASE} is unreachable (offline?).`;
      console.log(msg);
      await cleanup(true);
      process.exit(process.env.NW_TEST_STRICT === '1' ? 1 : 0);
    }
    console.log(`No server/.cache: the first server builds the catalog from ${IPTV_API_BASE} (can take a minute).`);
  }

  const results = [];
  for (const name of order) {
    const s = SUITES[name];
    const t0 = Date.now();
    console.log(`\n######## ${name} (${s.file}) ########`);
    let srv;
    try {
      srv = await startServer(name, s.server);
    } catch (e) {
      console.log(`  FAIL  could not start the server: ${e.message}`);
      results.push({ name, ok: false, why: 'server did not start', s: 0 });
      continue;
    }
    if (needHealth) { await warmHealth(srv.base); needHealth = false; }
    const env = { BASE: srv.base, ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET, SERVER_LOG: srv.log, ...(s.env || {}) };
    if (s.dataDir) env.DATA_DIR = srv.dataDir;
    if (s.upstream) env[s.upstream] = String(await freePort());
    for (const k of s.ports || []) env[k] = String(await freePort());
    const r = await runSuite(s.file, env);
    await stopServer(srv.child);
    const m = [...r.tail.matchAll(/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/g)].pop();
    results.push({ name, ok: r.code === 0, why: r.code === 0 ? '' : `exit ${r.code}`, summary: m ? m[0] : '', s: Math.round((Date.now() - t0) / 1000) });
  }

  console.log('\n======== npm test summary ========');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(12)} ${String(r.s).padStart(4)}s  ${r.summary || r.why}`);
  const ok = results.every((r) => r.ok);
  console.log(ok ? '\nALL SUITES PASSED' : '\nSOME SUITES FAILED');
  await cleanup(ok);
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  console.error('FATAL', e);
  await cleanup(false);
  process.exit(2);
});
