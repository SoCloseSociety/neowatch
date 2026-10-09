#!/usr/bin/env node
// verify-design.mjs -- the NEOWATCH design rules (Sentinel TV OS language),
// measured in a real Chrome. DESIGN-SPEC section 6. Rules adapted from
// SentinelHouse tools/verifier-charte.js (mesurerPage, jugerFocus, mesurerContraste).
//
// Usage:
//   node test/verify-design.mjs <port|--base URL> [--pages home,search,grid,detail,guide,films,radios,player,multi,login,pricing,settings]
//     [--formats desktop,phone,tv,tv1080] [--langs en,fr,ru] [--themes lunaire,doux]
//     [--out DIR] [--label NAME] [--measure] [--gestures] [--migration] [--allow-dev]
//   node test/verify-design.mjs --tokens <SentinelHouse>/08-sentinel-home/sentinel_home/ui/charte.css
//   node test/verify-design.mjs --keys          (static: every t('key') used in web/src exists in EN/FR/RU)
//
// Server: a THROWAWAY one, never the dev server on 8787 (refused unless --allow-dev):
//   PORT=8931 DATA_DIR=<scratch>/data CACHE_DIR=<scratch>/cache node server/src/index.js
// A read-only baseline of the live site is allowed: --base https://neowatch.soclose.co (GET only, no sign-in).
//
// Playwright comes from the root node_modules. If its bundled Chromium is missing, set
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
// (the script also falls back to that path by itself on macOS).
//
// Output: design-<label>.json + one screenshot per page/format/theme/lang in --out
// (default <os.tmpdir()>/neowatch-design, never in the repo). Exit 1 on the first
// fault unless --measure (which records and exits 0).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── arguments ────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const FLAGS = new Set(['--measure', '--gestures', '--migration', '--allow-dev', '--keys']);
const opts = {};
const positional = [];
for (let i = 0; i < ARGS.length; i += 1) {
  const a = ARGS[i];
  if (FLAGS.has(a)) opts[a.slice(2)] = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = ARGS[(i += 1)];
  else positional.push(a);
}
const MEASURE = !!opts.measure;

// ── static modes (no browser) ────────────────────────────────────────────
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
function cssBlock(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return null;
  let depth = 0;
  const start = css.indexOf('{', m.index);
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  return null;
}
function cssVars(block) {
  const out = {};
  if (!block) return out;
  for (const decl of block.split(/;(?![^(]*\))/)) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (m) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}
const SHARED = /^--(e-fond|bg-[0-4]|t[1-4]|line(-soft|-strong)?|mint|cyan|amber|red|violet|surface-.+|primaire-.+|focus-.+|d[1-3]|ease|ts-.+|rayon.*)$/;

function checkTokens(charte) {
  const ours = stripComments(fs.readFileSync(path.join(ROOT, 'web/src/index.css'), 'utf8'));
  const theirs = stripComments(fs.readFileSync(charte, 'utf8'));
  const report = { charte, blocks: {} };
  let faults = 0;
  for (const [name, re] of [['lunaire :root', /(^|\n)\s*:root\s*\{/], ['doux', /:root\[data-theme="doux"\]\s*\{/]]) {
    const a = cssVars(cssBlock(ours, re));
    const b = cssVars(cssBlock(theirs, re));
    const shared = Object.keys(b).filter((k) => SHARED.test(k) && k in a);
    const diff = shared.filter((k) => a[k] !== b[k]).map((k) => ({ token: k, neowatch: a[k], charte: b[k] }));
    const missing = Object.keys(b).filter((k) => SHARED.test(k) && !(k in a));
    report.blocks[name] = { compared: shared.length, equal: shared.length - diff.length, diff, notInNeowatch: missing };
    faults += diff.length;
    console.log(`${diff.length ? 'FAULT' : 'ok   '} ${name.padEnd(14)} ${shared.length - diff.length}/${shared.length} shared tokens equal to charte.css`);
    for (const d of diff) console.log(`        ${d.token}: neowatch "${d.neowatch}" != charte "${d.charte}"`);
    if (missing.length) console.log(`        (charte tokens not defined here, not compared: ${missing.join(' ')})`);
  }
  return { report, faults };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

function checkKeys() {
  const dictFiles = [path.join(ROOT, 'web/src/lib/i18n.ts'), ...fs.readdirSync(path.join(ROOT, 'web/src/lib/i18n')).map((f) => path.join(ROOT, 'web/src/lib/i18n', f))];
  const defined = new Map();
  const incomplete = [];
  for (const f of dictFiles) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*'([\w.-]+)':\s*\{(.*)\},?\s*$/.exec(line);
      if (!m) continue;
      const langs = ['en', 'fr', 'ru'].filter((l) => new RegExp(`\\b${l}:\\s*['"\`]`).test(m[2]));
      if (defined.has(m[1]) && path.basename(defined.get(m[1])) !== 'i18n.ts') incomplete.push(`${m[1]} defined twice (${path.basename(defined.get(m[1]))}, ${path.basename(f)})`);
      defined.set(m[1], f);
      if (langs.length < 3) incomplete.push(`${m[1]} (${path.basename(f)}) lacks ${['en', 'fr', 'ru'].filter((l) => !langs.includes(l)).join(',')}`);
    }
  }
  const unknown = [];
  for (const f of walk(path.join(ROOT, 'web/src'))) {
    if (f.includes(`${path.sep}lib${path.sep}i18n`)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([\w.-]+)'/g)) if (!defined.has(m[1])) unknown.push(`${path.relative(ROOT, f)}: t('${m[1]}')`);
    for (const m of src.matchAll(/\bt\.n\(\s*'([\w.-]+)'/g)) if (!defined.has(`${m[1]}.other`)) unknown.push(`${path.relative(ROOT, f)}: t.n('${m[1]}') has no .other`);
  }
  console.log(`i18n: ${defined.size} keys defined, ${incomplete.length} incomplete, ${unknown.length} unknown literal uses`);
  for (const x of [...incomplete, ...unknown]) console.log(`  FAULT ${x}`);
  return incomplete.length + unknown.length;
}

if (opts.tokens || opts.keys) {
  let faults = 0;
  const out = {};
  if (opts.tokens) {
    const { report, faults: f } = checkTokens(opts.tokens);
    out.tokens = report;
    faults += f;
  }
  if (opts.keys) faults += checkKeys();
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, `tokens-${opts.label || 'check'}.json`), JSON.stringify(out, null, 1));
  }
  if (!positional.length && !opts.base) process.exit(faults && !MEASURE ? 1 : 0);
}

