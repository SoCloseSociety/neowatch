import { Router } from 'express';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { rateLimit } from './ratelimit.js';

// A valid bcrypt hash compared against when an email is unknown, so login timing
// does not reveal whether an account exists (constant-time-ish enumeration guard).
const DUMMY_HASH = bcrypt.hashSync('neowatch-timing-guard', 10);

const authLimit = rateLimit({ windowMs: 60_000, max: 30, name: 'auth' });
// Roaming writes (favorites, mosaic, prefs): generous for a household behind one NAT,
// low enough that a script cannot make every save() re-serialize the store in a loop.
const syncLimit = rateLimit({ windowMs: 60_000, max: 60, name: 'sync' });

// Express 4 does not catch a rejected async handler: the request hangs and the error
// surfaces as an unhandledRejection. Every async route goes through this instead.
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error('[auth] route failed:', e?.code || '', e?.message || e);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

// Input shapes. Anything that is not a string of a sane size is refused before it
// reaches bcrypt (a non-string password made bcrypt reject and the request hang) or
// the store (an object name was persisted and echoed back).
const EMAIL_MAX = 254;
const NAME_MAX = 60;
const PW_MIN = 6;
const PW_MAX = 128; // bcrypt only reads the first 72 bytes; refuse what would be silently cut
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (v) => {
  if (typeof v !== 'string') return null;
  const e = v.toLowerCase().trim();
  return e.length <= EMAIL_MAX && EMAIL_RE.test(e) ? e : null;
};
const validPassword = (v) => typeof v === 'string' && v.length >= PW_MIN && v.length <= PW_MAX;
// Optional display name: undefined/'' -> fallback, a string -> trimmed + capped, anything else -> invalid.
const cleanName = (v, fallback) => {
  if (v === undefined || v === null || v === '') return (fallback || '').slice(0, NAME_MAX);
  if (typeof v !== 'string') return null;
  return v.trim().slice(0, NAME_MAX) || (fallback || '').slice(0, NAME_MAX);
};
const PW_ERROR = `password must be ${PW_MIN} to ${PW_MAX} characters`;

// Lightweight, dependency-free user store (JSON file). Plenty for a
// localhost / small-VPS deployment with a handful of friends. Swap for a
// real DB later by reimplementing load()/save() only.

const USERS_FILE = join(config.dataDir, 'users.json');
let users = [];
let loaded = false;

async function load() {
  try {
    users = JSON.parse(await readFile(USERS_FILE, 'utf8'));
  } catch {
    users = [];
  }
  loaded = true;
}

// Serialize writes (no interleaving) and write atomically (temp file + rename)
// so a crash mid-write can never truncate users.json. The caller gets this write's
// outcome, but the queue itself never stays rejected: one failed write (ENOSPC,
// EACCES) must not skip every later save. Compact JSON: the whole store is
// re-serialized on each write.
let writeChain = Promise.resolve();
function save() {
  const p = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${USERS_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(users));
    await rename(tmp, USERS_FILE);
  });
  writeChain = p.catch(() => {});
  return p;
}

const sanitize = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status,
  plan: u.plan || 'free',
  planExpires: u.planExpires || null,
  premium: isPremium(u),
  // Where the plan came from (mock | stripe | admin; null on legacy records) and whether
  // it was cancelled: premium then stays on until planExpires, nothing renews it (only
  // meaningful while premium: an expired plan is simply free).
  planSource: u.planSource || null,
  cancelAtPeriodEnd: !!u.cancelAtPeriodEnd && isPremium(u),
  createdAt: u.createdAt,
  favorites: u.favorites || [],
  // Multi-screen mosaic config, roams across devices (set it on your computer,
  // pick it up on the TV after signing in).
  multi: u.multi || [],
});

// A user is premium if on the premium plan and not expired. Admins are always premium.
export function isPremium(u) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  return u.plan === 'premium' && (!u.planExpires || u.planExpires > Date.now());
}

export function findUserById(id) {
  return users.find((u) => u.id === id) || null;
}

export function findByStripeCustomer(customerId) {
  return users.find((u) => u.stripeCustomerId === customerId) || null;
}

export async function setStripeCustomer(user, customerId) {
  user.stripeCustomerId = customerId;
  await save();
}

