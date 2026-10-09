#!/usr/bin/env node
// NEOWATCH end-to-end smoke test (Playwright, real Chrome). Copy-agnostic: it relies on the
// verifier contract the components carry (data-hero, data-card + data-key=<stream url>,
// data-prog-row / data-prog, data-empty, window.__nwLastPlayedKey), never on UI wording.
//
//   BASE=http://localhost:8931 node test/e2e-smoke.mjs        # a throwaway local server
//   BASE=https://neowatch.soclose.co node test/e2e-smoke.mjs  # smoke test of the deployed site (GET only)
//   npm run test:e2e                                           # same, BASE defaults to the deployed site
// Playwright is a root devDependency; its bundled Chromium is optional: set
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
// (macOS falls back to that path by itself). In CI: `npx playwright install chromium` first.
import fs from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright not found: run `npm install` at the repo root (playwright is a devDependency).');
  process.exit(2);
}

const BASE = (process.env.BASE || 'https://neowatch.soclose.co').replace(/\/$/, '');
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME || (process.platform === 'darwin' && fs.existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
let pass = 0, fail = 0;
const ok = (n, c, detail = '') => { if (c) { pass++; console.log('  PASS ', n); } else { fail++; console.log('  FAIL ', n, detail); } };

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const errors = [];
const newPage = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return page;
};
const cards = (page) => page.locator('main [data-card]');
// A navigation can be aborted by the app's own pending history.back() (closing an
// overlay pops its history entry a tick later): retry once instead of failing.
async function goto(page, url, timeout) {
  try {
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (e) {
    if (!/ERR_ABORTED/.test(String(e?.message))) throw e;
    await page.waitForTimeout(500);
    return page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  }
}

try {
  const page = await newPage();

  // 1) Home: hero + rows of cards
  await goto(page, BASE + '/', 45000);
  await page.locator('[data-hero]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  ok('home: hero visible', await page.locator('[data-hero]').first().isVisible().catch(() => false));
  await cards(page).first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
  const homeCards = await cards(page).count();
  ok(`home: channel cards (${homeCards})`, homeCards > 0);
  const rows = await page.locator('.row-title').count();
  ok(`home: titled rows (${rows})`, rows >= 3);
  const keyed = await page.locator('main [data-card][data-key]').count();
  ok('home: cards carry data-key (stream url)', keyed > 0 && keyed === homeCards, `${keyed}/${homeCards}`);

  // 2) Search: type, Enter -> grid of results, URL is shareable
  const search = page.locator('input[type="search"]').first();
  if (await search.count()) {
    await search.fill('news');
    await search.press('Enter');
    await page.waitForFunction(() => /[?&]q=news/.test(location.search), null, { timeout: 10000 }).catch(() => {});
    await cards(page).first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    ok(`search "news": results (${await cards(page).count()})`, (await cards(page).count()) > 0);
    ok('search "news": shareable URL (?q=news)', /[?&]q=news/.test(new URL(page.url()).search));
  } else ok('search input present', false);

  // 3) Channel page /chaine/<id> (frozen URL)
  const chId = await page.evaluate(async () => {
    const r = await fetch('/api/catalog/channels?category=news&limit=1');
    return (await r.json())?.items?.[0]?.id ?? null;
  });
  if (chId) {
    await goto(page, `${BASE}/chaine/${chId}`, 30000);
    await page.locator('h1').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const h1 = (await page.locator('h1').first().innerText().catch(() => '')).trim();
    ok(`channel page: title (${JSON.stringify(h1).slice(0, 30)})`, h1.length > 0);
    ok('channel page: one primary action', (await page.locator('.btn-primary:visible').count()) === 1);
  } else ok('channel page reachable (got a channel id)', false);

  // 4) Player: a card click plays; the player records the played stream url
  await goto(page, BASE + '/?cat=news', 30000);
  await cards(page).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const first = cards(page).first();
  if (await first.count()) {
    const key = await first.getAttribute('data-key');
    await first.click();
    // Poll: the player + hls.js live in a lazy ~520 kB chunk.
    await page.locator('video').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    ok('player mounts a <video>', (await page.locator('video').count()) > 0);
    const played = await page.evaluate(() => window.__nwLastPlayedKey || null);
    ok('player records the played stream url', !!played && played === key, `${played} vs ${key}`);
    await page.keyboard.press('Escape').catch(() => {});
    // Closing the player is a history.back() (the TV Back contract): let that navigation
    // settle, or the next page.goto races it and aborts.
    await page.locator('video').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  } else ok('a channel card to play', false);

  // 5) TV guide: programme blocks, or ONE honest empty state when no guide is loaded
  await goto(page, BASE + '/programme-tv', 45000);
  await page.waitForFunction(() => document.querySelectorAll('[data-prog]').length >= 10 || document.querySelector('[data-empty]'), null, { timeout: 25000 }).catch(() => {});
  const progs = await page.locator('[data-prog-row] [data-prog]').count();
  const empties = await page.locator('[data-empty]:visible').count();
  ok(`guide: programme blocks (${progs}) or one empty state (${empties})`, progs >= 10 || empties === 1);

  // 6) Shareable filter URL loads the grid directly
  await goto(page, BASE + '/?cat=news&country=FR', 45000);
  await cards(page).first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  ok(`filter URL ?cat=news&country=FR loads cards (${await cards(page).count()})`, (await cards(page).count()) > 0);

  // 7) Language follows the browser (EN first; RU shows Cyrillic UI copy)
  const ru = await newPage({ locale: 'ru-RU' });
  await ru.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await ru.locator('[data-hero]').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  const ruNav = await ru.locator('header').first().innerText().catch(() => '');
  ok('ru-RU browser: Cyrillic UI copy', /[\u0400-\u04FF]/.test(ruNav), JSON.stringify(ruNav.slice(0, 60)));
  const enNav = await page.locator('header').first().innerText().catch(() => '');
  ok('en-US browser: no Cyrillic in the header', !/[\u0400-\u04FF]/.test(enNav));

  // 8) No page exceptions (console errors from third-party streams are listed, not fatal)
  const exceptions = errors.filter((e) => e.startsWith('pageerror'));
  ok(`no page exceptions (${exceptions.length})`, exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  if (errors.length) console.log(`  (info) ${errors.length} console error(s), e.g. ${errors.slice(0, 2).join(' | ').slice(0, 200)}`);

  console.log(`\n===== E2E: ${pass} passed, ${fail} failed =====`);
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