// ── browser mode ─────────────────────────────────────────────────────────
let BASE;
if (opts.base) {
  BASE = String(opts.base).replace(/\/$/, '');
} else {
  const port = positional[0] || '';
  if (!/^\d+$/.test(port)) {
    console.error('usage: node test/verify-design.mjs <port|--base URL> [options] (see the header)');
    process.exit(2);
  }
  if (port === '8787' && !opts['allow-dev']) {
    console.error('refused: 8787 is the dev server; use a throwaway server (or pass --allow-dev)');
    process.exit(2);
  }
  BASE = `http://127.0.0.1:${port}`;
}
const READ_ONLY = !!opts.base;
const LABEL = opts.label || (READ_ONLY ? 'live' : 'measure');
const OUT = opts.out || path.join(os.tmpdir(), 'neowatch-design');
const PAGES_ALL = ['home', 'search', 'grid', 'detail', 'guide', 'films', 'radios', 'player', 'multi', 'login', 'pricing', 'settings'];
const PAGES = (opts.pages || PAGES_ALL.join(',')).split(',').map((p) => p.trim()).filter(Boolean);
const FORMATS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tv: { viewport: { width: 960, height: 540 }, deviceScaleFactor: 2, tv: true },
  tv1080: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, tv: true },
};
const CHOSEN_FORMATS = (opts.formats || 'desktop,phone,tv').split(',').filter(Boolean);
const LANGS = (opts.langs || 'en').split(',').filter(Boolean);
const THEMES = (opts.themes || 'lunaire').split(',').filter(Boolean);
const LOCALES = { en: 'en-GB', fr: 'fr-FR', ru: 'ru-RU' };
for (const f of CHOSEN_FORMATS) if (!FORMATS[f]) { console.error(`unknown format: ${f}`); process.exit(2); }
for (const p of PAGES) if (!PAGES_ALL.includes(p)) { console.error(`unknown page: ${p}`); process.exit(2); }

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright not found (npm i -D playwright at the repo root).');
  process.exit(2);
}
const STREAM_URL = /\.(m3u8?|ts|m4s|aac|mp4|mpd|mp3)(\?|$)/i;
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function launch() {
  if (process.env.CHROME) return chromium.launch({ executablePath: process.env.CHROME });
  try {
    return await chromium.launch();
  } catch (e) {
    if (fs.existsSync(SYSTEM_CHROME)) return chromium.launch({ executablePath: SYSTEM_CHROME });
    throw e;
  }
}

// Labels used to open overlays by a real click (any language; the old app has no dictionary).
const OPENERS = {
  player: { keys: ['home.watch'], labels: ['Watch now', 'Watch', 'Regarder', 'Смотреть'] },
  multi: { keys: ['nav.multi', 'top.multi'], labels: ['Multi-view', 'Multi-écran', 'Мультиэкран'] },
  login: { keys: ['top.login'], labels: ['Sign in', 'Connexion', 'Se connecter', 'Войти'] },
  pricing: { keys: ['promo.discover', 'menu.premium', 'top.premium'], labels: ['See plans', 'Discover', 'Découvrir', 'Voir les offres', 'Passer Premium', 'Go Premium', 'Premium'] },
  // Settings lives in the avatar menu: open it first (`pre`), then the entry.
  settings: { pre: '[data-avatar]', keys: ['top.settings', 'menu.settings'], labels: ['Settings', 'Réglages', 'Настройки'] },
};