// Apply a plan and/or billing fields in ONE persisted write (the Stripe webhook must
// learn whether it stuck: a failed save is a 500 so Stripe retries).
//  - plan: 'premium' | 'free' (omit to leave the plan alone). For premium, expiry =
//    explicit expiresAt (ms, e.g. Stripe period end) if given, else now + days, else
//    null (lifetime). source = 'mock' | 'stripe' | 'admin'.
//  - any of BILLING_FIELDS: Stripe ids, event ordering stamp, cancel-at-period-end.
const BILLING_FIELDS = ['stripeCustomerId', 'stripeSubscriptionId', 'stripeEventAt', 'cancelAtPeriodEnd'];
export async function updateBilling(user, { plan, days, expiresAt, source, ...fields } = {}) {
  if (plan !== undefined) {
    user.plan = plan === 'premium' ? 'premium' : 'free';
    if (user.plan === 'premium') {
      user.planExpires = expiresAt || (days ? Date.now() + days * 86400000 : null);
    } else {
      user.planExpires = null;
    }
    user.planSource = source || null;
    // A new grant or a downgrade both end any pending cancellation, unless the caller
    // states it (a Stripe subscription can be active AND set to cancel).
    if (!('cancelAtPeriodEnd' in fields)) user.cancelAtPeriodEnd = false;
  }
  for (const k of BILLING_FIELDS) {
    if (!(k in fields)) continue;
    if (fields[k] === null || fields[k] === undefined) delete user[k];
    else user[k] = fields[k];
  }
  await save();
  return sanitize(user);
}

// Set a user's plan (see updateBilling for the expiry rules).
export function setPlan(user, plan, days, expiresAt, source) {
  return updateBilling(user, { plan, days, expiresAt, source });
}

// Hooks run before an account is removed (self-service or admin). billing.js uses it to
// cancel a live Stripe subscription: deleting the account must stop the charges. A hook
// that throws aborts the deletion (the caller answers 502), so nothing keeps billing a
// user who no longer exists.
const deleteHooks = [];
export function onBeforeUserDelete(fn) {
  deleteHooks.push(fn);
}
async function runDeleteHooks(user) {
  for (const fn of deleteHooks) await fn(user);
}

export { sanitize };

// `tv` = the user's tokenVersion at signing time. Bumping it (password change, admin
// reset, disable) invalidates every token issued before. Absent on legacy tokens and
// legacy users == 0, so tokens issued before this field existed keep working.
function sign(user) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion || 0 }, config.jwtSecret, { expiresIn: config.jwtTtl });
}

// Sign anyone else out: every existing token of this user stops verifying, and so does
// every TV pairing this user approved but that was not polled yet (an approved pairing is
// a token in reserve: without this, a thief who approved their own code with the stolen
// token could still collect a fresh token after the victim changed their password).
function revokeTokens(user) {
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  dropPairingsOf(user.id);
}

// Verify a raw token and resolve it to { user, payload }, or null when the token is
// expired/invalid, the user is gone or disabled, or its tokenVersion is stale.
function resolveToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    // Pin the algorithm: the key is an HMAC secret, so only HS256 is ever legitimate.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    const user = users.find((u) => u.id === payload.sub);
    if (!user || user.status !== 'active') return null;
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) return null;
    return { user, payload };
  } catch {
    return null; // invalid/expired: anonymous
  }
}

// Sliding session: once a VALID token (verified above -- never an expired, invalid,
// disabled, deleted or revoked one) is older than the renewal threshold, return a
// fresh token signed from the user as stored now (role/tokenVersion re-read). A fresh
// token has a new iat, so at most one renewal happens per threshold. The token is
// returned to the caller only; it must never reach a log line.
function renewIfDue(user, payload) {
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null;
  const lifetimeMs = (payload.exp - payload.iat) * 1000;
  const threshold = config.jwtRenewAfterMs ?? lifetimeMs / 2;
  const ageMs = Date.now() - payload.iat * 1000;
  return ageMs >= threshold ? sign(user) : null;
}

export async function initAuth() {
  if (!loaded) await load();

  // Ensure an admin exists on first boot.
  const hasAdmin = users.some((u) => u.role === 'admin');
  if (!hasAdmin) {
    const password = config.adminPassword || randomBytes(9).toString('base64url');
    const admin = {
      id: randomUUID(),
      email: config.adminEmail.toLowerCase(),
      name: 'Administrator',
      role: 'admin',
      status: 'active',
      plan: 'premium',
      planExpires: null,
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
      favorites: [],
    };
    users.push(admin);
    await save();
    console.log('\n  ┌──────────────────────────────────────────────────────────');
    console.log('  │  NEOWATCH admin account created');
    console.log(`  │  email:    ${admin.email}`);
    if (!config.adminPassword) console.log(`  │  password: ${password}   <-- save it, shown once`);
    else console.log('  │  password: (from ADMIN_PASSWORD env)');
    console.log('  └──────────────────────────────────────────────────────────\n');
  }
}

