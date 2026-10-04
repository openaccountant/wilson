// Web AI Summit talk — the real WebMCP agent demo (Playwright).
//
// Nothing in this scene is simulated by the app. The browser half is the
// dashboard exactly as a user sees it; the agent half is a separate OS
// process (demos/scripts/webmcp-agent.mjs), a stock MCP SDK client talking
// Streamable HTTP to /mcp with only the bearer token granted on camera. The
// panel on the right is that process's live stdout, piped in verbatim.
//
// Beats: grant 3 tools in Settings → Agent access → agent connects, reads,
// proposes a categorization → the real prepare/commit confirmation card fires
// → a human approves → the ledger updates → Revoke all → the same agent now
// sees zero tools.
//
// NOTE: a client token carries write tools only while dashboard auth is on (P0b). With auth off the token is
// read-only, so categorize_transaction cannot be granted to it: enable auth on the demo profile first (TODO: seed
// an admin for the demo profile and log the page in as that user).
//
// Prereqs (same as record-talk-demos.mjs):
//   bun run src/index.tsx --profile demo --dashboard      # :3141
//   (cd src/dashboard/ui && bun run dev)                   # :5173
//
//   bun demos/scripts/record-webmcp-agent.mjs   → demos/tape-video/talk-video/webmcp-agent.webm
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const BASE = 'http://localhost:5173';
const W = 1440, H = 900, OUT = 'demos/tape-video/talk-video', NAME = 'webmcp-agent';
const QUERY = 'PHARMACY PLUS';
const TARGET_ID = 386; // PHARMACY PLUS #210, 2026-08-30 — uncategorized in the demo profile
const DEMO_DB = join(homedir(), '.openaccountant/profiles/demo/data.db');
const GRANT = ['spending_summary', 'transaction_search', 'categorize_transaction'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The commit would otherwise drift the demo profile's ground truth
// ($4,481.44 uncategorized in August — see verify-accuracy.sh) take over take.
function resetTarget() {
  execFileSync('sqlite3', [DEMO_DB, `UPDATE transactions SET category = NULL, entity_id = NULL WHERE id = ${TARGET_ID};`]);
}

// ── On-screen agent log: a verbatim mirror of the agent process's stdout ─────

async function installAgentPanel(page) {
  await page.evaluate(() => {
    if (document.getElementById('agent-panel')) return;
    const root = document.getElementById('root');
    if (root) root.style.width = 'calc(100vw - 470px)';
    const panel = document.createElement('div');
    panel.id = 'agent-panel';
    panel.style.cssText =
      'position:fixed;top:0;right:0;bottom:0;width:470px;z-index:2147483600;background:#0b0d12;' +
      'border-left:1px solid #2a2d37;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9;' +
      'display:flex;flex-direction:column;';
    panel.innerHTML =
      '<div style="padding:14px 16px;border-bottom:1px solid #2a2d37;font-family:system-ui,sans-serif">' +
      '<div style="font-weight:700;font-size:14px;color:#e4e4e7">External MCP agent</div>' +
      '<div style="font-size:11px;color:#71717a;margin-top:2px">separate process · MCP SDK Client · Streamable HTTP → /mcp · live stdout</div>' +
      '</div><div id="agent-log" style="padding:12px 16px;overflow:hidden;flex:1"></div>';
    document.body.appendChild(panel);
  });
}

const COLORS = { think: '#8b949e', call: '#58a6ff', result: '#e4e4e7', error: '#ef4444', done: '#22c55e', cmd: '#eab308' };
const GLYPH = { think: '·', call: '→', result: '←', error: '✗', done: '✓', cmd: '$' };

async function logLine(page, kind, text) {
  await page.evaluate(
    ({ kind, text, color, glyph }) => {
      const log = document.getElementById('agent-log');
      if (!log) return;
      const line = document.createElement('div');
      line.style.cssText = `color:${color};margin-bottom:6px;white-space:pre-wrap;word-break:break-word;`;
      line.textContent = `${glyph} ${text}`;
      log.appendChild(line);
      while (log.scrollHeight > log.clientHeight && log.children.length > 1) log.firstChild.remove();
    },
    { kind, text, color: COLORS[kind] ?? '#c9d1d9', glyph: GLYPH[kind] ?? ' ' }
  );
}

/** Spawn the agent with --json and mirror each event line into the panel. Resolves with its exit code. */
function runAgent(page, url, token, extra = []) {
  const args = ['demos/scripts/webmcp-agent.mjs', '--url', url, '--token', token, '--query', QUERY, '--pace', '1400', '--json', ...extra];
  const child = spawn('bun', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const events = [];
  const rl = readline.createInterface({ input: child.stdout });
  let chain = Promise.resolve();
  rl.on('line', (raw) => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      ev = { kind: 'result', text: raw };
    }
    events.push(ev);
    console.log(`    agent> ${ev.text}`);
    chain = chain.then(() => logLine(page, ev.kind, ev.text)).catch(() => {});
  });
  const done = new Promise((resolve) => child.on('exit', (code) => chain.then(() => resolve(code))));
  return { events, done };
}