// ── in the page: the static measures ─────────────────────────────────────
function measurePage({ lang }) {
  // Same normalisation as the page text below (formatted numbers carry no-break
  // spaces: "2 486 chaînes" must match its t() string).
  const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
  const T = window.__nwT ? new Set([...window.__nwT].map(norm)) : null;
  const DICT = window.__nwDict || null;
  const visible = (el) => {
    if (!el || !el.checkVisibility || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const offRead = (el) => !!el.closest('script, style, noscript, [aria-hidden="true"], details:not([open]) > :not(summary)');
  const toRgb = (css) => { const d = document.createElement('i'); d.style.color = css; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  const root = getComputedStyle(document.documentElement);
  const MINT = toRgb(root.getPropertyValue('--mint').trim() || '#34e5a0');
  const primFill = root.getPropertyValue('--primaire-fond').trim();
  const PRIMARY = primFill ? toRgb(primFill) : 'none';
  const name = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
  // An open overlay (player, dialog, panel) that covers most of the screen is
  // what the viewer sees: measure inside it only.
  const overlays = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .fixed.inset-0')].filter((x) => {
    if (!visible(x)) return false;
    const b = x.getBoundingClientRect();
    return b.width * b.height >= innerWidth * innerHeight * 0.5;
  });
  const scope = overlays.length ? overlays[overlays.length - 1] : document.body;
  const r = { scope: scope === document.body ? 'page' : name(scope), smallest: null, small: [], primaries: {}, caps: [], longest: { words: 0, text: '' }, mixed: [], hardcoded: 0, hardcodedSample: [], jargon: [], mint: [], cards: [], empties: [], firstRowTop: null, innerHeight, htmlLang: document.documentElement.lang, theme: document.documentElement.dataset.theme || '', tv: 'tv' in document.documentElement.dataset, instrumented: !!T };

  const COMPONENTS = 'button, h1, h2, h3, h4, [role="tab"], label, .btn, .row-title';
  const CAPS_OK = '.overline, .pill, kbd, .kbd, .brand, .meta';
  const JARGON = /\b(proxy|HLS|M3U|EPG|ABR|geo-?block\w*)\b|\b\d+ ?ms\b/i;
  const otherLangValues = new Set();
  const curLangValues = new Set();
  if (DICT) {
    for (const e of Object.values(DICT)) {
      for (const [l, v] of Object.entries(e)) (l === lang ? curLangValues : otherLangValues).add(norm(v));
    }
    for (const v of curLangValues) otherLangValues.delete(v);
  }
  const isData = (el) => !!el.closest('[translate="no"], input, textarea, select, video, canvas, svg');

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || !el || offRead(el) || !visible(el)) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const readable = /[\p{L}\p{N}]/u.test(text);
    if (readable) {
      if (r.smallest === null || size < r.smallest) r.smallest = size;
      if (size < 11.95) r.small.push(`${size}px ${name(el)} "${text.slice(0, 40)}"`);
    }
    const spacing = parseFloat(s.letterSpacing) || 0;
    const capsRun = /\p{Lu}{3,}/u.test(text) && text === text.toUpperCase();
    if ((s.textTransform === 'uppercase' || capsRun) && spacing / size > 0.05 && el.closest(COMPONENTS) && !el.closest(CAPS_OK) && /\p{L}{2}/u.test(text)) {
      r.caps.push(`${name(el)} "${text.slice(0, 40)}"`);
    }
    const fromT = T ? T.has(text) : false;
    const data = isData(el);
    // longest sentence: UI copy only (from t() when instrumented, else every non-data node)
    if ((T ? fromT : !data) && /\p{L}/u.test(text)) {
      for (const ph of text.split(/(?<=[.!?])\s+/)) {
        const words = ph.split(/\s+/).filter((x) => /\p{L}/u.test(x)).length;
        if (words > r.longest.words) r.longest = { words, text: ph.slice(0, 120) };
      }
    }
    if ((T ? fromT : !data) && JARGON.test(text)) r.jargon.push(text.slice(0, 80));
    if (DICT && otherLangValues.has(text) && !data) r.mixed.push(`other language: "${text.slice(0, 50)}"`);
    if (T && !fromT && !data && /\p{L}{2}/u.test(text) && !/^[\p{N}\s.,:·/%+-]+$/u.test(text)) {
      r.hardcoded += 1;
      if (r.hardcodedSample.length < 25) r.hardcodedSample.push(`${name(el)} "${text.slice(0, 40)}"`);
    }
    if (lang === 'ru' && T && fromT && /\p{L}{3}/u.test(text) && !/[Ѐ-ӿ]/.test(text) && !/^(NEOWATCH|Premium|PREMIUM|Admin|Email)$/.test(text)) r.mixed.push(`no Cyrillic: "${text.slice(0, 50)}"`);
  }
  for (const el of scope.querySelectorAll('[placeholder]')) {
    if (!visible(el) || offRead(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 11.95) r.small.push(`placeholder ${size}px ${name(el)}`);
    const ph = el.getAttribute('placeholder') || '';
    if (JARGON.test(ph)) r.jargon.push(`placeholder "${ph.slice(0, 60)}"`);
    if (DICT && otherLangValues.has(ph.trim())) r.mixed.push(`placeholder other language: "${ph.slice(0, 50)}"`);
  }

  // Primaries: outside dialogs (at most 1), and per open dialog (at most 1 each).
  const dialogOf = (el) => el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .fixed.inset-0');
  for (const el of scope.querySelectorAll('button, a, [role="button"], .btn')) {
    if (!visible(el) || offRead(el)) continue;
    if (el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (el.classList.contains('btn-primary') || bg === PRIMARY) {
      const d = dialogOf(el);
      const key = d ? `dialog:${name(d)}` : 'page';
      (r.primaries[key] ||= []).push((el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 30));
    }
  }

  // Mint: a control painted mint (state switches excepted).
  const MINT_OK = '[role="switch"], [aria-checked="true"], input[type="checkbox"], input[type="radio"]';
  for (const el of scope.querySelectorAll('button, a[href], [role="button"], [role="tab"], .btn')) {
    if (!visible(el) || offRead(el) || el.matches(MINT_OK) || el.closest(MINT_OK)) continue;
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? s.outlineColor : '';
    if ([s.backgroundColor, s.color, s.borderTopColor, s.borderBottomColor, outline].includes(MINT) || s.boxShadow.includes(MINT) || s.backgroundImage.includes(MINT)) {
      r.mint.push(`${name(el)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
    }
  }

  // One card, one action.
  for (const el of scope.querySelectorAll('[data-card]')) {
    if (!visible(el)) continue;
    const inner = el.querySelectorAll('button, a[href]').length;
    if (inner) r.cards.push(`${(el.textContent || '').trim().slice(0, 30)}: ${inner} inner control(s)`);
  }
  r.cardCount = scope.querySelectorAll('[data-card]').length;

  // Empty states.
  for (const el of scope.querySelectorAll('[data-empty]')) {
    if (visible(el) && !el.parentElement.closest('[data-empty]')) r.empties.push((el.textContent || '').trim().slice(0, 50));
  }

  // First row inside the first screen.
  const row = [...document.querySelectorAll('.row-title')].find(visible) || [...document.querySelectorAll('main h2, h2')].find(visible);
  if (row) r.firstRowTop = Math.round(row.getBoundingClientRect().top + window.scrollY);

  // Contrast on solid backgrounds: text colour over the composited opaque background.
  const parse = (c) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([R, G, B]) => 0.2126 * lin(R) + 0.7152 * lin(G) + 0.0722 * lin(B);
  const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const bgOf = (el) => {
    const layers = [];
    for (let x = el; x; x = x.parentElement) {
      const s = getComputedStyle(x);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null; // image or gradient: pixel method
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 0.99) break;
      }
    }
    let base = parse(getComputedStyle(document.body).backgroundColor) || [0, 0, 0, 1];
    if (base[3] < 0.99) base = [5, 7, 10, 1];
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
    return base;
  };
  r.contrast = [];
  r.contrastMeasured = 0;
  const seen = new Set();
  const w2 = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = w2.nextNode(); n; n = w2.nextNode()) {
    const el = n.parentElement;
    const text = (n.textContent || '').trim();
    if (!el || seen.has(el) || !/[\p{L}\p{N}]/u.test(text) || offRead(el) || !visible(el)) continue;
    seen.add(el);
    const b = el.getBoundingClientRect();
    if (b.bottom < 0 || b.top > innerHeight) continue; // first screen only
    // Text laid over an <img>/<video> (tile art, logo, player) is not on a solid
    // background: the hero pixel method covers the hero, the rest is skipped.
    let onMedia = false;
    for (let x = el.parentElement, k = 0; x && k < 4 && !onMedia; x = x.parentElement, k += 1) {
      for (const media of x.querySelectorAll('img, video, picture, canvas')) {
        const mb = media.getBoundingClientRect();
        if (mb.left < b.right && mb.right > b.left && mb.top < b.bottom && mb.bottom > b.top) { onMedia = true; break; }
      }
    }
    if (onMedia) { r.contrastOnMedia = (r.contrastOnMedia || 0) + 1; continue; }
    // The hero is art under a scrim: the pixel method (heroContrast) measures it.
    if (el.closest('[data-hero]')) continue;
    const bg = bgOf(el);
    if (!bg) continue;
    const s = getComputedStyle(el);
    let fg = parse(s.color);
    if (!fg) continue;
    let op = 1;
    for (let x = el; x; x = x.parentElement) op *= parseFloat(getComputedStyle(x).opacity) || 1;
    fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const L1 = lum(fg); const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    r.contrastMeasured += 1;
    if (ratio < 4.5) r.contrast.push(`${ratio.toFixed(2)}:1 ${name(el)} "${text.slice(0, 30)}"`);
  }
  return r;
}

// Hero text on an image: pixel method (90th-percentile background, text hidden).
async function heroContrast(page, decoder) {
  const targets = await page.evaluate(() => {
    const zone = document.querySelector('[data-hero]') || [...document.querySelectorAll('section, div')].find((x) => {
      const bi = getComputedStyle(x).backgroundImage;
      return /url\(/.test(bi) && x.getBoundingClientRect().height > 200;
    })?.parentElement;
    if (!zone) return [];
    const out = [];
    let i = 0;
    const w = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = w.nextNode(); n && i < 24; n = w.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent || '').trim()) continue;
      if (el.closest('button, .btn, .pill, input, kbd, svg, [data-card]')) continue;
      // Text faded out (the TV hero collapsed once the focus is in the rows) is not read.
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      seen.add(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const b = range.getBoundingClientRect();
      if (b.width < 4 || b.height < 4 || b.bottom < 0 || b.top > innerHeight) continue;
      el.dataset.nwMeasure = String(i);
      out.push({ i, text: n.textContent.trim().slice(0, 40), color: getComputedStyle(el).color, x: Math.max(0, b.left), y: Math.max(0, b.top), w: Math.min(b.width, innerWidth - Math.max(0, b.left)), h: Math.min(b.height, innerHeight - Math.max(0, b.top)) });
      i += 1;
    }
    return out;
  });
  const faults = [];
  const values = [];
  for (const c of targets) {
    if (c.w < 2 || c.h < 2) continue;
    await page.evaluate((i) => { const el = document.querySelector(`[data-nw-measure="${i}"]`); if (el) for (const p of ['color', '-webkit-text-fill-color', 'text-shadow']) el.style.setProperty(p, p === 'text-shadow' ? 'none' : 'transparent', 'important'); }, c.i);
    const png = await page.screenshot({ clip: { x: c.x, y: c.y, width: c.w, height: c.h }, animations: 'disabled' });
    await page.evaluate((i) => { const el = document.querySelector(`[data-nw-measure="${i}"]`); if (el) for (const p of ['color', '-webkit-text-fill-color', 'text-shadow']) el.style.removeProperty(p); }, c.i);
    const ratio = await decoder.evaluate(async ({ b64, color }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const px = cx.getImageData(0, 0, cv.width, cv.height).data;
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color) || [0, 255, 255, 255];
      const lt = lum(+m[1], +m[2], +m[3]);
      const ratios = [];
      for (let k = 0; k < px.length; k += 16) {
        const lf = lum(px[k], px[k + 1], px[k + 2]);
        ratios.push((Math.max(lt, lf) + 0.05) / (Math.min(lt, lf) + 0.05));
      }
      ratios.sort((a, b) => a - b);
      return ratios[Math.floor(ratios.length * 0.1)] || 21;
    }, { b64: png.toString('base64'), color: c.color });
    values.push({ text: c.text, ratio: Math.round(ratio * 100) / 100 });
    if (ratio < 4.5) faults.push(`${ratio.toFixed(2)}:1 hero "${c.text}"`);
  }
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-nw-measure]')) delete el.dataset.nwMeasure; });
  return { faults, values };
}

// Focus: Tab x8 (desktop/phone) or ArrowDown x4 (tv); the ring must contain --t1 and not be clipped.
function judgeFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const toRgb = (css) => { const d = document.createElement('i'); d.style.color = css; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  const T1 = toRgb(getComputedStyle(document.documentElement).getPropertyValue('--t1').trim() || '#e9eef2');
  const s = getComputedStyle(el);
  const nm = `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24)}"`;
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? s.outlineColor : '';
  const ring = outline === T1 || s.boxShadow.includes(T1);
  let clipped = '';
  if (ring) {
    const o = (parseFloat(s.outlineWidth) || 0) + (parseFloat(s.outlineOffset) || 0);
    const b = el.getBoundingClientRect();
    for (let c = el.parentElement; c && c !== document.body; c = c.parentElement) {
      const cs = getComputedStyle(c);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = c.getBoundingClientRect();
      const canScroll = c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1;
      if (cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || !canScroll) {
        if (b.left - o < r.left - 0.5 || b.right + o > r.right + 0.5 || b.top - o < r.top - 0.5 || b.bottom + o > r.bottom + 0.5) {
          clipped = `${c.tagName.toLowerCase()}.${String(c.className).trim().split(/\s+/).slice(0, 2).join('.')}`;
          break;
        }
      }
    }
  }
  return { name: nm, ring, clipped };
}

async function measureFocus(page, tv) {
  const faults = [];
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  const n = tv ? 4 : 8;
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press(tv ? 'ArrowDown' : 'Tab');
    await page.waitForTimeout(220);
    const f = await page.evaluate(judgeFocus);
    if (!f) { if (tv) faults.push(`ArrowDown ${i + 1}: nothing focused`); continue; }
    if (!f.ring) faults.push(`${f.name}: no bone ring`);
    else if (f.clipped) faults.push(`${f.name}: ring clipped by ${f.clipped}`);
  }
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    for (const x of document.querySelectorAll('*')) if (x.scrollTop || x.scrollLeft) { x.scrollTop = 0; x.scrollLeft = 0; }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
  return [...new Set(faults)];
}

// Hero image vs the featured channel's category (spec 2.2).
const AMBIANCE = { sports: 'sport', foot: 'sport', movies: 'cinema', series: 'cinema', animation: 'cinema', classic: 'cinema', music: 'music', news: 'news', business: 'news', weather: 'news', legislative: 'news', documentary: 'news' };
async function heroMatch(page) {
  return page.evaluate(async (AMB) => {
    let featured = null;
    try {
      const d = await (await fetch('/api/catalog/home')).json();
      featured = (d.featured || [])[0] || null;
    } catch { /* no home payload */ }
    const imgs = [...document.querySelectorAll('*')].map((x) => getComputedStyle(x).backgroundImage).filter((b) => /url\(/.test(b) && /(ambiance|hero\.webp)/.test(b));
    const shown = imgs[0] || '';
    const file = (/url\("?([^")]+)"?\)/.exec(shown) || [])[1] || '';
    const cat = featured?.categories?.[0] || null;
    const want = cat && AMB[cat] ? `/ambiance/${AMB[cat]}.webp` : 'logo window';
    const faults = [];
    if (/hero\.webp/.test(shown)) faults.push(`stadium fallback /hero.webp shown (featured "${featured?.name}", category ${cat})`);
    else if (want === 'logo window' ? !!file : !file.endsWith(want)) faults.push(`hero shows "${file || 'no image'}", expected ${want} for "${featured?.name}" (${cat})`);
    return { featured: featured?.name || null, category: cat, shown: file, expected: want, faults };
  }, AMBIANCE);
}

async function guideOverlap(page) {
  return page.evaluate(() => {
    const faults = [];
    const rows = new Map();
    for (const el of document.querySelectorAll('[data-prog]')) {
      const row = el.closest('[data-prog-row]') || el.parentElement;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(el.getBoundingClientRect());
    }
    for (const rects of rows.values()) {
      rects.sort((a, b) => a.left - b.left);
      for (let i = 1; i < rects.length; i += 1) if (rects[i].left < rects[i - 1].right - 1) faults.push(`overlap at x=${Math.round(rects[i].left)}`);
    }
    return { blocks: [...rows.values()].reduce((n, r) => n + r.length, 0), faults };
  });
}

// Click the first visible control whose text / aria-label / title is one of the labels.
async function clickByLabel(page, opener, lang) {
  return page.evaluate(({ keys, labels, lang: l }) => {
    const want = new Set(labels.map((x) => x.toLowerCase()));
    const D = window.__nwDict;
    if (D) for (const k of keys) if (D[k]) for (const v of Object.values(D[k])) want.add(String(v).toLowerCase());
    void l;
    const vis = (x) => x.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) && x.getBoundingClientRect().width > 0;
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (!vis(el)) continue;
      const names = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].map((x) => (x || '').replace(/\s+/g, ' ').trim().toLowerCase());
      if (names.some((n) => n && want.has(n))) { el.click(); return names.find((n) => n && want.has(n)); }
    }
    return null;
  }, { ...opener, lang });
}

