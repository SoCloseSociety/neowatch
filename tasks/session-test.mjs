#!/usr/bin/env node
// NEOWATCH sliding-session test: a token that is USED gets renewed before it expires
// (X-Renewed-Token header + `token` on GET /auth/me); a token that is left alone
// expires as before; nothing is ever renewed for an expired/invalid token or a
// disabled/deleted user; password changes invalidate older tokens (tokenVersion).
//
// Run against a server started with a SHORT ttl + threshold, e.g.
//   JWT_TTL=8s JWT_RENEW_AFTER=3s ADMIN_EMAIL=... ADMIN_PASSWORD=... PORT=8790 node server/src/index.js
//   BASE=http://localhost:8790 TTL_S=8 RENEW_S=3 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tasks/session-test.mjs
// Admin creds come from env only -- never hardcode them.

const BASE = process.env.BASE || 'http://localhost:8787';
const TTL_S = Number(process.env.TTL_S) || 8;
const RENEW_S = Number(process.env.RENEW_S) || 3;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const RENEW_HEADER = 'x-renewed-token';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name + (detail ? ` -- ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); }
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const section = (t) => console.log(`\n=== ${t} ===`);
// Optional: with the server's (TEST) JWT_SECRET the suite can also forge tokens (wrong
// algorithm, aged) and sign proxy URLs. Those sections are skipped without it.
const JWT_SECRET = process.env.JWT_SECRET || '';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT) || 8786;
const req = async (path, { method = 'GET', token, body, headers: extra = {} } = {}, retried = false) => {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  // The auth routes are rate limited (30/min per IP); this suite legitimately makes more
  // auth calls than a user would. Wait the window out once rather than fail on a 429.
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get('retry-after')) || 5;
    console.log(`  .. 429 on ${path}, waiting ${wait}s for the rate-limit window`);
    await sleep(wait + 0.5);
    return req(path, { method, token, body, headers: extra }, true);
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  return {
    status: res.status, data, renewed: res.headers.get(RENEW_HEADER),
    etag: res.headers.get('etag'), cacheControl: res.headers.get('cache-control'),
    headers: res.headers,
  };
};
// Conditional requests go through node:http -- Node's fetch adds `Cache-Control: no-cache`
// to every request, which makes Express answer 200 instead of 304 (req.fresh is false),
// so a browser's revalidation cannot be imitated with fetch.
const rawReq = (path, { token, headers: extra = {} } = {}) => new Promise((resolve, reject) => {
  import('node:http').then(({ request }) => {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = request(BASE + path, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, renewed: res.headers[RENEW_HEADER] || null, etag: res.headers.etag || null, cacheControl: res.headers['cache-control'] || null }));
    });
    r.on('error', reject);
    r.end();
  });
});
const noStore = (r) => /\bno-store\b/i.test(r.cacheControl || '');
const payload = (jwt) => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };
const issued = []; // every token we see -- used at the end to grep the server log

(async () => {
  const ts = Date.now();
  const mkUser = async (tag) => {
    const r = await req('/api/auth/register', { method: 'POST', body: { email: `${tag}${ts}@test.local`, password: 'secret123' } });
    if (!r.data?.token) throw new Error(`register failed: ${JSON.stringify(r.data)}`);
    issued.push(r.data.token);
    return { token: r.data.token, id: r.data.user.id, email: `${tag}${ts}@test.local` };
  };
  // The TTL under test is seconds long, so the admin token is re-issued right before each
  // admin-gated section (the test must not depend on the feature it is testing).
  const adminLogin = async () => {
    const r = await req('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (!r.data?.token) { console.error('admin login failed -- set ADMIN_EMAIL/ADMIN_PASSWORD'); process.exit(2); }
    issued.push(r.data.token);
    return r.data.token;
  };
  let adminTok = await adminLogin();

  section(`fresh token (ttl ${TTL_S}s, renew after ${RENEW_S}s)`);
  const u = await mkUser('slide');
  const fresh = await req('/api/auth/me', { token: u.token });
  check('fresh token -> 200', fresh.status === 200);
  check('fresh token is NOT renewed (under threshold)', !fresh.renewed && !fresh.data?.token);

  section('active client: renewed past the threshold');
  await sleep(RENEW_S + 0.5);
  const r1 = await req('/api/auth/me', { token: u.token });
  check('past threshold -> X-Renewed-Token header', !!r1.renewed, `header=${r1.renewed ? 'yes' : 'no'}`);
  check('GET /auth/me body carries the new token too', !!r1.data?.token && r1.data.token === r1.renewed);
  check('new token differs from the old one', !!r1.renewed && r1.renewed !== u.token);
  if (r1.renewed) {
    issued.push(r1.renewed);
    const p = payload(r1.renewed);
    check('new token keeps sub + role', p.sub === u.id && p.role === 'user');
    check('new token has a fresh exp (later than the old)', p.exp > payload(u.token).exp);
  }
  check('a response carrying a renewed token is Cache-Control: no-store', noStore(r1), `cache-control=${r1.cacheControl}`);
  // Keep using the newest token every ~RENEW_S+0.5s for > 2 x TTL: must never 401.
  let cur = r1.renewed || u.token;
  let alive = true, renewals = 0;
  const until = Date.now() + 2 * TTL_S * 1000 + 1000;
  while (Date.now() < until) {
    await sleep(RENEW_S + 0.5);
    const r = await req('/api/catalog/meta', { token: cur });
    if (r.status !== 200) { alive = false; break; }
    if (r.renewed) { renewals++; issued.push(r.renewed); cur = r.renewed; }
  }
  check(`active client stays signed in beyond 2 x TTL (${renewals} renewals)`, alive && renewals >= 2, `alive=${alive} renewals=${renewals}`);
  check('original token (never swapped) has expired -> 401', (await req('/api/auth/me', { token: u.token })).status === 401);
  const underThreshold = await req('/api/auth/me', { token: cur });
  check('a just-renewed token is not renewed again at once (no loop)', underThreshold.status === 200 && !underThreshold.renewed);

  section('HTTP cache: a renewed token can never be replayed to the next user of the browser');
  // /api/config is identical for everyone (same ETag) and is the FIRST call of every app
  // start, made with the token. If a 200 carrying X-Renewed-Token were stored by the
  // browser cache, a later 304 revalidation would merge that stored header into another
  // user's response. So: a renewing response must drop the validators (full 200, never
  // a 304) and be no-store; a non-renewing one keeps normal caching.
  const c1 = await mkUser('cache');
  const warm = await rawReq('/api/config', { token: c1.token });
  check('fresh token: /api/config 200 with an ETag (normal caching)', warm.status === 200 && !!warm.etag);
  check('fresh token: no Cache-Control: no-store (nothing sensitive in that response)', !noStore(warm), `cache-control=${warm.cacheControl}`);
  const rev = await rawReq('/api/config', { token: c1.token, headers: { 'If-None-Match': warm.etag || '"x"' } });
  check('fresh token + If-None-Match -> 304 (caching still works under the threshold)', rev.status === 304 && !rev.renewed, `status=${rev.status}`);
  await sleep(RENEW_S + 0.5);
  const due = await rawReq('/api/config', { token: c1.token, headers: { 'If-None-Match': warm.etag || '"x"' } });
  check('due token + If-None-Match -> full 200, never a 304', due.status === 200 && due.body.length > 0, `status=${due.status}`);
  check('due token + If-None-Match -> renewed token present', !!due.renewed);
  check('due token + If-None-Match -> Cache-Control: no-store', noStore(due), `cache-control=${due.cacheControl}`);
  if (due.renewed) issued.push(due.renewed);
  // Another user revalidating right after must not see any token (nothing was stored
  // server-side either; this pins the server contract the browser test relies on).
  const c2 = await mkUser('cache2');
  const nextUser = await rawReq('/api/config', { token: c2.token, headers: { 'If-None-Match': warm.etag || '"x"' } });
  check('next user + If-None-Match -> 304 without any X-Renewed-Token', nextUser.status === 304 && !nextUser.renewed, `status=${nextUser.status} renewed=${!!nextUser.renewed}`);

  section('silent client: expires as before');
  const q = await mkUser('quiet');
  await sleep(TTL_S + 1.5);
  const dead = await req('/api/auth/me', { token: q.token });
  check('silent token past TTL -> 401', dead.status === 401);
  check('expired token is never renewed', !dead.renewed && !dead.data?.token);

  section('garbage token');
  const bad = await req('/api/auth/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad' });
  check('invalid token -> 401, no renewal', bad.status === 401 && !bad.renewed);

  section('disabled user');
  adminTok = await adminLogin();
  const d = await mkUser('off');
  const dis = await req(`/api/admin/users/${d.id}`, { method: 'PATCH', token: adminTok, body: { status: 'disabled' } });
  check('admin disables user', dis.status === 200 && dis.data?.user?.status === 'disabled');
  await sleep(RENEW_S + 0.5);
  const offMe = await req('/api/auth/me', { token: d.token });
  check('disabled user -> 401, no renewal', offMe.status === 401 && !offMe.renewed && !offMe.data?.token);
  adminTok = await adminLogin();
  await req(`/api/admin/users/${d.id}`, { method: 'PATCH', token: adminTok, body: { status: 'active' } });
  const back = await req('/api/auth/login', { method: 'POST', body: { email: d.email, password: 'secret123' } });
  check('re-enabled user can log in again (fresh token)', back.status === 200 && !!back.data?.token);
  if (back.data?.token) issued.push(back.data.token);

  section('deleted user');
  adminTok = await adminLogin();
  const g = await mkUser('gone');
  const del = await req(`/api/admin/users/${g.id}`, { method: 'DELETE', token: adminTok });
  check('admin deletes user', del.status === 200);
  await sleep(RENEW_S + 0.5);
  const goneMe = await req('/api/auth/me', { token: g.token });
  check('deleted user -> 401, no renewal', goneMe.status === 401 && !goneMe.renewed);

  section('demoted admin: renewed token re-reads the role from the store');
  adminTok = await adminLogin();
  const mk = await req('/api/admin/users', { method: 'POST', token: adminTok, body: { email: `adm${ts}@test.local`, password: 'secret123', role: 'admin' } });
  check('admin creates a second admin', mk.status === 200 && mk.data?.user?.role === 'admin');
  const a2 = await req('/api/auth/login', { method: 'POST', body: { email: `adm${ts}@test.local`, password: 'secret123' } });
  const a2tok = a2.data?.token; issued.push(a2tok);
  check('second admin token says role=admin', payload(a2tok).role === 'admin');
  const demote = await req(`/api/admin/users/${mk.data?.user?.id}`, { method: 'PATCH', token: adminTok, body: { role: 'user' } });
  check('demoted to user', demote.status === 200 && demote.data?.user?.role === 'user');
  await sleep(RENEW_S + 0.5);
  const a2me = await req('/api/auth/me', { token: a2tok });
  check('demoted admin still gets a renewed token (account active)', a2me.status === 200 && !!a2me.renewed);
  if (a2me.renewed) {
    issued.push(a2me.renewed);
    check('renewed token carries role=user (re-read from store)', payload(a2me.renewed).role === 'user');
    check('renewed token cannot call admin API -> 403', (await req('/api/admin/users', { token: a2me.renewed })).status === 403);
  }

  section('password change revokes older tokens (tokenVersion)');
  const pw = await mkUser('pw');
  const other = await req('/api/auth/login', { method: 'POST', body: { email: pw.email, password: 'secret123' } });
  const otherTok = other.data?.token; issued.push(otherTok);
  check('second device signed in', !!otherTok);
  // Change the password with a token that is already DUE for renewal: the header must
  // carry the post-revocation token (same as the body), not one signed before the bump.
  await sleep(RENEW_S + 0.5);
  const chg = await req('/api/auth/password', { method: 'PUT', token: pw.token, body: { currentPassword: 'secret123', newPassword: 'newsecret1' } });
  check('password change -> 200 with a fresh token', chg.status === 200 && !!chg.data?.token);
  if (chg.data?.token) issued.push(chg.data.token);
  check('password change: X-Renewed-Token header == body token (signed AFTER revocation)', !!chg.renewed && chg.renewed === chg.data?.token, `header tv=${payload(chg.renewed).tv} body tv=${payload(chg.data?.token).tv}`);
  check('password change response is Cache-Control: no-store', noStore(chg));
  check('old token of the SAME device -> 401', (await req('/api/auth/me', { token: pw.token })).status === 401);
  check('token of the OTHER device -> 401 (signed out everywhere)', (await req('/api/auth/me', { token: otherTok })).status === 401);
  check('token returned by the password change works', (await req('/api/auth/me', { token: chg.data?.token })).status === 200);
  adminTok = await adminLogin();
  const reset = await req(`/api/admin/users/${pw.id}`, { method: 'PATCH', token: adminTok, body: { password: 'adminset1' } });
  check('admin resets the password', reset.status === 200);
  check('after admin reset the user token -> 401', (await req('/api/auth/me', { token: chg.data?.token })).status === 401);
  const relog = await req('/api/auth/login', { method: 'POST', body: { email: pw.email, password: 'adminset1' } });
  check('login with the admin-set password works', relog.status === 200 && !!relog.data?.token);
  if (relog.data?.token) issued.push(relog.data.token);

  section('admin resetting their OWN password from the admin panel keeps this device signed in');
  adminTok = await adminLogin();
  const mkSelf = await req('/api/admin/users', { method: 'POST', token: adminTok, body: { email: `selfadm${ts}@test.local`, password: 'secret123', role: 'admin' } });
  const selfId = mkSelf.data?.user?.id;
  const selfLogin = await req('/api/auth/login', { method: 'POST', body: { email: `selfadm${ts}@test.local`, password: 'secret123' } });
  const selfTok = selfLogin.data?.token; if (selfTok) issued.push(selfTok);
  check('second admin signed in', !!selfId && !!selfTok);
  const selfReset = await req(`/api/admin/users/${selfId}`, { method: 'PATCH', token: selfTok, body: { password: 'selfreset1' } });
  check('self reset -> 200', selfReset.status === 200);
  check('self reset -> X-Renewed-Token for THIS device (not signed out)', !!selfReset.renewed && payload(selfReset.renewed).sub === selfId, `header=${selfReset.renewed ? 'yes' : 'no'}`);
  if (selfReset.renewed) {
    issued.push(selfReset.renewed);
    check('self reset: the handed token still has admin rights', (await req('/api/admin/users', { token: selfReset.renewed })).status === 200);
  }
  check('self reset: the previous token is revoked -> 401', (await req('/api/admin/users', { token: selfTok })).status === 401);
  const otherAdminReset = await req(`/api/admin/users/${selfId}`, { method: 'PATCH', token: adminTok, body: { password: 'byother1' } });
  check('reset by ANOTHER admin hands no token to the caller', otherAdminReset.status === 200 && !otherAdminReset.renewed);

  section('config guard: JWT_RENEW_AFTER edge values warn at boot');
  {
    const { execFileSync } = await import('node:child_process');
    const cfgUrl = new URL('../server/src/config.js', import.meta.url).href;
    const warnsFor = (renewAfter, ttl = '30d', key = 'JWT_RENEW_AFTER') => {
      const env = { ...process.env, JWT_TTL: ttl, JWT_RENEW_AFTER: renewAfter, JWT_SECRET: 'test-secret-'.repeat(4) };
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import('${cfgUrl}').then((m) => console.log(JSON.stringify(m.validateConfig())))`], { env, encoding: 'utf8' });
      return JSON.parse(out.trim().split('\n').pop()).filter((w) => w.key === key);
    };
    check('JWT_RENEW_AFTER=0 (renew on every request) -> warning', warnsFor('0').length === 1, JSON.stringify(warnsFor('0')));
    check('JWT_RENEW_AFTER=45d >= JWT_TTL=30d (feature silently off) -> warning', warnsFor('45d').length === 1, JSON.stringify(warnsFor('45d')));
    check('JWT_RENEW_AFTER=1.5d (unparseable) -> warning', warnsFor('1.5d').length === 1);
    check('JWT_RENEW_AFTER=1d with JWT_TTL=30d -> no warning', warnsFor('1d').length === 0);
    check('JWT_RENEW_AFTER unset -> no warning', warnsFor('').length === 0);
    // jsonwebtoken reads a unit-less STRING as milliseconds ("604800" = 10 min, not 7 days).
    check('JWT_TTL=604800 (no unit, read as ms by jsonwebtoken) -> warning', warnsFor('', '604800', 'JWT_TTL').length === 1, JSON.stringify(warnsFor('', '604800', 'JWT_TTL')));
    check('JWT_TTL=7d -> no warning', warnsFor('', '7d', 'JWT_TTL').length === 0);
  }

  section('TV pairing: the paired token slides the same way');
  const phone = await mkUser('phone');
  const start = await req('/api/auth/device/start', { method: 'POST', body: {} });
  check('device/start gives deviceCode + userCode', !!start.data?.deviceCode && /^[A-Z2-9]{6}$/.test(start.data?.userCode || ''));
  const pending = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: start.data?.deviceCode } });
  check('poll before approval -> pending', pending.data?.status === 'pending');
  const appr = await req('/api/auth/device/approve', { method: 'POST', token: phone.token, body: { code: start.data?.userCode } });
  check('phone approves the code', appr.status === 200 && appr.data?.ok === true);
  const polled = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: start.data?.deviceCode } });
  check('TV poll -> approved + token for the phone account', polled.data?.status === 'approved' && !!polled.data?.token && polled.data?.user?.id === phone.id);
  const tvTok = polled.data?.token; if (tvTok) issued.push(tvTok);
  check('TV token fresh -> not renewed yet', !(await req('/api/auth/me', { token: tvTok })).renewed);
  await sleep(RENEW_S + 0.5);
  const tvMe = await req('/api/auth/me', { token: tvTok });
  check('TV token past threshold -> renewed (TV stays signed in)', tvMe.status === 200 && !!tvMe.renewed && tvMe.data?.user?.id === phone.id);
  if (tvMe.renewed) issued.push(tvMe.renewed);

  section('TV pairing approved then kept in reserve cannot outlive a revocation');
  // A token thief approves a pairing code they requested themselves and does NOT poll:
  // the approved record is a reserve. Once the victim changes their password (or an admin
  // resets / disables the account) the reserve must be dead too, otherwise the documented
  // guarantee "password change signs everyone else out" is false.
  const victim = await mkUser('res');
  const stolen = (await req('/api/auth/login', { method: 'POST', body: { email: victim.email, password: 'secret123' } })).data?.token;
  issued.push(stolen);
  const res1 = await req('/api/auth/device/start', { method: 'POST', body: {} });
  check('thief approves their own code with the stolen token', (await req('/api/auth/device/approve', { method: 'POST', token: stolen, body: { code: res1.data?.userCode } })).status === 200);
  const vchg = await req('/api/auth/password', { method: 'PUT', token: victim.token, body: { currentPassword: 'secret123', newPassword: 'victim-new1' } });
  check('victim changes their password', vchg.status === 200 && !!vchg.data?.token);
  if (vchg.data?.token) issued.push(vchg.data.token);
  check('stolen token -> 401', (await req('/api/auth/me', { token: stolen })).status === 401);
  const poll1 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: res1.data?.deviceCode } });
  check('after the password change the reserve poll -> expired, no token', poll1.data?.status === 'expired' && !poll1.data?.token, `status=${poll1.data?.status} token=${poll1.data?.token ? 'yes' : 'no'}`);
  // Positive control: a pairing approved AFTER the change (by the legitimate device) works.
  const res2 = await req('/api/auth/device/start', { method: 'POST', body: {} });
  await req('/api/auth/device/approve', { method: 'POST', token: vchg.data?.token, body: { code: res2.data?.userCode } });
  const poll2 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: res2.data?.deviceCode } });
  check('a pairing approved after the change still hands a valid token', poll2.data?.status === 'approved' && (await req('/api/auth/me', { token: poll2.data?.token })).status === 200);
  if (poll2.data?.token) issued.push(poll2.data.token);
  // Admin reset.
  adminTok = await adminLogin();
  const victim2 = await mkUser('res2');
  const res3 = await req('/api/auth/device/start', { method: 'POST', body: {} });
  await req('/api/auth/device/approve', { method: 'POST', token: victim2.token, body: { code: res3.data?.userCode } });
  await req(`/api/admin/users/${victim2.id}`, { method: 'PATCH', token: adminTok, body: { password: 'adminreset1' } });
  const poll3 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: res3.data?.deviceCode } });
  check('after an admin password reset the reserve poll -> expired, no token', poll3.data?.status === 'expired' && !poll3.data?.token, `status=${poll3.data?.status}`);
  // Disable then re-enable within the pairing TTL. The admin token is re-issued right
  // before: a 429 wait inside mkUser (7 s) is enough to expire an 8 s admin token, and a
  // 401 on the PATCH would leave the reserve alive for a reason that is not the feature's.
  const victim3 = await mkUser('res3');
  const res4 = await req('/api/auth/device/start', { method: 'POST', body: {} });
  await req('/api/auth/device/approve', { method: 'POST', token: victim3.token, body: { code: res4.data?.userCode } });
  adminTok = await adminLogin();
  const patchOff = await req(`/api/admin/users/${victim3.id}`, { method: 'PATCH', token: adminTok, body: { status: 'disabled' } });
  const patchOn = await req(`/api/admin/users/${victim3.id}`, { method: 'PATCH', token: adminTok, body: { status: 'active' } });
  const poll4 = await req('/api/auth/device/poll', { method: 'POST', body: { deviceCode: res4.data?.deviceCode } });
  check('after disable + re-enable the reserve poll -> expired, no token', patchOff.status === 200 && patchOn.status === 200 && poll4.data?.status === 'expired' && !poll4.data?.token, `patch=${patchOff.status}/${patchOn.status} status=${poll4.data?.status}`);

  section('two simultaneous password changes: exactly one wins');
  // Two devices of the same account submit a change at the same instant. The second one to
  // write must be refused (409, the hash changed under it) so the account never ends up with
  // one device believing a password that is not the one stored; the winner keeps a valid
  // token, the loser's old token is revoked (it has to log in again with the new password).
  const duo = await mkUser('duo');
  const devA = (await req('/api/auth/login', { method: 'POST', body: { email: duo.email, password: 'secret123' } })).data?.token;
  const devB = (await req('/api/auth/login', { method: 'POST', body: { email: duo.email, password: 'secret123' } })).data?.token;
  issued.push(devA, devB);
  const [chgA, chgB] = await Promise.all([
    req('/api/auth/password', { method: 'PUT', token: devA, body: { currentPassword: 'secret123', newPassword: 'from-a-1' } }),
    req('/api/auth/password', { method: 'PUT', token: devB, body: { currentPassword: 'secret123', newPassword: 'from-b-1' } }),
  ]);
  const statuses = [chgA.status, chgB.status].sort();
  check('one 200 and one 409', statuses[0] === 200 && statuses[1] === 409, `statuses=${chgA.status}/${chgB.status}`);
  const winner = chgA.status === 200 ? { r: chgA, pw: 'from-a-1', other: devB } : { r: chgB, pw: 'from-b-1', other: devA };
  if (winner.r.data?.token) issued.push(winner.r.data.token);
  check('the winner\'s handed token is valid', (await req('/api/auth/me', { token: winner.r.data?.token })).status === 200);
  check('the loser\'s token is revoked -> 401', (await req('/api/auth/me', { token: winner.other })).status === 401);
  const loginWin = await req('/api/auth/login', { method: 'POST', body: { email: duo.email, password: winner.pw } });
  const loginLose = await req('/api/auth/login', { method: 'POST', body: { email: duo.email, password: winner.pw === 'from-a-1' ? 'from-b-1' : 'from-a-1' } });
  check('only the winner\'s password logs in', loginWin.status === 200 && loginLose.status === 401, `win=${loginWin.status} lose=${loginLose.status}`);
  if (loginWin.data?.token) issued.push(loginWin.data.token);

  section('user-specific responses are Cache-Control: private, no-store');
  const pv = await mkUser('priv');
  const cc = (r) => (r.cacheControl || '').toLowerCase();
  const meFresh = await req('/api/auth/me', { token: pv.token });
  check('GET /auth/me -> private, no-store', meFresh.status === 200 && /\bprivate\b/.test(cc(meFresh)) && /\bno-store\b/.test(cc(meFresh)), `cache-control=${meFresh.cacheControl}`);
  const loginRes = await req('/api/auth/login', { method: 'POST', body: { email: pv.email, password: 'secret123' } });
  if (loginRes.data?.token) issued.push(loginRes.data.token);
  check('POST /auth/login (carries a token) -> private, no-store', /\bno-store\b/.test(cc(loginRes)) && /\bprivate\b/.test(cc(loginRes)), `cache-control=${loginRes.cacheControl}`);
  const prefs = await req('/api/me/prefs', { token: pv.token });
  check('GET /me/prefs -> private, no-store', prefs.status === 200 && /\bno-store\b/.test(cc(prefs)), `cache-control=${prefs.cacheControl}`);
  const pubCfg = await req('/api/config', { token: pv.token });
  check('/api/config with a fresh token keeps normal caching (not user-specific)', pubCfg.status === 200 && !/\bno-store\b/.test(cc(pubCfg)), `cache-control=${pubCfg.cacheControl}`);

  if (JWT_SECRET) {
    const { createHmac } = await import('node:crypto');
    const jwtLib = (await import('jsonwebtoken')).default;
    const nowS = () => Math.floor(Date.now() / 1000);
    const craft = (claims, ageS, algorithm = 'HS256') => { const iat = nowS() - ageS; return jwtLib.sign({ ...claims, iat, exp: iat + TTL_S }, JWT_SECRET, { algorithm }); };

    section('signature algorithm pinned to HS256');
    const alg = await mkUser('alg');
    const hs512 = craft({ sub: alg.id, role: 'user', tv: 0 }, 0, 'HS512'); issued.push(hs512);
    const r512 = await req('/api/auth/me', { token: hs512 });
    check('HS512 token signed with the right secret -> 401, no renewal', r512.status === 401 && !r512.renewed, `status=${r512.status}`);
    const hs256 = craft({ sub: alg.id, role: 'user', tv: 0 }, 0); issued.push(hs256);
    check('HS256 control token -> 200', (await req('/api/auth/me', { token: hs256 })).status === 200);

    section('/api/proxy never carries a token (ours or the upstream\'s)');
    // Needs ALLOW_PRIVATE_SOURCES=true on the test server (the upstream is local).
    const { createServer } = await import('node:http');
    const forged = craft({ sub: alg.id, role: 'user', tv: 0 }, -30); // "newer" than anything held
    const upstream = createServer((q, s) => {
      s.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'public, max-age=3600', ETag: '"amont"', 'X-Renewed-Token': forged });
      s.end('segment');
    });
    await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
    try {
      const signingSecret = createHmac('sha256', JWT_SECRET).update('neowatch:url-signing:v1').digest('hex');
      const target = `http://127.0.0.1:${UPSTREAM_PORT}/seg.ts`;
      const exp = Date.now() + 3600_000;
      // v2 link (signing.js): HMAC over ['v2', exp, url, ua, ref, root, lan]. lan=1 lets the
      // proxy reach this local upstream (it is honoured only with ALLOW_PRIVATE_SOURCES=true).
      const sig = createHmac('sha256', signingSecret).update(JSON.stringify(['v2', exp, target, '', '', '', 1])).digest('base64url');
      const due = craft({ sub: alg.id, role: 'user', tv: 0 }, RENEW_S + 1); issued.push(due);
      const ctl = await req('/api/config', { token: due });
      check('control: the due token IS renewed on a normal route', ctl.status === 200 && !!ctl.renewed);
      if (ctl.renewed) issued.push(ctl.renewed);
      const px = await req(`/api/proxy?url=${encodeURIComponent(target)}&lan=1&exp=${exp}&sig=${sig}`, { token: due });
      if (px.status === 403 || px.status === 502) console.log(`  SKIP  proxy answered ${px.status}: start the test server with ALLOW_PRIVATE_SOURCES=true for this section`);
      check('proxy with a due token -> 200 from the upstream', px.status === 200 && px.data === 'segment', `status=${px.status}`);
      check('proxy response carries NO X-Renewed-Token (no renewal on /api/proxy)', !px.renewed, px.renewed ? `header present (${px.renewed === forged ? 'upstream\'s forged token passed through' : 'renewal'})` : '');
      check('upstream X-Renewed-Token header is stripped', px.renewed !== forged);
    } finally {
      upstream.close();
    }
  } else {
    console.log('  SKIP  set JWT_SECRET (the TEST server\'s) to run the algorithm + proxy sections');
  }

  section('tokens never appear in the server log');
  if (process.env.SERVER_LOG) {
    const { readFileSync } = await import('node:fs');
    const log = readFileSync(process.env.SERVER_LOG, 'utf8');
    const leaked = issued.filter(Boolean).filter((t) => log.includes(t));
    check(`no issued token found in ${process.env.SERVER_LOG} (${issued.length} tokens checked)`, leaked.length === 0, `${leaked.length} leaked`);
  } else {
    console.log('  SKIP  set SERVER_LOG=<path> to grep the server log for leaked tokens');
  }

  console.log(`\n===== RESULT: ${pass} passed, ${fail} failed =====`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  x ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
