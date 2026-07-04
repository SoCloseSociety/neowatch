#!/usr/bin/env node
// NEOWATCH end-to-end smoke test (Playwright).
// Usage:  BASE=https://neowatch.soclose.co node tasks/e2e-smoke.mjs
// Needs Playwright + a Chromium. If not installed locally, run with a system
// Chrome:  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tasks/e2e-smoke.mjs
// (In CI, `npx playwright install chromium` first.)

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright not found. Install it (npm i -D playwright && npx playwright install chromium) or set NODE_PATH to a Playwright install.');
  process.exit(2);
}

const BASE = process.env.BASE || 'https://neowatch.soclose.co';
const launchOpts = process.env.CHROME ? { executablePath: process.env.CHROME } : {};
let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.error('  ✗', n)); };

const browser = await chromium.launch(launchOpts);
try {
  const page = await browser.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());

  // 1) Home renders brand + rails + tiles
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  ok('brand NEOWATCH visible', await page.locator('text=NEO').first().isVisible().catch(() => false));
  ok('category section present', (await page.locator('text=Parcourir par catégorie').count()) > 0);
  // All rails are in the DOM (content-visibility skips off-screen RENDER, not the nodes,
  // so TV D-pad can always move focus into them). Verify the full set is present.
  const rails = await page.locator('h2').count();
  ok(`home rails present (${rails})`, rails >= 12);

  // 2) Click a category tile → grid loads channels
  const tile = page.locator('button:has-text("Foot"), button:has-text("Sport")').first();
  if (await tile.count()) {
    await tile.click();
    await page.waitForTimeout(2500);
    const cards = await page.locator('.cv-card, article').count();
    ok(`grid shows channel cards after tile click (${cards})`, cards > 0);
  } else ok('category tile clickable', false);

  // 3) Search returns results
  const search = page.locator('input[placeholder*="Recherch"], input[placeholder*="herch"]').first();
  if (await search.count()) {
    await search.fill('news');
    await page.waitForTimeout(2500);
    const cards = await page.locator('.cv-card, article').count();
    ok(`search "news" returns cards (${cards})`, cards > 0);
  } else ok('search input present', false);

  // 4) Channel detail page (/chaine/:id) renders with name + actions
  const chId = await page.evaluate(async (base) => {
    const r = await fetch(base + '/api/catalog/channels?category=news&limit=1');
    const d = await r.json();
    return d?.items?.[0]?.id ?? null;
  }, BASE);
  if (chId) {
    await page.goto(`${BASE}/chaine/${chId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const h1 = await page.locator('h1').first().innerText().catch(() => '');
    ok(`detail page renders a channel title (${JSON.stringify(h1).slice(0, 30)})`, h1.trim().length > 0);
    ok('detail page has Regarder/Watch action', (await page.locator('button:has-text("Regarder"), button:has-text("Watch")').count()) > 0);
  } else ok('detail page reachable (got channel id)', false);

  // 5) Player mounts a <video> when a FREE channel is played (first home rail is
  //    premium/locked, so search a free channel to play instead).
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const psearch = page.locator('input[placeholder*="herch"]').first();
  if (await psearch.count()) { await psearch.fill('france'); await page.waitForTimeout(2500); }
  const freeCard = page.locator('.cv-card, article').first();
  if (await freeCard.count()) {
    await freeCard.click();
    // Poll for the <video> instead of a fixed wait: the player + hls.js live in a
    // lazy ~530KB chunk that can take >2.5s to fetch+parse in headless (the old
    // fixed 2.5s wait false-failed this check). Real users get it fine.
    await page.locator('video').first().waitFor({ state: 'attached', timeout: 12000 }).catch(() => {});
    ok('player mounts a <video> element', (await page.locator('video').count()) > 0);
    await page.keyboard.press('Escape').catch(() => {});
  } else ok('a channel card is clickable', false);

  // 6) Language switch FR -> EN changes UI copy (clear persisted lang for a clean FR baseline).
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.removeItem('neowatch.lang'); } catch { /* */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const hadCat = (await page.locator('text=Parcourir par catégorie').count()) > 0;
  const langBtn = page.locator('button:has(svg.lucide-languages)').first();
  const gotBtn = await langBtn.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (gotBtn) {
    await langBtn.click();
    await page.locator('text=English').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const nowEn = (await page.locator('text=Browse by category').count()) > 0;
    ok('language switch FR->EN updates copy', nowEn);
  } else ok('language switcher present', false);

  // 7) Programme TV grid page
  await page.goto(BASE + '/programme-tv', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);
  ok('programme-tv: title present', (await page.locator('h1:has-text("Programme"), h1:has-text("guide"), h1:has-text("программ")').count()) > 0);
  ok(`programme-tv: programme blocks render`, (await page.locator('button:has-text(":")').count()) >= 10);

  // 8) Shareable URL filters: a filtered URL loads the grid directly
  await page.goto(BASE + '/?cat=news&country=FR', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(3000);
  ok(`shareable URL loads filtered grid`, (await page.locator('.cv-card, article').count()) > 0 && page.url().includes('cat=news'));

  console.log(`\n===== E2E: ${pass} passed, ${fail} failed =====`);
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