async function prepare(ctx, { lang, theme }) {
  await ctx.addInitScript(({ lang: l, theme: th }) => {
    window.__NW_VERIFY = 1;
    try {
      localStorage.setItem('neowatch.lang', JSON.stringify({ state: { lang: l }, version: 0 }));
      const prev = JSON.parse(localStorage.getItem('neowatch.settings') || 'null');
      const state = { ...(prev && prev.state), theme: th };
      localStorage.setItem('neowatch.settings', JSON.stringify({ state, version: 2 }));
      sessionStorage.setItem('nw.promo.dismissed', '');
    } catch { /* private mode */ }
  }, { lang, theme });
}

async function firstChannelId() {
  try {
    const d = await (await fetch(`${BASE}/api/catalog/channels?limit=1`)).json();
    return d?.items?.[0]?.id || null;
  } catch { return null; }
}

function routeFor(p, chId) {
  return { home: '/', search: '/?q=news', grid: '/?cat=sports', detail: chId ? `/chaine/${chId}` : '/', guide: '/programme-tv', films: '/films', radios: '/radios' }[p] || '/';
}

async function isPlaying(page, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await page.evaluate(() => {
      const v = [...document.querySelectorAll('video')];
      return { video: v.length > 0, ready: v.some((x) => x.readyState >= 2), iframe: !!document.querySelector('iframe[src*="youtube"]') };
    });
    if (s.ready || s.iframe) return { opened: true, playing: true };
    if (Date.now() + 500 >= end) return { opened: s.video, playing: false };
    await page.waitForTimeout(500);
  }
  return { opened: false, playing: false };
}

