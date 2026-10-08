// Device detection for the 10-foot (TV) layout.
//
// `isTV()` is true when one of these holds:
//   - `?tv=1` in the URL (persisted to localStorage `nw.tv`, which the Android
//     WebView shell also sets); `?tv=0` clears it again;
//   - the user agent is a known TV / set-top platform;
//   - the device has no hover and no pointer at all (remote-only WebViews).
//
// `applyDeviceFlags()` writes `data-tv` on <html> so the `:root[data-tv]`
// token block (index.css) applies. main.tsx calls it before the first render.

const TV_UA = /Android TV|AFT|BRAVIA|SMART-TV|SmartTV|Tizen|Web0S|webOS|HbbTV|GoogleTV|Leanback|\bTV\b.*wv/i;
const TV_KEY = 'nw.tv';

let cached: boolean | null = null;

function readFlag(): boolean | null {
  try {
    const q = new URLSearchParams(window.location.search).get('tv');
    if (q === '1') {
      localStorage.setItem(TV_KEY, '1');
      return true;
    }
    if (q === '0') {
      localStorage.removeItem(TV_KEY);
      return false;
    }
    return localStorage.getItem(TV_KEY) === '1' ? true : null;
  } catch {
    return null; // private mode / blocked storage: fall back to the UA checks
  }
}

export function detectTV(): boolean {
  if (typeof window === 'undefined') return false;
  const flag = readFlag();
  if (flag !== null) return flag;
  if (TV_UA.test(navigator.userAgent || '')) return true;
  try {
    return window.matchMedia('(hover: none) and (pointer: none)').matches;
  } catch {
    return false;
  }
}

/** True on a TV / remote-only device. Computed once per page load. */
export function isTV(): boolean {
  if (cached === null) cached = detectTV();
  return cached;
}

/** True when the OS asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Set `data-tv` on <html> (before the first render). */
export function applyDeviceFlags() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (isTV()) root.dataset.tv = '';
  else delete root.dataset.tv;
}