// Hand a fresh token to THIS response (X-Renewed-Token header + req.renewedToken for
// handlers that echo it in the body). The only place a token is attached to a response
// outside login/register/device-poll, so the cache rules live here:
//  - Cache-Control: no-store -- a response carrying a token must never be stored by the
//    browser or a proxy. /api/config is identical for everyone (same ETag) and is the
//    first call of every app start, made with the token: a stored copy carrying user A's
//    token would be replayed (304 + merged stored headers) to whoever signs in next on
//    the same browser/TV, and api.ts would adopt A's session.
//  - Drop the request validators so the handler emits a full 200, never a 304: a 304
//    makes the browser UPDATE its stored copy with these headers, token included.
//  - no-store is re-asserted at the last moment (when the headers are flushed): a handler
//    that sets its own Cache-Control after us must not turn a token-carrying response
//    into a cacheable one.
const PRIVATE_NO_STORE = 'private, no-store';
function handToken(req, res, token) {
  req.renewedToken = token;
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.setHeader('Cache-Control', PRIVATE_NO_STORE);
  res.setHeader('X-Renewed-Token', token);
  if (!res.__tokenGuard) {
    res.__tokenGuard = true;
    const writeHead = res.writeHead;
    res.writeHead = function guardedWriteHead(...args) {
      if (this.getHeader('X-Renewed-Token')) this.setHeader('Cache-Control', PRIVATE_NO_STORE);
      return writeHead.apply(this, args);
    };
  }
}

// Responses that belong to one user (account, preferences, admin, anything that hands a
// token in its body) must never be stored by a browser or an intermediary cache.
export function privateNoStore(_req, res, next) {
  res.setHeader('Cache-Control', PRIVATE_NO_STORE);
  next();
}

// The stream proxy relays bytes from third-party CDNs to <video>/hls.js, which never send
// an Authorization header and never read X-Renewed-Token. Renewing there would only put a
// token on a response whose caching rules belong to the upstream.
const isProxyPath = (req) => (req.baseUrl + req.path).startsWith('/api/proxy');

// Express middleware: attaches req.user when a valid token is present.
// When the token is due for renewal, the fresh one rides in the X-Renewed-Token response
// header (the web client swaps it in) and in req.renewedToken (GET /auth/me echoes it).
export function authenticate(req, res, next) {
  if (req.user) return next(); // already resolved by the app-level pass
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const hit = resolveToken(token);
  if (hit) {
    req.user = hit.user;
    const renewed = isProxyPath(req) ? null : renewIfDue(hit.user, hit.payload);
    if (renewed) handToken(req, res, renewed);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}

// Resolve a user from a raw token (used for proxy/segment requests where the
// browser/hls.js cannot send an Authorization header, so the token rides in ?t=).
export function userFromToken(token) {
  return resolveToken(token)?.user || null;
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

// Gate the catalog/proxy when REQUIRE_AUTH is on (SaaS mode).
export function gateContent(req, res, next) {
  if (!config.requireAuth) return next();
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}

// Premium-only features (e.g. saving watch preferences/profiles).
export function requirePremium(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  if (!isPremium(req.user)) return res.status(402).json({ error: 'premium plan required' });
  next();
}

// Bound + clean a preferences object before persisting it.
function sanitizePrefs(p) {
  const arr = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n) : []);
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 8) : null);
  const home = p?.home || {};
  return {
    hiddenCategories: arr(p?.hiddenCategories, 40),
    pinnedCategories: arr(p?.pinnedCategories, 20),
    home: {
      category: typeof home.category === 'string' ? home.category.slice(0, 24) : null,
      country: str(home.country),
      language: str(home.language),
      foot: !!home.foot,
    },
    collections: Array.isArray(p?.collections)
      ? p.collections.slice(0, 30).map((c) => ({
          id: String(c?.id || '').slice(0, 40),
          name: String(c?.name || 'Liste').slice(0, 60),
          urls: arr(c?.urls, 500),
        }))
      : [],
    defaults: {
      muted: p?.defaults?.muted !== false,
      density: ['cozy', 'comfortable', 'compact'].includes(p?.defaults?.density) ? p.defaults.density : null,
    },
  };
}

