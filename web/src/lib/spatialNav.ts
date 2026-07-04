// Global D-pad / arrow-key spatial navigation for TV remotes (Android TV,
// Google TV, Fire TV) and keyboard users. Arrow keys move focus to the nearest
// focusable element in that direction; Enter/OK activates natively.
//
// Components that already handle arrows locally (rails, grid) call
// preventDefault(); we skip those events (e.defaultPrevented) to avoid double moves.

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[role="button"]:not([aria-disabled="true"]),[tabindex]:not([tabindex="-1"])';

function visibleFocusables(): HTMLElement[] {
  const out: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(FOCUSABLE).forEach((el) => {
    if (el.offsetParent === null && el.getClientRects().length === 0) return; // hidden
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    out.push(el);
  });
  return out;
}

type Dir = 'up' | 'down' | 'left' | 'right';

// Nearest vertically-scrollable ancestor (the home/grid live inside <main overflow-y-auto>).
function scrollableY(el: HTMLElement | null): HTMLElement {
  let n: HTMLElement | null = el;
  while (n && n !== document.body) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    n = n.parentElement;
  }
  return (document.scrollingElement as HTMLElement) || document.documentElement;
}

function move(dir: Dir, allowScroll = true) {
  const els = visibleFocusables();
  if (!els.length) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || cur === document.body || !els.includes(cur)) {
    els[0].focus();
    els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const r = cur.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of els) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = bx - cx;
    const dy = by - cy;
    let primary: number;
    let perp: number;
    if (dir === 'right') { if (dx <= 6) continue; primary = dx; perp = Math.abs(dy); }
    else if (dir === 'left') { if (dx >= -6) continue; primary = -dx; perp = Math.abs(dy); }
    else if (dir === 'down') { if (dy <= 6) continue; primary = dy; perp = Math.abs(dx); }
    else { if (dy >= -6) continue; primary = -dy; perp = Math.abs(dx); }
    // Prefer aligned (low perpendicular) + close (low primary). Heavy perp penalty.
    const score = primary + perp * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return;
  }
  // No focusable target in this direction. On a TV remote (no wheel/touch) this would
  // strand the user -- e.g. the next home rail is lazy-mounted and not rendered yet.
  // Scroll the page so that lazy content mounts, then retry focus once it has.
  if (allowScroll && (dir === 'down' || dir === 'up')) {
    const sc = scrollableY(cur);
    const max = sc.scrollHeight - sc.clientHeight;
    const atEdge = dir === 'down' ? sc.scrollTop >= max - 2 : sc.scrollTop <= 2;
    if (atEdge) return; // already at the end -- nothing more to reveal
    sc.scrollBy({ top: (dir === 'down' ? 1 : -1) * sc.clientHeight * 0.6, behavior: 'smooth' });
    setTimeout(() => move(dir, false), 280); // after the lazy rail mounts, focus it
  }
}

const DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

let inited = false;
export function initSpatialNav() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const dir = DIRS[e.key];
      if (!dir) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // In a text field, let Left/Right move the caret; Up/Down still navigate.
      if (typing && (dir === 'left' || dir === 'right')) return;
      e.preventDefault();
      move(dir);
    },
    // capture: false so component-level handlers (rails/grid) run first and can preventDefault.
    false
  );
}
