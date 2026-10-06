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
// so a crash mid-write can never truncate users.json.
let writeChain = Promise.resolve();
function save() {
  writeChain = writeChain.then(async () => {
    await mkdir(config.dataDir, { recursive: true }).catch(() => {});
    const tmp = `${USERS_FILE}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(users, null, 2));
    await rename(tmp, USERS_FILE);
  });
  return writeChain;
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

// Set a user's plan. For premium, expiry = explicit expiresAt (ms, e.g. Stripe
// current_period_end) if given, else now + days, else null (lifetime).
export async function setPlan(user, plan, days, expiresAt) {
  user.plan = plan === 'premium' ? 'premium' : 'free';
  if (user.plan === 'premium') {
    user.planExpires = expiresAt || (days ? Date.now() + days * 86400000 : null);
  } else {
    user.planExpires = null;
  }
  await save();
  return sanitize(user);
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

export const prefsRouter = Router();
prefsRouter.use(privateNoStore);
// Read prefs: any logged-in user (free sees their stored prefs or empty).
prefsRouter.get('/me/prefs', requireUser, (req, res) => res.json({ prefs: req.user.prefs || null }));
// Write prefs: premium feature.
prefsRouter.put('/me/prefs', requirePremium, async (req, res) => {
  req.user.prefs = sanitizePrefs(req.body?.prefs || {});
  await save();
  res.json({ prefs: req.user.prefs });
});

export const authRouter = Router();
// Everything under /api/auth is about one account (and login/register/device-poll carry a
// token in the body): never cacheable.
authRouter.use(privateNoStore);

authRouter.post('/register', authLimit, async (req, res) => {
  if (!config.allowRegister) return res.status(403).json({ error: 'registration disabled' });
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'email and password (min 6 chars) required' });
  }
  const norm = String(email).toLowerCase().trim();
  if (users.some((u) => u.email === norm)) return res.status(409).json({ error: 'email already registered' });

  const user = {
    id: randomUUID(),
    email: norm,
    name: name || norm.split('@')[0],
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
});

authRouter.post('/login', authLimit, async (req, res) => {
  const { email, password } = req.body || {};
  const norm = String(email || '').toLowerCase().trim();
  const user = users.find((u) => u.email === norm);
  // Always run a comparison (dummy hash for unknown emails) to avoid timing enumeration.
  const ok = await bcrypt.compare(String(password || ''), user?.passwordHash || DUMMY_HASH);
  if (!user || !ok) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'account disabled' });
  res.json({ token: sign(user), user: sanitize(user) });
});

// Called by the app at every start (web, TV). `token` is present only when the
// session was just renewed; the client then replaces its stored token.
authRouter.get('/me', authenticate, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  res.json({ user: sanitize(req.user), ...(req.renewedToken ? { token: req.renewedToken } : {}) });
});

// ── Device pairing: log a TV in by scanning a QR with an already-signed-in phone ──
// Standard device-authorization flow. The TV holds a secret deviceCode and shows a
// short userCode (as a QR + text). The phone approves the userCode, binding it to its
// account; the TV polls with its deviceCode and receives a token. The token only ever
// goes to whoever holds the secret deviceCode (the TV), so a guessed userCode can't
// steal a session -- it can at most attach the approver's own account to that TV.
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairings = new Map();          // deviceCode -> { userCode, status, userId, tv, expiresAt }
const pairingByUserCode = new Map(); // userCode   -> deviceCode
// Called by revokeTokens(): an approved-but-unpolled pairing is a token in reserve.
function dropPairingsOf(userId) {
  for (const [dc, p] of pairings) if (p.userId === userId) { pairings.delete(dc); pairingByUserCode.delete(p.userCode); }
}
const deviceStartLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'device-start' });
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

// TV: request a pairing. Returns the secret deviceCode + the short userCode to display.
authRouter.post('/device/start', deviceStartLimit, (_req, res) => {
  sweepPairings();
  if (pairings.size > 5000) return res.status(503).json({ error: 'busy, try again' });
  let userCode = genUserCode();
  while (pairingByUserCode.has(userCode)) userCode = genUserCode();
  const deviceCode = randomBytes(24).toString('base64url');
  pairings.set(deviceCode, { userCode, status: 'pending', userId: null, expiresAt: Date.now() + PAIR_TTL_MS });
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
authRouter.get('/device/info', (req, res) => {
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

// Persist a user's favorites server-side (so they roam across devices).
authRouter.put('/favorites', authenticate, requireUser, async (req, res) => {
  const { favorites } = req.body || {};
  if (!Array.isArray(favorites)) return res.status(400).json({ error: 'favorites must be an array' });
  req.user.favorites = favorites.slice(0, 1000);
  await save();
  res.json({ favorites: req.user.favorites });
});

// Persist the multi-screen mosaic config server-side, so it roams across devices
// (configure on a computer, pick it up on the TV). Stores the channel objects, capped.
authRouter.put('/multi', authenticate, requireUser, async (req, res) => {
  const { multi } = req.body || {};
  if (!Array.isArray(multi)) return res.status(400).json({ error: 'multi must be an array' });
  req.user.multi = multi
    .filter((c) => c && typeof c === 'object' && typeof c.url === 'string')
    .slice(0, 9);
  await save();
  res.json({ multi: req.user.multi });
});

// Self-service password change.
authRouter.put('/password', authLimit, authenticate, requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'new password too short (min 6)' });
  const verifiedAgainst = req.user.passwordHash;
  if (!(await bcrypt.compare(String(currentPassword || ''), verifiedAgainst))) {
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
});

// GDPR: self-service account deletion (password-confirmed). Removes the account
// and everything attached to it (favorites, multi config, plan). The last admin
// cannot self-delete (would lock the instance).
authRouter.delete('/me', authLimit, authenticate, requireUser, async (req, res) => {
  const { password } = req.body || {};
  if (!(await bcrypt.compare(String(password || ''), req.user.passwordHash))) {
    return res.status(401).json({ error: 'password is incorrect' });
  }
  if (req.user.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: 'cannot delete the last admin account' });
  }
  users = users.filter((u) => u.id !== req.user.id);
  await save();
  res.json({ ok: true });
});

// ── Admin user management ──────────────────────────────────────
export const adminRouter = Router();

adminRouter.get('/users', (_req, res) => {
  res.json({ users: users.map(sanitize) });
});

adminRouter.post('/users', async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'email and password (min 6 chars) required' });
  }
  const norm = String(email).toLowerCase().trim();
  if (users.some((u) => u.email === norm)) return res.status(409).json({ error: 'email already exists' });
  const user = {
    id: randomUUID(),
    email: norm,
    name: name || norm.split('@')[0],
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
});

adminRouter.patch('/users/:id', async (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { role, status, name, password } = req.body || {};

  // Never let the last active admin be demoted or disabled (lock-out guard).
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.status === 'active');
  const wouldDropAdmin =
    (role === 'user' && user.role === 'admin') || (status === 'disabled' && user.role === 'admin');
  if (wouldDropAdmin && activeAdmins.length <= 1) {
    return res.status(400).json({ error: 'cannot remove the last admin' });
  }

  if (role && ['user', 'admin'].includes(role)) user.role = role;
  if (status && ['active', 'disabled'].includes(status)) user.status = status;
  if (name) user.name = name;
  if (password && password.length >= 6) user.passwordHash = await bcrypt.hash(password, 10);
  // Disabling or resetting the password also kills the sessions already issued
  // (re-enabling later requires a fresh login).
  if (status === 'disabled' || (password && password.length >= 6)) {
    revokeTokens(user);
    // An admin resetting their OWN password from the admin panel keeps this device signed
    // in (same contract as PUT /auth/password). Disabling yourself does sign you out.
    if (req.user?.id === user.id && user.status === 'active') handToken(req, res, sign(user));
  }
  await save();
  res.json({ user: sanitize(user) });
});

adminRouter.delete('/users/:id', async (req, res) => {
  if (req.user?.id === req.params.id) return res.status(400).json({ error: 'cannot delete yourself' });
  const before = users.length;
  users = users.filter((u) => u.id !== req.params.id);
  if (users.length === before) return res.status(404).json({ error: 'not found' });
  await save();
  res.json({ ok: true });
});

export function getStats() {
  return {
    users: users.length,
    admins: users.filter((u) => u.role === 'admin').length,
    active: users.filter((u) => u.status === 'active').length,
  };
}