// Mounted at /api: no-store sits on its own routes only. A router-level use() would run
// for EVERY /api request mounted after it (catalog, epg, films...) and mark them all
// private, no-store.
export const prefsRouter = Router();
// Read prefs: any logged-in user (free sees their stored prefs or empty).
prefsRouter.get('/me/prefs', privateNoStore, requireUser, (req, res) => res.json({ prefs: req.user.prefs || null }));
// Write prefs: premium feature.
prefsRouter.put('/me/prefs', privateNoStore, syncLimit, requirePremium, wrap(async (req, res) => {
  req.user.prefs = sanitizePrefs(req.body?.prefs || {});
  await save();
  res.json({ prefs: req.user.prefs });
}));

export const authRouter = Router();
// Everything under /api/auth is about one account (and login/register/device-poll carry a
// token in the body): never cacheable.
authRouter.use(privateNoStore);

authRouter.post('/register', authLimit, wrap(async (req, res) => {
  if (!config.allowRegister) return res.status(403).json({ error: 'registration disabled' });
  const { email, password, name } = req.body || {};
  const norm = cleanEmail(email);
  if (!norm || !validPassword(password)) {
    return res.status(400).json({ error: `a valid email and a ${PW_MIN} to ${PW_MAX} character password are required` });
  }
  const displayName = cleanName(name, norm.split('@')[0]);
  if (displayName === null) return res.status(400).json({ error: 'name must be text' });
  if (users.some((u) => u.email === norm)) return res.status(409).json({ error: 'email already registered' });

  const user = {
    id: randomUUID(),
    email: norm,
    name: displayName,
    role: 'user',
    status: 'active',
    plan: 'free',
    planExpires: null,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
    favorites: [],
  };
  // Re-check after the async hash: a concurrent request with the same email could
  // have passed the first check while we were hashing (TOCTOU on the JSON store).
  if (users.some((u) => u.email === norm)) return res.status(409).json({ error: 'email already registered' });
  users.push(user);
  await save();
  res.json({ token: sign(user), user: sanitize(user) });
}));

authRouter.post('/login', authLimit, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  // Wrong types or absurd sizes can never match an account: same answer as a bad password.
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > EMAIL_MAX || password.length > PW_MAX) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const norm = email.toLowerCase().trim();
  const user = users.find((u) => u.email === norm);
  // Always run a comparison (dummy hash for unknown emails) to avoid timing enumeration.
  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'account disabled' });
  res.json({ token: sign(user), user: sanitize(user) });
}));

// Called by the app at every start (web, TV). `token` is present only when the
// session was just renewed; the client then replaces its stored token.
authRouter.get('/me', authenticate, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  res.json({ user: sanitize(req.user), ...(req.renewedToken ? { token: req.renewedToken } : {}) });
});

// GDPR access + portability: everything stored about this account, machine-readable,
// as a download. Never the password hash nor the session generation.
authRouter.get('/me/export', authenticate, requireUser, (req, res) => {
  const u = req.user;
  const out = {
    exportedAt: new Date().toISOString(),
    service: 'NEOWATCH',
    account: { ...sanitize(u), lastStripeEventAt: u.stripeEventAt || null },
    prefs: u.prefs || null,
    billing: {
      stripeCustomerId: u.stripeCustomerId || null,
      stripeSubscriptionId: u.stripeSubscriptionId || null,
    },
  };
  res.setHeader('Content-Disposition', 'attachment; filename="neowatch-my-data.json"');
  res.json(out);
});

