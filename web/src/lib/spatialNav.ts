// TV / remote navigation (spec 4.3): D-pad spatial focus, overlay layers with
// history entries, focus trap + restore, and ONE Back contract for every
// platform.
//
//   - Arrow keys move focus to the nearest focusable element in that direction,
//     inside the top open layer only (a modal or the player traps the D-pad).
//     Components that handle arrows themselves (rails, grid) preventDefault().
//   - A layer = an overlay that Back closes: the player, the mosaic, the avatar
//     menu and every modal of uiStore. Opening one pushes a history entry, so a
//     browser Back, a WebView goBack() (Android shell) or a TV Back key closes it
//     instead of leaving the page. Focus is taken on open ([data-autofocus] first),
//     trapped (Tab and D-pad), and restored on close: to [data-key=<url>] of the
//     card that launched the player, else to the element focused before.
//   - window.__nwBack() runs the Back action and returns true when it handled it
//     (closed a layer, went back a page, cleared a search, or showed "Press Back
//     again to exit"); false means "nothing left here", so the shell may exit.
//     Keys: Escape, Backspace (outside a field), GoBack, BrowserBack, keyCode 4,
//     461 (webOS), 10009 (Tizen). On a computer, Escape only closes layers.

import { useUI } from '@/store/uiStore';
import { usePlayer } from '@/store/playerStore';
import { useCatalog } from '@/store/catalogStore';
import { isTV } from './device';
import { t } from './i18n';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[role="button"]:not([aria-disabled="true"]),[role="menuitem"],[role="menuitemradio"],[tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && el.getClientRects().length === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function focusables(scope: ParentNode = document): HTMLElement[] {
  const out: HTMLElement[] = [];
  scope.querySelectorAll<HTMLElement>(FOCUSABLE).forEach((el) => {
    if (el.closest('[aria-hidden="true"], [inert]')) return;
    if (isVisible(el)) out.push(el);
  });
  return out;
}

const isField = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);

// ── layers ───────────────────────────────────────────────────────────────
interface Layer {
  id: number;
  name: string;
  close: () => void;
  /** Container (resolved lazily: lazy chunks mount late). */
  el: () => HTMLElement | null;
  /** Data-key (stream url) to restore focus to on close. */
  restoreKey?: () => string | null | undefined;
  /** The component closes itself on Escape (useEscapeClose): Escape is left to it. */
  escapeOwned?: boolean;
  prevFocus: Element | null;
  /** Its history entry is already gone (popped by Back, or replaced by a navigation). */
  consumed: boolean;
}

const layers: Layer[] = [];
let layerSeq = 0;
let ignorePops = 0;

function topLayer(): Layer | null {
  return layers.length ? layers[layers.length - 1] : null;
}

/** Container of the top layer, or null (the page). */
function trapRoot(): HTMLElement | null {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const el = layers[i].el();
    if (el && el.isConnected) return el;
  }
  return null;
}

function historyState(): Record<string, unknown> {
  const s = window.history.state;
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
}

function takeFocus(layer: Layer, tries = 0) {
  if (!layers.includes(layer)) return;
  const el = layer.el();
  if (!el || !el.isConnected) {
    // Player / mosaic are lazy chunks: wait for them (up to ~4 s).
    if (tries < 40) setTimeout(() => takeFocus(layer, tries + 1), 100);
    return;
  }
  if (el.contains(document.activeElement)) return;
  const auto = el.querySelector<HTMLElement>('[data-autofocus]');
  const target = (auto && isVisible(auto) ? auto : null) || focusables(el)[0];
  if (target) target.focus({ preventScroll: true });
  else if (tries < 40) setTimeout(() => takeFocus(layer, tries + 1), 100);
}

function cssEscape(s: string) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