async function gestures(browser, fmtName) {
  const fmt = FORMATS[fmtName];
  const ctx = await browser.newContext({ ...fmt, locale: 'en-GB', serviceWorkers: 'block' });
  await prepare(ctx, { lang: 'en', theme: 'lunaire' });
  const page = await ctx.newPage();
  const q = fmt.tv ? '?tv=1' : '';
  const res = { format: fmtName };
  // land to play
  await page.goto(`${BASE}/${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  let n = 0;
  if (fmt.tv) { await page.keyboard.press('Enter'); n += 1; }
  else { const hit = await clickByLabel(page, OPENERS.player, 'en'); if (hit) n += 1; }
  let st = await isPlaying(page);
  if (!st.opened && fmt.tv) {
    // count the presses a remote needs today: ArrowDown into a card, then OK
    for (let i = 0; i < 4 && !st.opened; i += 1) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); n += 2; st = await isPlaying(page, 4000); }
  }
  res.landToPlay = { gestures: n, ...st, expected: 1 };
  // TV Back restores focus
  if (fmt.tv && st.opened) {
    const playedKey = await page.evaluate(() => window.__nwLastPlayedKey || document.querySelector('[data-key]:focus')?.dataset.key || null);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const active = await page.evaluate(() => document.activeElement?.dataset?.key || null);
    res.backRestoresFocus = { ok: !!active && (!playedKey || active === playedKey), active, playedKey };
  }
  // search to play
  await page.goto(`${BASE}/${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  n = 0;
  await page.keyboard.press('/'); n += 1;
  let focusedField = await page.evaluate(() => /INPUT|TEXTAREA/.test(document.activeElement?.tagName || ''));
  if (!focusedField) {
    const box = page.locator('input[type="search"], input[placeholder]').first();
    if (await box.count()) { await box.click().catch(() => {}); focusedField = true; }
  }
  await page.keyboard.type('news'); n += 1;
  await page.keyboard.press('Enter'); n += 1;
  await page.waitForTimeout(2500);
  st = await isPlaying(page, 1500);
  if (!st.opened) {
    await page.keyboard.press('Enter'); n += 1;
    st = await isPlaying(page, 8000);
  }
  if (!st.opened) {
    const card = page.locator('[data-card], .cv-card, article').first();
    if (await card.count()) { await card.click().catch(() => {}); n += 1; st = await isPlaying(page, 8000); }
  }
  res.searchToPlay = { gestures: n, ...st, expected: 3 };
  // TV sign-in opens on the QR
  if (fmt.tv) {
    await page.goto(`${BASE}/${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const hit = await clickByLabel(page, OPENERS.login, 'en');
    await page.waitForTimeout(1500);
    const qr = await page.evaluate(() => [...document.querySelectorAll('canvas, img[src^="data:image"], svg[data-qr]')].some((x) => x.getBoundingClientRect().width > 80));
    res.tvSignInQr = { opened: !!hit, qrVisibleWithoutKeys: qr };
  }
  await ctx.close();
  return res;
}

async function migration(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('nw.mig')) return;
    sessionStorage.setItem('nw.mig', '1');
    localStorage.setItem('neowatch.settings', JSON.stringify({ state: { accent: 'rose', theme: 'slate', density: 'compact', defaultMuted: true, autoplay: true, reduceMotion: false, preferProxy: false, showOffline: true }, version: 0 }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    inlineAccent: document.documentElement.style.getPropertyValue('--accent'),
    stored: JSON.parse(localStorage.getItem('neowatch.settings') || 'null'),
    rendered: document.querySelectorAll('#root *').length,
  }));
  await ctx.close();
  const ok = r.theme === 'lunaire' && !r.inlineAccent && !errors.length && r.rendered > 20 && !('accent' in (r.stored?.state || {}));
  return { ok, ...r, errors };
}

// ── run ──────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
const decoder = await (await browser.newContext()).newPage();
const report = { base: BASE, label: LABEL, at: new Date().toISOString(), pages: [] };
const chId = PAGES.includes('detail') ? await firstChannelId() : null;
let firstFault = '';
console.log(`Design (${LANGS.join('+')}, ${THEMES.join('+')}, ${CHOSEN_FORMATS.join('+')}) on ${PAGES.length} page(s) at ${BASE}\n`);
console.log('  page      format  theme   lang  smallest small primaries caps longest mixed hardc jargon mint cards empties focus contrast origin console firstRow');

for (const theme of THEMES) {
  for (const fmtName of CHOSEN_FORMATS) {
    const fmt = FORMATS[fmtName];
    for (const lang of LANGS) {
      const ctx = await browser.newContext({ ...fmt, locale: LOCALES[lang] || 'en-GB', serviceWorkers: 'block' });
      await prepare(ctx, { lang, theme });
      for (const p of PAGES) {
        const page = await ctx.newPage();
        const consoleErrors = [];
        const origin = [];
        const fontsOff = new Set();
        const streamNoise = [];
        const streamHosts = new Set();
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const text = m.text();
          // Direct-first playback: a stream refusing CORS is expected (the player then
          // falls back to the relay). Recorded apart, never silently.
          if (/^Access to XMLHttpRequest at/.test(text) || (/net::ERR_FAILED/.test(text) && (p === 'player' || p === 'multi'))) {
            const h = /at '(https?:\/\/[^/']+)/.exec(text);
            if (h) streamHosts.add(new URL(h[1]).host);
            streamNoise.push(text.slice(0, 140));
            return;
          }
          consoleErrors.push(text.slice(0, 140));
        });
        page.on('pageerror', (e) => consoleErrors.push(`exception ${e.message.slice(0, 140)}`));
        page.on('request', (rq) => {
          const u = rq.url();
          if (/^(data|blob):/.test(u) || u.startsWith(BASE)) return;
          if (/fonts\.(googleapis|gstatic)\.com/.test(u)) fontsOff.add(new URL(u).host);
          // Streams are third party by design (direct-first playback): hls.js fetches them by xhr.
          if (STREAM_URL.test(u) || streamHosts.has(new URL(u).host)) return;
          if (['script', 'stylesheet', 'font', 'xhr', 'fetch'].includes(rq.resourceType())) origin.push(`${rq.resourceType()} ${u.slice(0, 90)}`);
        });
        const entry = { page: p, format: fmtName, theme, lang };
        try {
          const overlay = OPENERS[p] ? p : null;
          const url = `${BASE}${routeFor(overlay ? 'home' : p, chId)}`;
          const withTv = fmt.tv ? `${url}${url.includes('?') ? '&' : '?'}tv=1` : url;
          await page.goto(withTv, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(3500);
          if (overlay) {
            if (OPENERS[overlay].pre) {
              await page.locator(OPENERS[overlay].pre).first().click({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(400);
            }
            entry.opened = await clickByLabel(page, OPENERS[overlay], lang);
            await page.waitForTimeout(overlay === 'player' ? 4000 : 1500);
          }
          const m = await page.evaluate(measurePage, { lang });
          const focus = await measureFocus(page, !!fmt.tv);
          const hero = p === 'home' ? await heroContrast(page, decoder) : { faults: [], values: [] };
          const hm = p === 'home' ? await heroMatch(page) : null;
          const go = p === 'guide' ? await guideOverlap(page) : null;
          const shot = `${p}-${fmtName}-${theme}-${lang}.png`;
          await page.screenshot({ path: path.join(OUT, shot) });
          const pagePrimaries = m.primaries.page || [];
          const dialogPrimaries = Object.entries(m.primaries).filter(([k, v]) => k !== 'page' && v.length > 1).map(([k, v]) => `${k}: ${v.join(', ')}`);
          const faults = {
            smallest: m.small,
            primaries: [...(pagePrimaries.length > 1 ? [`page: ${pagePrimaries.join(', ')}`] : []), ...dialogPrimaries],
            caps: m.caps,
            longest: m.longest.words > 12 ? [`${m.longest.words} words "${m.longest.text}"`] : [],
            mixed: m.mixed,
            jargon: m.jargon,
            mint: m.mint,
            focus,
            cards: m.cards,
            empties: m.empties.length > 1 ? m.empties : [],
            contrast: [...m.contrast, ...hero.faults],
            firstRow: p === 'home' && (m.firstRowTop === null || m.firstRowTop >= m.innerHeight) ? [`first row top ${m.firstRowTop} >= ${m.innerHeight}`] : [],
            origin: [...new Set(origin)],
            console: consoleErrors,
            heroMatch: hm ? hm.faults : [],
            guideOverlap: go ? go.faults : [],
          };
          const count = Object.values(faults).reduce((n, v) => n + v.length, 0);
          Object.assign(entry, {
            faults: count,
            smallestPx: m.smallest,
            smallNodes: m.small.length,
            primariesOnPage: pagePrimaries.length,
            longestWords: m.longest.words,
            hardcoded: m.hardcoded,
            hardcodedSample: m.hardcodedSample,
            instrumented: m.instrumented,
            htmlLang: m.htmlLang,
            dataTheme: m.theme,
            dataTv: m.tv,
            cardCount: m.cardCount,
            firstRowTop: m.firstRowTop,
            contrastMeasured: m.contrastMeasured,
            heroContrast: hero.values,
            hero: hm,
            guide: go,
            fontsOffOrigin: [...fontsOff],
            streamNoise,
            screenshot: shot,
            detail: faults,
          });
          const c = (k) => String(faults[k].length).padStart(k.length > 5 ? 5 : 4);
          console.log(`  ${count ? 'F' : ' '} ${p.padEnd(8)} ${fmtName.padEnd(7)} ${theme.padEnd(7)} ${lang.padEnd(4)} ${String(m.smallest ?? '-').padStart(6)}px ${String(m.small.length).padStart(5)} ${String(pagePrimaries.length).padStart(9)} ${String(m.caps.length).padStart(4)} ${String(m.longest.words).padStart(7)} ${String(m.mixed.length).padStart(5)} ${String(m.instrumented ? m.hardcoded : '-').padStart(5)} ${c('jargon')} ${c('mint')} ${c('cards')} ${String(m.empties.length).padStart(7)} ${String(focus.length).padStart(5)} ${String(faults.contrast.length).padStart(8)} ${String(faults.origin.length).padStart(6)} ${String(consoleErrors.length).padStart(7)} ${String(m.firstRowTop ?? '-').padStart(8)}${overlay ? `  (opened: ${entry.opened || 'NOT FOUND'})` : ''}`);
          if (!firstFault && count) firstFault = `${p} ${fmtName} ${theme} ${lang}: ${Object.entries(faults).filter(([, v]) => v.length).map(([k, v]) => `${k}=${v.length}`).join(' ')}`;
        } catch (e) {
          entry.lost = String(e?.message || e).split('\n')[0].slice(0, 120);
          console.log(`  LOST ${p} ${fmtName} ${theme} ${lang}: ${entry.lost}`);
          if (!firstFault) firstFault = `lost page ${p} ${fmtName}`;
        }
        report.pages.push(entry);
        await page.close().catch(() => {});
      }
      await ctx.close().catch(() => {});
    }
  }
}

if (opts.gestures) {
  report.gestures = [];
  console.log('\nGestures:');
  for (const f of CHOSEN_FORMATS) {
    try {
      const g = await gestures(browser, f);
      report.gestures.push(g);
      console.log(`  ${f.padEnd(7)} land->play ${g.landToPlay.gestures} (playing ${g.landToPlay.playing}, opened ${g.landToPlay.opened}) · search->play ${g.searchToPlay.gestures} (opened ${g.searchToPlay.opened})${g.backRestoresFocus ? ` · back restores focus ${g.backRestoresFocus.ok}` : ''}${g.tvSignInQr ? ` · TV sign-in QR first ${g.tvSignInQr.qrVisibleWithoutKeys}` : ''}`);
      if (!firstFault && (g.landToPlay.gestures !== 1 || !g.landToPlay.opened)) firstFault = `gestures ${f}: land to play ${g.landToPlay.gestures}`;
    } catch (e) {
      console.log(`  ${f}: lost (${String(e?.message || e).split('\n')[0]})`);
    }
  }
}

if (opts.migration) {
  report.migration = await migration(browser);
  console.log(`\nSettings migration {accent:'rose', theme:'slate'}: ${report.migration.ok ? 'ok' : 'FAULT'} (data-theme=${report.migration.theme}, inline --accent="${report.migration.inlineAccent}", errors=${report.migration.errors.length}, stored=${JSON.stringify(report.migration.stored)})`);
  if (!report.migration.ok && !firstFault) firstFault = 'settings migration';
}

await browser.close();
const totals = report.pages.reduce((t, p) => {
  if (p.lost) { t.lost += 1; return t; }
  t.faults += p.faults; t.small += p.smallNodes; t.min = Math.min(t.min, p.smallestPx ?? 99);
  t.offOriginFonts += p.fontsOffOrigin.length ? 1 : 0;
  return t;
}, { faults: 0, small: 0, min: 99, lost: 0, offOriginFonts: 0 });
report.totals = totals;
const file = path.join(OUT, `design-${LABEL}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 1));
console.log(`\nFaults: ${totals.faults} · nodes under 12px: ${totals.small} · smallest ${totals.min}px · pages with Google Fonts: ${totals.offOriginFonts}${totals.lost ? ` · LOST pages: ${totals.lost}` : ''} -> ${file}`);
if (MEASURE) process.exit(0);
if (firstFault) { console.log(`First fault: ${firstFault}`); process.exit(1); }
console.log('Design rules hold');
process.exit(0);