// ── Device pairing: log a TV in by scanning a QR with an already-signed-in phone ──
// Standard device-authorization flow. The TV holds a secret deviceCode and shows a
// short userCode (as a QR + text). The phone approves the userCode, binding it to its
// account; the TV polls with its deviceCode and receives a token. The token only ever
// goes to whoever holds the secret deviceCode (the TV), so a guessed userCode can't
// steal a session -- it can at most attach the approver's own account to that TV.
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX = 5000;  // live pairings, all clients
const PAIR_PER_IP = 5;  // live pairings per client IP (a TV needs one)
const pairings = new Map();          // deviceCode -> { userCode, status, userId, tv, expiresAt, ip }
const pairingByUserCode = new Map(); // userCode   -> deviceCode
// Called by revokeTokens(): an approved-but-unpolled pairing is a token in reserve.
function dropPairingsOf(userId) {
  for (const [dc, p] of pairings) if (p.userId === userId) { pairings.delete(dc); pairingByUserCode.delete(p.userCode); }
}
const deviceStartLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'device-start' });
const deviceInfoLimit = rateLimit({ windowMs: 60_000, max: 30, name: 'device-info' });
const devicePollLimit = rateLimit({ windowMs: 60_000, max: 150, name: 'device-poll' });
const USERCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity
function genUserCode() {
  const b = randomBytes(6);
  let c = '';
  for (let i = 0; i < 6; i++) c += USERCODE_ALPHABET[b[i] % USERCODE_ALPHABET.length];
  return c;
}
function sweepPairings() {
  const now = Date.now();
  for (const [dc, p] of pairings) if (p.expiresAt < now) { pairings.delete(dc); pairingByUserCode.delete(p.userCode); }
}
function dropPairing(dc) {
  const p = pairings.get(dc);
  if (p) { pairings.delete(dc); pairingByUserCode.delete(p.userCode); }
}

// TV: request a pairing. Returns the secret deviceCode + the short userCode to display.
// Room is made by evicting instead of refusing: one client holds at most PAIR_PER_IP live
// pairings (its own oldest goes first), and at the global cap the oldest pending pairing
// goes. A handful of clients can no longer fill the pool and lock TV sign-in for everyone.
authRouter.post('/device/start', deviceStartLimit, (req, res) => {
  sweepPairings();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const mine = [];
  for (const [dc, p] of pairings) if (p.ip === ip && p.status === 'pending') mine.push(dc); // Map order = oldest first
  while (mine.length >= PAIR_PER_IP) dropPairing(mine.shift());
  if (pairings.size >= PAIR_MAX) {
    for (const [dc, p] of pairings) if (p.status === 'pending') { dropPairing(dc); break; }
    if (pairings.size >= PAIR_MAX) return res.status(503).json({ error: 'busy, try again' });
  }
  let userCode = genUserCode();
  while (pairingByUserCode.has(userCode)) userCode = genUserCode();
  const deviceCode = randomBytes(24).toString('base64url');
  pairings.set(deviceCode, { userCode, status: 'pending', userId: null, expiresAt: Date.now() + PAIR_TTL_MS, ip });
  pairingByUserCode.set(userCode, deviceCode);
  res.json({ deviceCode, userCode, expiresIn: Math.floor(PAIR_TTL_MS / 1000) });
});

// TV: poll until the phone approves, then receive a token (one-time).
authRouter.post('/device/poll', devicePollLimit, (req, res) => {
  const rec = pairings.get(String(req.body?.deviceCode || ''));
  if (!rec || rec.expiresAt < Date.now()) {
    if (rec) { pairings.delete(req.body.deviceCode); pairingByUserCode.delete(rec.userCode); }
    return res.json({ status: 'expired' });
  }
  if (rec.status !== 'approved') return res.json({ status: 'pending' });
  // Approved: consume the pairing and hand the TV a fresh token -- unless the approver's
  // session was revoked since (tokenVersion moved): the approval was made with a token
  // that is dead now, so it must not be convertible into a live one.
  pairings.delete(req.body.deviceCode);
  pairingByUserCode.delete(rec.userCode);
  const user = users.find((u) => u.id === rec.userId);
  if (!user || user.status !== 'active' || (user.tokenVersion || 0) !== rec.tv) return res.json({ status: 'expired' });
  res.json({ status: 'approved', token: sign(user), user: sanitize(user) });
});

// Phone: is this code valid + waiting? (for the confirm UI)
authRouter.get('/device/info', deviceInfoLimit, (req, res) => {
  sweepPairings();
  const dc = pairingByUserCode.get(String(req.query.code || '').toUpperCase().trim());
  const rec = dc ? pairings.get(dc) : null;
  res.json({ valid: !!rec && rec.status === 'pending' });
});

// Phone (signed in): approve a code -> bind the pairing to this account.
authRouter.post('/device/approve', authLimit, authenticate, requireUser, (req, res) => {
  const dc = pairingByUserCode.get(String(req.body?.code || '').toUpperCase().trim());
  const rec = dc ? pairings.get(dc) : null;
  if (!rec || rec.expiresAt < Date.now()) return res.status(404).json({ error: 'code invalid or expired' });
  if (rec.status === 'approved') return res.status(409).json({ error: 'code already used' });
  rec.status = 'approved';
  rec.userId = req.user.id;
  rec.tv = req.user.tokenVersion || 0; // the session generation this approval belongs to
  res.json({ ok: true });
});