/** Focus the element carrying data-key=<key> (itself focusable, else its first focusable child). */
export function focusKey(key: string | null | undefined): boolean {
  if (!key) return false;
  const all = [...document.querySelectorAll<HTMLElement>(`[data-key="${cssEscape(key)}"]`)].filter(isVisible);
  if (!all.length) return false;
  const own = all.find((el) => el.matches(FOCUSABLE));
  const target = own || all.map((el) => el.querySelector<HTMLElement>(FOCUSABLE)).find(Boolean) || null;
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

function restoreFocus(layer: Layer, tries = 0) {
  // Another layer is still open: give it the focus instead.
  const top = topLayer();
  if (top) {
    takeFocus(top);
    return;
  }
  const key = layer.restoreKey?.();
  if (focusKey(key)) return;
  const prev = layer.prevFocus as HTMLElement | null;
  if (prev && prev.isConnected && isVisible(prev) && prev !== document.body) {
    prev.focus({ preventScroll: true });
    return;
  }
  // The card may be re-rendering (lazy rail): retry a few frames.
  if (key && tries < 10) setTimeout(() => restoreFocus(layer, tries + 1), 60);
}

/**
 * Open a layer: pushes a history entry, takes focus, traps it. Returns `release`,
 * to call when the overlay closes (by any path); it pops the entry (unless Back
 * already did) and restores focus.
 */
export function openLayer(opts: {
  name: string;
  close: () => void;
  el: () => HTMLElement | null;
  restoreKey?: () => string | null | undefined;
  escapeOwned?: boolean;
}): () => void {
  const layer: Layer = { id: ++layerSeq, consumed: false, prevFocus: document.activeElement, ...opts };
  // Opened while the previous layer's entry is still being popped (a menu item
  // that opens a modal): take over that entry instead of push + back (they race).
  const reuse = pendingBack !== null && historyState().nwLayer === pendingBack;
  if (reuse) {
    pendingBack = null;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    // The menu's focus memory is the right one to come back to.
    if (lastReleased && lastReleased.id === Number(historyState().nwLayer)) layer.prevFocus = lastReleased.prevFocus;
  }
  layers.push(layer);
  try {
    if (reuse) window.history.replaceState({ ...historyState(), nwLayer: layer.id }, '');
    else window.history.pushState({ ...historyState(), nwLayer: layer.id }, '');
  } catch {
    layer.consumed = true; // no history (sandboxed frame): Back keys still work
  }
  requestAnimationFrame(() => takeFocus(layer));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    lastReleased = layer;
    if (!layer.consumed && historyState().nwLayer === layer.id) {
      // Popped on the next tick, unless a new layer takes the entry over first.
      pendingBack = layer.id;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(flushPendingBack, 0);
    }
    requestAnimationFrame(() => restoreFocus(layer));
  };
}

/**
 * Leave every open layer for a route (e.g. the player's "Channel page"): the
 * layers' history entries are not popped (that would race the navigation), the
 * route REPLACES the current entry instead. Call before closing the overlay.
 */
let pendingBack: number | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastReleased: Layer | null = null;

function flushPendingBack() {
  pendingTimer = null;
  const id = pendingBack;
  pendingBack = null;
  if (id !== null && historyState().nwLayer === id) {
    ignorePops += 1;
    window.history.back();
  }
}

export function navigateFromLayers(navigate: (to: string, o?: { replace?: boolean }) => void, to: string) {
  const replace = historyState().nwLayer != null;
  for (const l of layers) l.consumed = true;
  pendingBack = null;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  navigate(to, { replace });
}

function onPopState() {
  if (ignorePops > 0) {
    ignorePops -= 1;
    return;
  }
  const cur = Number(historyState().nwLayer ?? 0);
  // Close every layer whose entry is now ahead of the current one (top first).
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const l = layers[i];
    if (l.id > cur || !historyState().nwLayer) {
      l.consumed = true;
      l.close();
    }
  }
}

// ── Back ─────────────────────────────────────────────────────────────────
type BackKind = 'escape' | 'back';
let navigateFn: ((to: string, o?: { replace?: boolean }) => void) | null = null;
let exitArmedAt = 0;
const EXIT_WINDOW_MS = 2600;

/** App binds react-router's navigate (used when a deep link has no page to go back to). */
export function bindNavigate(fn: ((to: string, o?: { replace?: boolean }) => void) | null) {
  navigateFn = fn;
}

function back(kind: BackKind): boolean {
  const top = topLayer();
  if (top) {
    // Escape inside a modal that closes itself: leave the key to it.
    if (kind === 'escape' && top.escapeOwned) return false;
    top.close();
    return true;
  }
  if (kind === 'escape') return false;
  const { pathname, search } = window.location;
  if (pathname !== '/') {
    const idx = Number(historyState().idx ?? 0);
    if (idx > 0) window.history.back();
    else if (navigateFn) navigateFn('/', { replace: true });
    else window.location.assign('/');
    return true;
  }
  if (search) {
    // A search or a filtered grid: Back returns to Home.
    useCatalog.getState().resetFilters();
    return true;
  }
  const now = Date.now();
  if (now - exitArmedAt < EXIT_WINDOW_MS) {
    exitArmedAt = 0;
    return false; // second Back: the shell may close the app
  }
  exitArmedAt = now;
  useUI.getState().toast(t('toast.backExit'));
  return true;
}

