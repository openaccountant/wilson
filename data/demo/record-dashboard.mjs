// Dashboard demo recordings (Playwright). Dashboard must be running on the DEMO
// profile:  wilson --profile demo --dashboard  (http://localhost:3141).
// Scenes are selectable via argv (default: all). Each -> its own WebM in dash-video/.
import { chromium } from 'playwright';
import { rename } from 'node:fs/promises';

const BASE = 'http://localhost:3141';
const W = 1400, H = 860, OUT = 'data/demo/dash-video';
const want = process.argv.slice(2);
const run = (n) => want.length === 0 || want.includes(n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome' });

async function scene(name, fn) {
  if (!run(name)) return;
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  ctx.setDefaultTimeout(8000);           // hard cap so nothing hangs the recording
  try { await fn(page); } catch (e) { console.log(`  [${name}] ${e.message}`); }
  const video = page.video();
  await ctx.close();
  const p = await video.path();
  const dest = `${OUT}/${name}.webm`;
  await rename(p, dest);
  console.log(`  scene "${name}" -> ${dest}`);
}
const click = async (page, label, ms = 1500) => {
  try { await page.getByText(label, { exact: true }).first().click({ timeout: 4000 }); await sleep(ms); return true; }
  catch { console.log(`    (no "${label}")`); return false; }
};
const slowScroll = async (page, total = 1600, step = 180) => {
  for (let y = 0; y < total; y += step) { await page.mouse.wheel(0, step); await sleep(600); }
};

// ── Scene 1: Overview — Month preset stepped back to August 2026 (hero month), ──
// ── then click the 2026-08-17 heatmap cell (Harborview Hotel duplicate-charge day) ──
const prevMonth = async (page, ms = 2600) => {
  try { await page.getByRole('button', { name: '←' }).click({ timeout: 4000 }); await sleep(ms); return true; }
  catch (e) { console.log(`    (prev-month arrow: ${e.message})`); return false; }
};

await scene('overview', async (page) => {
  await page.goto(`${BASE}/#overview`, { waitUntil: 'networkidle' });
  await sleep(3000);
  await click(page, 'Month', 1800);   // reset to the current calendar month
  await prevMonth(page, 3000);        // step back one month -> August 2026
  await sleep(1000);
  // click the Aug 17 heatmap square (SVG <rect> whose <title> starts 2026-08-17)
  try {
    const cell = page.locator('svg rect').filter({ hasText: '2026-08-17' }).first();
    await cell.scrollIntoViewIfNeeded();
    await cell.click({ timeout: 4000, force: true });
    await sleep(3000);
  } catch (e) { console.log(`    (heatmap cell: ${e.message})`); }
  await sleep(1500);
});

// ── Scene 2: Training — full annotation flow ──
await scene('training', async (page) => {
  await page.goto(`${BASE}/#llm`, { waitUntil: 'networkidle' });
  await sleep(2200);
  await click(page, 'Training', 2200);                 // sub-nav
  // open the first interaction row
  try { await page.locator('table tbody tr').first().click({ timeout: 4000 }); await sleep(2500); }
  catch (e) { console.log(`    (no row: ${e.message})`); }
  // in the dialog: scroll to the notes textarea and type
  try {
    const notes = page.locator('textarea').first();
    await notes.scrollIntoViewIfNeeded(); await sleep(800);
    await notes.click(); await notes.type('Correct categorization and the duplicate was caught accurately.', { delay: 35 });
    await sleep(1500);
  } catch (e) { console.log(`    (notes: ${e.message})`); }
  // click a rating star (4th) in the dialog footer
  try {
    const stars = page.locator('.max-w-3xl').getByText('☆', { exact: true });
    await stars.nth(3).click({ timeout: 3000 }); await sleep(1500);
  } catch (e) { console.log(`    (rating: ${e.message})`); }
  // set preference = Chosen
  try {
    const sel = page.locator('select').last();
    await sel.selectOption('chosen'); await sleep(1800);
  } catch (e) { console.log(`    (preference: ${e.message})`); }
  // save
  await click(page, 'Save Annotation', 2500);
});

// ── Scene 3: Transactions — August 2026, filter down to the Harborview duplicate ──
await scene('transactions', async (page) => {
  await page.goto(`${BASE}/#transactions`, { waitUntil: 'networkidle' });
  await sleep(2500);
  await click(page, 'Month', 1500);   // reset to the current calendar month
  await prevMonth(page, 2800);        // step back one month -> August 2026
  await sleep(1200);
  // filter to the Harborview Hotel duplicate charge (Aug 17 & Aug 20, $318.00 each)
  try {
    const search = page.getByPlaceholder('Search by merchant or description...');
    await search.click();
    await search.type('harborview', { delay: 45 });
    await sleep(2500);
  } catch (e) { console.log(`    (search: ${e.message})`); }
  await sleep(1500);
});

// ── Scene 4: Goals (view the goal set from the CLI) ──
await scene('goals', async (page) => {
  await page.goto(`${BASE}/#goals`, { waitUntil: 'networkidle' });
  await sleep(3000);
  await slowScroll(page, 900);
  await sleep(1500);
});

// ── Scene 5: Settings — switch profile, add entity, add memory ──
await scene('settings', async (page) => {
  await page.goto(`${BASE}/#settings`, { waitUntil: 'networkidle' });
  await sleep(2500);
  // switch profile — the PROFILE select is index 3 (0-2 are the top filter bar)
  try {
    const prof = page.locator('select').nth(3);
    await prof.scrollIntoViewIfNeeded(); await sleep(600);
    await prof.selectOption('showcase'); await sleep(2600);
    await prof.selectOption('demo'); await sleep(2200);          // switch back to demo
  } catch (e) { console.log(`    (profile: ${e.message})`); }
  // add an entity (form is revealed by "+ Add Entity")
  await click(page, '+ Add Entity', 1200);
  try {
    await page.locator('input[placeholder="Entity name"]').fill('Rental Property LLC'); await sleep(1100);
    await page.locator('input[placeholder="Description (optional)"]').fill('Duplex rental income'); await sleep(900);
  } catch (e) { console.log(`    (entity inputs: ${e.message})`); }
  await click(page, 'Create Entity', 2000);
  // add a memory
  try {
    const mem = page.locator('input[placeholder="Memory content..."], textarea[placeholder="Memory content..."]').first();
    await mem.scrollIntoViewIfNeeded(); await mem.fill('Always format currency in USD. Flag dining over $150 in a week.'); await sleep(1500);
  } catch (e) { console.log(`    (memory: ${e.message})`); }
  await click(page, 'Add Memory', 2500);
  await sleep(1500);
});

// ── Scene 6: Chat — open a previous chat and interact ──
await scene('chat', async (page) => {
  await page.goto(`${BASE}/#chat`, { waitUntil: 'networkidle' });
  await sleep(2500);
  // open a previous session — left rail is div.w-60; button[0]=New Chat, [1+]=sessions
  try {
    const btns = page.locator('.w-60 button');
    await btns.nth(1).click({ timeout: 5000 }); await sleep(2800);
  } catch (e) { console.log(`    (session: ${e.message})`); }
  // type a follow-up and send
  try {
    const input = page.getByPlaceholder('Ask Wilson...');
    await input.fill('Summarize what we found and the single most important action.'); await sleep(1200);
    await input.press('Enter'); await sleep(12000);              // wait for model reply
  } catch (e) { console.log(`    (chat input: ${e.message})`); }
  await sleep(1500);
});

await browser.close();
console.log('done');