// Roaming payload shapes. Favorites key on the stream url (stable across catalog
// rebuilds), so they are plain url strings. A mosaic tile keeps only the stable fields of
// a channel: never proxyUrl (a signed URL that expires in 2h) nor volatile health data.
const URL_MAX = 2048;
const isUrl = (v) => typeof v === 'string' && v.length > 0 && v.length <= URL_MAX && /^https?:\/\//i.test(v);
const optStr = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const strList = (v, n, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, max)) : []);
function cleanTile(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || !isUrl(c.url)) return null;
  const tile = {
    id: optStr(c.id, 40) || '',
    channelId: optStr(c.channelId, 120),
    name: optStr(c.name, 200) || 'Channel',
    url: c.url,
    kind: ['hls', 'youtube', 'dash', 'other'].includes(c.kind) ? c.kind : 'other',
    quality: optStr(c.quality, 16),
    label: optStr(c.label, 60),
    userAgent: optStr(c.userAgent, 300),
    referrer: optStr(c.referrer, URL_MAX),
    categories: strList(c.categories, 12, 40),
    categoryNames: strList(c.categoryNames, 12, 60),
    country: optStr(c.country, 8),
    countryName: optStr(c.countryName, 80),
    flag: optStr(c.flag, 16),
    languages: strList(c.languages, 12, 8),
    languageNames: strList(c.languageNames, 12, 60),
    website: isUrl(c.website) ? c.website : null,
    nsfw: !!c.nsfw,
  };
  if (isUrl(c.logo)) tile.logo = c.logo;
  if (c.tier === 'free' || c.tier === 'premium') tile.tier = c.tier;
  if (c.source === 'iptv-org' || c.source === 'custom') tile.source = c.source;
  if (Array.isArray(c.alternates)) {
    tile.alternates = c.alternates
      .filter((a) => a && isUrl(a.url))
      .slice(0, 8)
      .map((a) => ({ url: a.url, proxyUrl: null, userAgent: optStr(a.userAgent, 300), referrer: optStr(a.referrer, URL_MAX) }));
  }
  return tile;
}

// Persist a user's favorites server-side (so they roam across devices).
authRouter.put('/favorites', syncLimit, authenticate, requireUser, wrap(async (req, res) => {
  const { favorites } = req.body || {};
  if (!Array.isArray(favorites)) return res.status(400).json({ error: 'favorites must be an array' });
  req.user.favorites = [...new Set(favorites.filter(isUrl))].slice(0, 1000);
  await save();
  res.json({ favorites: req.user.favorites });
}));

// Persist the multi-screen mosaic config server-side, so it roams across devices
// (configure on a computer, pick it up on the TV). Stores sanitized tiles, capped.
authRouter.put('/multi', syncLimit, authenticate, requireUser, wrap(async (req, res) => {
  const { multi } = req.body || {};
  if (!Array.isArray(multi)) return res.status(400).json({ error: 'multi must be an array' });
  req.user.multi = multi.slice(0, 9).map(cleanTile).filter(Boolean);
  await save();
  res.json({ multi: req.user.multi });
}));

// Self-service password change.
authRouter.put('/password', authLimit, authenticate, requireUser, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!validPassword(newPassword)) return res.status(400).json({ error: `new ${PW_ERROR}` });
  if (typeof currentPassword !== 'string') return res.status(401).json({ error: 'current password is incorrect' });
  const verifiedAgainst = req.user.passwordHash;
  if (!(await bcrypt.compare(currentPassword, verifiedAgainst))) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  const newHash = await bcrypt.hash(newPassword, 10);
  // Two devices changing the password at the same instant (or an admin reset landing while
  // we hashed): the password we verified is no longer the stored one, so this change loses.
  // Without this, both callers get a 200 and one device believes a password that is not set.
  if (req.user.passwordHash !== verifiedAgainst) {
    return res.status(409).json({ error: 'password changed concurrently, sign in again' });
  }
  req.user.passwordHash = newHash;
  // A password change signs every other device out; this device gets a fresh token.
  revokeTokens(req.user);
  // Sign right after OUR bump (before the async save): a later bump by someone else (admin
  // reset racing with us) must leave this token dead, not hand us a token of its generation.
  // It also replaces the due-for-renewal token authenticate may already have put in the
  // header (signed before the bump, hence revoked).
  const fresh = sign(req.user);
  await save();
  handToken(req, res, fresh);
  res.json({ ok: true, token: fresh });
}));