const BACK_KEYS = new Set(['GoBack', 'BrowserBack']);
const BACK_CODES = new Set([4, 461, 10009]);

function onBackKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  let kind: BackKind | null = null;
  if (e.key === 'Escape') kind = isTV() ? 'back' : 'escape';
  else if (e.key === 'Backspace') {
    if (isField(e.target as Element) || e.metaKey || e.ctrlKey || e.altKey) return;
    kind = 'back';
  } else if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) kind = 'back';
  if (!kind) return;
  if (back(kind)) e.preventDefault();
}

// ── uiStore modals + player + mosaic become layers ───────────────────────
type ModalFlag = 'settingsOpen' | 'loginOpen' | 'pricingOpen' | 'prefsOpen' | 'accountOpen' | 'installOpen' | 'avatarOpen';
const MODALS: { flag: ModalFlag; close: () => void; escapeOwned: boolean }[] = [
  { flag: 'settingsOpen', close: () => useUI.getState().setSettings(false), escapeOwned: true },
  { flag: 'loginOpen', close: () => useUI.getState().setLogin(false), escapeOwned: true },
  { flag: 'pricingOpen', close: () => useUI.getState().setPricing(false), escapeOwned: true },
  { flag: 'prefsOpen', close: () => useUI.getState().setPrefs(false), escapeOwned: true },
  { flag: 'accountOpen', close: () => useUI.getState().setAccount(false), escapeOwned: true },
  { flag: 'installOpen', close: () => useUI.getState().setInstall(false), escapeOwned: true },
  { flag: 'avatarOpen', close: () => useUI.getState().setAvatar(false), escapeOwned: false },
];

/** The newest open dialog that is not already another layer's container. */
let resolving = false;
function newestDialog(): HTMLElement | null {
  // Other layers' containers are excluded; their own lookup may come back here: guard it.
  if (resolving) return null;
  resolving = true;
  let taken: Set<HTMLElement | null>;
  try {
    taken = new Set(layers.map((l) => l.el()).filter(Boolean));
  } finally {
    resolving = false;
  }
  const list = [...document.querySelectorAll<HTMLElement>('[data-layer], [aria-modal="true"], [role="dialog"], .fixed.inset-0')]
    .filter((el) => isVisible(el) && !taken.has(el) && ![...taken].some((t) => t && t.contains(el)));
  return list.length ? list[list.length - 1] : null;
}

function watchLayers() {
  const releases = new Map<string, () => void>();
  const sync = (name: string, open: boolean, make: () => Parameters<typeof openLayer>[0]) => {
    const has = releases.has(name);
    if (open && !has) releases.set(name, openLayer(make()));
    else if (!open && has) {
      releases.get(name)!();
      releases.delete(name);
    }
  };
  const syncUI = () => {
    const s = useUI.getState();
    for (const m of MODALS) {
      sync(m.flag, s[m.flag], () => {
        let el: HTMLElement | null = null;
        return {
          name: m.flag,
          close: m.close,
          escapeOwned: m.escapeOwned,
          el: () => {
            if (el && el.isConnected) return el;
            el = m.flag === 'avatarOpen' ? document.querySelector<HTMLElement>('[data-layer="avatar"]') : newestDialog();
            return el;
          },
        };
      });
    }
  };
  const syncPlayer = () => {
    const p = usePlayer.getState();
    sync('player', !!p.current, () => ({
      name: 'player',
      close: () => usePlayer.getState().close(),
      el: () => document.querySelector<HTMLElement>('[data-layer="player"]'),
      // The card of the channel now playing (zapping) if it is on screen, else the launcher.
      restoreKey: () => {
        const cur = usePlayer.getState().lastUrl;
        if (cur && document.querySelector(`[data-key="${cssEscape(cur)}"]`)) return cur;
        return usePlayer.getState().originKey;
      },
    }));
    sync('multi', p.multiOpen, () => ({
      name: 'multi',
      close: () => usePlayer.getState().closeMulti(),
      el: () => document.querySelector<HTMLElement>('[data-layer="multi"]'),
    }));
  };
  useUI.subscribe(syncUI);
  usePlayer.subscribe(syncPlayer);
  syncUI();
  syncPlayer();
}