async function waitForEvent(events, pred, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(pred)) return true;
    await sleep(100);
  }
  return false;
}

/** Switch tabs the way a user does (the SPA keeps sessionStorage, grants, and the agent panel). */
async function gotoTab(page, label) {
  await page.getByRole('button', { name: label, exact: true }).first().click();
}

// ── Scene ────────────────────────────────────────────────────────────────────

resetTarget();
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  colorScheme: 'dark',
});
ctx.setDefaultTimeout(15000);
const page = await ctx.newPage();
let failed = false;

try {
  // 1. Settings → Agent access: zero tools by default, then an explicit grant.
  await page.goto(`${BASE}/#settings`, { waitUntil: 'networkidle' });
  await installAgentPanel(page);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((el) => el.textContent === 'Agent access');
    h?.scrollIntoView({ block: 'start' });
  });
  await sleep(2500);

  for (const tool of GRANT) {
    await page.locator('label', { hasText: tool }).first().locator('input[type="checkbox"]').check();
    await sleep(700);
  }
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByText('Connect an external MCP client').waitFor();
  await sleep(1200);
  await page.mouse.wheel(0, 260);
  await sleep(900);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await sleep(2200);

  // Exactly what a human would copy into their agent's config: the endpoint
  // and bearer token as displayed.
  const endpoint = (await page.locator('code', { hasText: '/mcp' }).first().textContent())?.trim();
  const token = (await page.getByTestId('agent-access-token').textContent())?.trim();
  if (!endpoint || !token || token.startsWith('•')) throw new Error('connection details not shown');

  // 2. Over to the ledger, where the agent's change will land.
  await gotoTab(page, 'Transactions');
  await sleep(1000);
  // The header opens on the current month (September — empty in the demo
  // profile); step back to August, where the agent's charge lives.
  await page.getByRole('button', { name: '←', exact: true }).click();
  await page.getByText('August 2026').first().waitFor();
  await sleep(1200);
  const search = page.getByPlaceholder('Search by merchant or description...');
  await search.click();
  await search.pressSequentially(QUERY, { delay: 60 });
  await sleep(2000);

  // 3. The agent runs: two reads, then a mutation that blocks on a human.
  await logLine(page, 'cmd', `bun webmcp-agent.mjs --url ${endpoint} --token ${token.slice(0, 8)}…`);
  const agent = runAgent(page, endpoint, token);
  const card = page.getByRole('button', { name: 'Approve' });
  await card.waitFor({ timeout: 45000 }); // bridge polls /api/mcp/operations every 1.5s
  await sleep(3500); // let the audience read the before → after delta

  // 4. The human approves.
  await card.hover();
  await sleep(900); // Approve enables after 0.8 s, and the server refuses an approval younger than 1 s
  // Approve is hold-to-approve (0.6 s press-and-hold, real pointer events only): a plain click no longer approves.
  await page.mouse.down();
  await sleep(800);
  await page.mouse.up();
  const code = await agent.done;
  if (code !== 0) throw new Error(`agent exited ${code}`);
  await sleep(1200);

  // Search filters the loaded month client-side, so reload the view the way a
  // user would — leave the tab and come back — to show the committed row.
  await gotoTab(page, 'Overview');
  await sleep(900);
  await gotoTab(page, 'Transactions');
  await sleep(600);
  await search.click();
  await search.pressSequentially(QUERY, { delay: 30 });
  await page.locator('table').getByText('Uncategorized').waitFor({ state: 'detached', timeout: 10000 });
  await sleep(3500);

  // 5. Revocable any time: revoke, and the same token now sees nothing.
  await gotoTab(page, 'Settings');
  await sleep(800);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((el) => el.textContent === 'Agent access');
    h?.scrollIntoView({ block: 'start' });
  });
  await sleep(1500);
  await page.getByRole('button', { name: 'Revoke all' }).click();
  await page.getByText('No tools exposed').waitFor();
  await sleep(1500);
  await logLine(page, 'cmd', `bun webmcp-agent.mjs --url ${endpoint} --token ${token.slice(0, 8)}…  # same token, after revoke`);
  const again = runAgent(page, endpoint, token);
  await again.done;
  await sleep(3500);
} catch (e) {
  failed = true;
  console.log(`  [${NAME}] ERROR: ${e.message}`);
  await page.screenshot({ path: `${OUT}/${NAME}-error.png` }).catch(() => {});
}

const video = page.video();
await ctx.close();
await browser.close();
const dest = `${OUT}/${NAME}.webm`;
await rename(await video.path(), dest);
resetTarget();
console.log(`  scene "${NAME}" -> ${dest}${failed ? ' (FAILED — see error png)' : ''}`);
process.exit(failed ? 1 : 0);