// GDPR: self-service account deletion (password-confirmed). Removes the account
// and everything attached to it (favorites, multi config, plan). The last admin
// cannot self-delete (would lock the instance).
authRouter.delete('/me', authLimit, authenticate, requireUser, wrap(async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length > PW_MAX || !(await bcrypt.compare(password, req.user.passwordHash))) {
    return res.status(401).json({ error: 'password is incorrect' });
  }
  if (req.user.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: 'cannot delete the last admin account' });
  }
  try {
    await runDeleteHooks(req.user);
  } catch {
    return res.status(502).json({ error: 'could not cancel the subscription, try again' });
  }
  const gone = req.user;
  users = users.filter((u) => u.id !== gone.id);
  dropPairingsOf(gone.id);
  await save();
  res.json({ ok: true });
}));

// ── Admin user management ──────────────────────────────────────
export const adminRouter = Router();

adminRouter.get('/users', (_req, res) => {
  res.json({ users: users.map(sanitize) });
});

adminRouter.post('/users', wrap(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  const norm = cleanEmail(email);
  if (!norm || !validPassword(password)) {
    return res.status(400).json({ error: `a valid email and a ${PW_MIN} to ${PW_MAX} character password are required` });
  }
  const displayName = cleanName(name, norm.split('@')[0]);
  if (displayName === null) return res.status(400).json({ error: 'name must be text' });
  if (users.some((u) => u.email === norm)) return res.status(409).json({ error: 'email already exists' });
  const user = {
    id: randomUUID(),
    email: norm,
    name: displayName,
    role: role === 'admin' ? 'admin' : 'user',
    status: 'active',
    plan: role === 'admin' ? 'premium' : 'free',
    planExpires: null,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
    favorites: [],
  };
  users.push(user);
  await save();
  res.json({ user: sanitize(user) });
}));

adminRouter.patch('/users/:id', wrap(async (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { role, status, name } = req.body || {};
  // '' / absent = no reset; anything else must be a valid password (no silent ignore).
  const password = req.body?.password === '' || req.body?.password == null ? null : req.body.password;
  if (password !== null && !validPassword(password)) return res.status(400).json({ error: PW_ERROR });
  if (name !== undefined && name !== null && typeof name !== 'string') return res.status(400).json({ error: 'name must be text' });

  // Never let the last active admin be demoted or disabled (lock-out guard).
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.status === 'active');
  const wouldDropAdmin =
    (role === 'user' && user.role === 'admin') || (status === 'disabled' && user.role === 'admin');
  if (wouldDropAdmin && activeAdmins.length <= 1) {
    return res.status(400).json({ error: 'cannot remove the last admin' });
  }

  if (role && ['user', 'admin'].includes(role)) user.role = role;
  if (status && ['active', 'disabled'].includes(status)) user.status = status;
  if (name && name.trim()) user.name = name.trim().slice(0, NAME_MAX);
  if (password) user.passwordHash = await bcrypt.hash(password, 10);
  // Disabling or resetting the password also kills the sessions already issued
  // (re-enabling later requires a fresh login).
  if (status === 'disabled' || password) {
    revokeTokens(user);
    // An admin resetting their OWN password from the admin panel keeps this device signed
    // in (same contract as PUT /auth/password). Disabling yourself does sign you out.
    if (req.user?.id === user.id && user.status === 'active') handToken(req, res, sign(user));
  }
  await save();
  res.json({ user: sanitize(user) });
}));

adminRouter.delete('/users/:id', wrap(async (req, res) => {
  if (req.user?.id === req.params.id) return res.status(400).json({ error: 'cannot delete yourself' });
  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'not found' });
  try {
    await runDeleteHooks(target);
  } catch {
    return res.status(502).json({ error: 'could not cancel the subscription, try again' });
  }
  users = users.filter((u) => u.id !== target.id);
  dropPairingsOf(target.id);
  await save();
  res.json({ ok: true });
}));

export function getStats() {
  return {
    users: users.length,
    admins: users.filter((u) => u.role === 'admin').length,
    active: users.filter((u) => u.status === 'active').length,
  };
}