// ── initial focus (TV) ───────────────────────────────────────────────────
/** Focus [data-autofocus] (the page's main action), else the first visible `fallback`, when nothing is focused yet. */
export function focusAutofocus(timeoutMs = 8000, fallback?: string) {
  if (typeof document === 'undefined') return;
  const end = Date.now() + timeoutMs;
  const tryFocus = () => {
    const a = document.activeElement;
    if (layers.length || (a && a !== document.body && a !== document.documentElement)) return;
    const el =
      [...document.querySelectorAll<HTMLElement>('[data-autofocus]')].find(isVisible) ||
      (fallback ? [...document.querySelectorAll<HTMLElement>(fallback)].find(isVisible) : undefined);
    if (el) {
      el.focus({ preventScroll: true });
      return;
    }
    if (Date.now() < end) setTimeout(tryFocus, 150);
  };
  tryFocus();
}

// ── spatial move ─────────────────────────────────────────────────────────
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
  const root = trapRoot();
  const els = focusables(root || document);
  if (!els.length) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || cur === document.body || !els.includes(cur)) {
    const auto = els.find((el) => el.hasAttribute('data-autofocus'));
    const first = auto || els[0];
    first.focus();
    first.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    const dx = b.left + b.width / 2 - cx;
    const dy = b.top + b.height / 2 - cy;
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
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return;
  }
  // No target that way. On a remote (no wheel/touch) this would strand the user
  // when the next home rail is lazy-mounted: scroll so it mounts, then retry once.
  if (!root && allowScroll && (dir === 'down' || dir === 'up')) {
    const sc = scrollableY(cur);
    const max = sc.scrollHeight - sc.clientHeight;
    const atEdge = dir === 'down' ? sc.scrollTop >= max - 2 : sc.scrollTop <= 2;
    if (atEdge) return;
    sc.scrollBy({ top: (dir === 'down' ? 1 : -1) * sc.clientHeight * 0.6, behavior: 'smooth' });
    setTimeout(() => move(dir, false), 280);
  }
}

const DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function onArrow(e: KeyboardEvent) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const dir = DIRS[e.key];
  if (!dir) return;
  const tgt = e.target as HTMLElement | null;
  // In a text field, Left/Right move the caret; Up/Down still navigate. A range
  // input (volume) keeps Left/Right too.
  if (tgt && (isField(tgt) || (tgt as HTMLInputElement).type === 'range') && (dir === 'left' || dir === 'right')) return;
  if (tgt && tgt.tagName === 'SELECT') return;
  e.preventDefault();
  move(dir);
}

/** Tab stays inside the top layer. */
function onTab(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.defaultPrevented) return;
  const root = trapRoot();
  if (!root) return;
  const els = focusables(root);
  if (!els.length) {
    e.preventDefault();
    return;
  }
  const i = els.indexOf(document.activeElement as HTMLElement);
  const next = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : i < 0 || i === els.length - 1 ? 0 : i + 1;
  e.preventDefault();
  els[next].focus();
}

/** Focus that escapes the top layer (a click behind a menu, a script) is pulled back in. */
function onFocusIn(e: FocusEvent) {
  const root = trapRoot();
  const tgt = e.target as Node | null;
  if (!root || !tgt || root.contains(tgt)) return;
  // A modal on top of a layer we know nothing about yet: let it be.
  if ((tgt as Element).closest?.('[aria-modal="true"], [role="dialog"], [data-layer]')) return;
  const top = topLayer();
  if (top) takeFocus(top);
}

declare global {
  interface Window {
    /** Back contract for the Android shell / TV platforms: true when handled. */
    __nwBack?: () => boolean;
    /** Url of the channel the player opened last (design verifier). */
    __nwLastPlayedKey?: string;
  }
}

let inited = false;
export function initSpatialNav() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  // Bubble phase: component handlers (rails, grid, the player) run first and may preventDefault.
  window.addEventListener('keydown', onArrow, false);
  window.addEventListener('keydown', onTab, false);
  window.addEventListener('keydown', onBackKey, false);
  window.addEventListener('focusin', onFocusIn);
  window.addEventListener('popstate', onPopState);
  window.__nwBack = () => back('back');
  watchLayers();
  if (isTV()) focusAutofocus();
}
