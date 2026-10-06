// Thin fetch wrapper that injects the auth token and normalizes errors.

const TOKEN_KEY = 'neowatch.token';
// Some TV/embedded browsers and strict-privacy contexts THROW on any localStorage
// access. This module is imported at boot, so an unguarded read would white-screen
// the whole app -- guard every access and degrade to an in-memory token.
let token: string | null = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }

// Reflect login/logout that happened in another tab.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY) token = e.newValue;
  });
}

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage blocked -- token still held in memory for this session */ }
}

export function getToken() {
  return token;
}

// Unverified read of the JWT payload (the server is the only verifier; this is just to
// compare a handed token with the one we hold).
function claims(t: string): { sub?: string; iat?: number; tv?: number } | null {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}
// A handed token is adopted only for the SAME account, for a session generation (`tv`,
// bumped by a password change) that is not older than ours, and only if it is not older
// (`iat`) than the one held. The server marks renewing responses no-store, but should any
// cache (browser, proxy) ever replay a stored X-Renewed-Token, or a renewal signed just
// before a password change arrive after it (same second, so same iat), it can never
// switch this device to another account nor roll it back to a revoked token.
function acceptable(next: string, cur: string) {
  const n = claims(next), c = claims(cur);
  return !!n && !!c && !!n.sub && n.sub === c.sub && (n.tv ?? 0) >= (c.tv ?? 0) && (n.iat ?? 0) >= (c.iat ?? 0);
}

// Adopt a token the server handed to us (X-Renewed-Token header, `token` in a body).
// Returns true when it was taken. Besides the claims guard, localStorage is re-read right
// before writing: a page restored from the back/forward cache (Safari) still holds the
// token it was frozen with in memory while another tab may have signed out or signed in
// as someone else since, without this page receiving the `storage` event. A token is
// adopted only when storage still holds exactly the token this module believes it holds.
export function adoptToken(next: string | null | undefined): boolean {
  if (!next || !token || next === token || !acceptable(next, token)) return false;
  let stored: string | null = token;
  try { stored = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked: memory is the truth */ }
  if (stored !== token) { token = stored; return false; } // the session moved under us: follow it
  setToken(next);
  return true;
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (opts.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`/api${path}`, { ...opts, headers });
  // Sliding session: the server hands back a fresh token once the current one is past
  // its renewal threshold. Swap it in (and to the other tabs via localStorage) -- but
  // never resurrect a session that was signed out while this request was in flight.
  adoptToken(res.headers.get('X-Renewed-Token'));
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && (data as any).error) || res.statusText;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string, body?: unknown) => request<T>(p, { method: 'DELETE', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
};
