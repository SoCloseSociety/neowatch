// Tiny in-memory fixed-window rate limiter (no external dependency).
// Used to cap abuse on auth (brute force) and the proxy/health endpoints,
// with limits generous enough never to throttle legitimate playback.

export function rateLimit({ windowMs, max, name = 'rl' }) {
  const hits = new Map(); // ip -> { count, reset }

  // Opportunistic cleanup so the map cannot grow unbounded.
  function sweep(now) {
    if (hits.size < 5000) return;
    for (const [ip, e] of hits) if (e.reset < now) hits.delete(ip);
  }

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let e = hits.get(ip);
    if (!e || e.reset < now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(ip, e);
    }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: `rate limit exceeded (${name})` });
    }
    sweep(now);
    next();
  };
}
