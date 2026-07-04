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

function sign(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtTtl });
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

// Express middleware: attaches req.user when a valid token is present.
export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = users.find((u) => u.id === payload.sub);
      if (user && user.status === 'active') req.user = user;
    } catch {
      /* invalid/expired token: treat as anonymous */
    }
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
  if (!token || typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = users.find((u) => u.id === payload.sub);
    return user && user.status === 'active' ? user : null;
  } catch {
    return null;
  }
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
// Read prefs: any logged-in user (free sees their stored prefs or empty).
prefsRouter.get('/me/prefs', requireUser, (req, res) => res.json({ prefs: req.user.prefs || null }));
// Write prefs: premium feature.
prefsRouter.put('/me/prefs', requirePremium, async (req, res) => {
  req.user.prefs = sanitizePrefs(req.body?.prefs || {});
  await save();
  res.json({ prefs: req.user.prefs });
});

export const authRouter = Router();

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

authRouter.get('/me', authenticate, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  res.json({ user: sanitize(req.user) });
});

// ── Device pairing: log a TV in by scanning a QR with an already-signed-in phone ──
// Standard device-authorization flow. The TV holds a secret deviceCode and shows a
// short userCode (as a QR + text). The phone approves the userCode, binding it to its
// account; the TV polls with its deviceCode and receives a token. The token only ever
// goes to whoever holds the secret deviceCode (the TV), so a guessed userCode can't
// steal a session -- it can at most attach the approver's own account to that TV.
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairings = new Map();          // deviceCode -> { userCode, status, userId, expiresAt }
const pairingByUserCode = new Map(); // userCode   -> deviceCode
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
  // Approved: consume the pairing and hand the TV a fresh token.
  pairings.delete(req.body.deviceCode);
  pairingByUserCode.delete(rec.userCode);
  const user = users.find((u) => u.id === rec.userId);
  if (!user || user.status !== 'active') return res.json({ status: 'expired' });
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
  if (!(await bcrypt.compare(String(currentPassword || ''), req.user.passwordHash))) {
    return res.status(401).json({ error: 'current password is incorrect' });
  }
  req.user.passwordHash = await bcrypt.hash(newPassword, 10);
  await save();
  res.json({ ok: true });
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
