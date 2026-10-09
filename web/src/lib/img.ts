// Third-party logos (channel logos, radio favicons) go through the server's image
// relay (/api/img): same origin, so a host that refuses embedding (CORP / ORB) or
// serves plain http still shows, and every viewer shares one cached copy.
// Same-origin paths and inline images are returned unchanged. SVG goes through the
// relay too, which refuses it (it can carry script; ~1 % of channel logos, ~4 % of
// radio favicons): the card shows its monogram, without a console error (an <img>
// gets a 204). Loading an SVG directly would fail loudly on CORP-protected hosts.
export function imgSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (/^(data:|blob:)/i.test(url)) return url;
  let u: URL;
  try {
    u = new URL(url, window.location.href);
  } catch {
    return undefined;
  }
  if (u.origin === window.location.origin) return url;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  return `/api/img?u=${encodeURIComponent(url)}`;
}
