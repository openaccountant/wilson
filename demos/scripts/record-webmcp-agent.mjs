// Web AI Summit talk — the real WebMCP agent demo (Playwright).
//
// Nothing in this scene is simulated by the app. The browser half is the
// dashboard exactly as a user sees it; the agent half is a separate OS
// process (demos/scripts/webmcp-agent.mjs), a stock MCP SDK client talking
// Streamable HTTP to /mcp with only the bearer token granted on camera. The
// panel on the right is that process's live stdout, piped in verbatim.
//
// Beats: mint a token with 3 tools in Settings → Agent access → External MCP clients → agent connects, reads,
// proposes a categorization → the real prepare/commit confirmation card fires
// → a human approves → the ledger updates → Revoke the token → the same agent now
// gets nothing.
//
// NOTE: a client token carries write tools only while dashboard auth is on (P0b). With auth off the token is
// read-only, so categorize_transaction cannot be granted to it. This recorder therefore needs the demo profile
// set up once with dashboard auth ON and the fixed demo-only admin, and it logs the page in as that admin
// (POST /api/auth/login, token into localStorage like the login form does) before touching Settings.
//
// Prereqs (same as record-talk-demos.mjs):
//   bun run scripts/demo-enable-auth.ts                    # once: auth ON + demo-only admin, demo profile only
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
import { DEMO_ADMIN } from './demo-admin.mjs';

// Vite dev needs WILSON_DASHBOARD_DEV=1 on the server; the built UI is http://localhost:3141.
const BASE = process.env.WILSON_DEMO_BASE ?? 'http://localhost:5173';
const W = 1440, H = 900, OUT = 'demos/tape-video/talk-video', NAME = 'webmcp-agent';
const QUERY = 'PHARMACY PLUS';
const TARGET_ID = 386; // PHARMACY PLUS #210, 2026-08-30 — uncategorized in the demo profile
const DEMO_DB = join(homedir(), '.openaccountant/profiles/demo/data.db');
const GRANT = ['get_spending_summary', 'search_transactions', 'categorize_transaction'];
const TOKEN_NAME = 'talk-demo-agent';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD_MS = 800; // Approve is hold-to-approve: 0.6 s press-and-hold, so hold with margin

// The commit would otherwise drift the demo profile's ground truth
// ($4,481.44 uncategorized in August — see verify-accuracy.sh) take over take.
function resetTarget() {
  execFileSync('sqlite3', [DEMO_DB, `UPDATE transactions SET category = NULL, entity_id = NULL WHERE id = ${TARGET_ID};`]);
}

/**
 * Log the page in as the demo admin, the way the login form does: POST /api/auth/login, then the session token
 * goes into localStorage under the key the SPA reads. Throws a pointed error when auth is off or the admin is missing.
 */
async function loginAsDemoAdmin(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async ({ username, password }) => {
    const st = await (await fetch('/api/auth/status')).json();
    if (!st.authEnabled) return { error: 'auth is OFF on this profile; run: bun run scripts/demo-enable-auth.ts (then restart the dashboard)' };
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return { error: `demo admin login failed (${res.status}); run: bun run scripts/demo-enable-auth.ts` };
    const { token } = await res.json();
    localStorage.setItem('wilson_auth_token', token);
    return { ok: true };
  }, DEMO_ADMIN);
  if (out.error) throw new Error(out.error);
}

/** Press-and-hold, never click: mouse.down, wait past the 0.6 s hold threshold, mouse.up. */
async function holdToApprove(page, button) {
  await button.hover();
  await sleep(900); // Approve enables after 0.8 s, and the server refuses an approval younger than 1 s
  await page.mouse.down();
  await sleep(HOLD_MS);
  await page.mouse.up();
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
  // 0. Off camera: sign in as the demo admin (auth is on, so write tools are grantable).
  await loginAsDemoAdmin(page);

  // 1. Settings → Agent access → External MCP clients: name a token, pick exactly three tools, mint it.
  await page.goto(`${BASE}/#settings`, { waitUntil: 'networkidle' });
  await installAgentPanel(page);
  await page.getByTestId('agent-client-tokens').waitFor();
  await page.evaluate(() => document.querySelector('[data-testid="agent-client-tokens"]')?.scrollIntoView({ block: 'start' }));
  await sleep(2500);

  // The picker pre-selects a default read set; clear it so the grant is exactly what we show.
  const picker = page.getByTestId('agent-client-tokens');
  for (const box of await picker.locator('input[type="checkbox"]').all()) {
    if (await box.isChecked()) await box.uncheck();
  }
  await picker.getByLabel('Token name').fill(TOKEN_NAME);
  await sleep(900);
  for (const tool of GRANT) {
    // A WRITE tool is only enabled because dashboard auth is on and we are logged in as an admin.
    await picker.locator('label', { hasText: tool }).first().locator('input[type="checkbox"]').check();
    await sleep(700);
  }
  await picker.getByRole('button', { name: 'Mint token', exact: true }).click();
  const reveal = page.getByTestId('client-token-plaintext');
  await reveal.waitFor();
  await sleep(2200);

  // Exactly what a human would copy into their agent's config: the endpoint and bearer token as displayed
  // (shown once; the modal hides itself after a few seconds).
  const token = (await reveal.textContent())?.trim();
  const endpoint = (await picker.locator('code', { hasText: '/mcp' }).first().textContent())?.trim();
  if (!endpoint || !token?.startsWith('wmcp_')) throw new Error('connection details not shown (expected a wmcp_ token)');
  await page.getByRole('button', { name: 'I saved it', exact: true }).click();
  await sleep(800);

  // 2. Over to the ledger, where the agent's change will land.
  await gotoTab(page, 'Transactions');
  await sleep(1000);
  // The header opens on the current month (empty in the demo profile);
  // August is where the agent's charge lives.
  // Step back until August shows (however many months ago the calendar has moved on from the seed).
  for (let i = 0; i < 12 && !(await page.getByText('August 2026').first().isVisible()); i++) {
    await page.getByRole('button', { name: '←', exact: true }).click();
    await sleep(500);
  }
  await page.getByText('August 2026').first().waitFor();
  await sleep(1200);
  const search = page.getByPlaceholder('Search by merchant or description...');
  await search.click();
  await search.pressSequentially(QUERY, { delay: 60 });
  await sleep(2000);

  // 3. The agent runs: two reads, then a mutation that blocks on a human.
  await logLine(page, 'cmd', `bun webmcp-agent.mjs --url ${endpoint} --token ${token.slice(0, 8)}…`);
  const agent = runAgent(page, endpoint, token);
  const card = page.getByRole('button', { name: /hold to approve/i });
  await card.waitFor({ timeout: 45000 }); // bridge polls /api/mcp/operations every 1.5s
  await sleep(3500); // let the audience read the before → after delta

  // 4. The human approves.
  // Approve is hold-to-approve (0.6 s press-and-hold, real pointer events only): a plain click no longer approves.
  await holdToApprove(page, card);
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

  // 5. Revocable any time: revoke the token, and the same token now gets nothing.
  await gotoTab(page, 'Settings');
  await sleep(800);
  await page.getByTestId('agent-client-tokens').waitFor();
  await page.evaluate(() => document.querySelector('[data-testid="agent-client-tokens"]')?.scrollIntoView({ block: 'start' }));
  await sleep(1500);
  const row = page.getByTestId('agent-client-tokens').locator('div.border.rounded', { hasText: TOKEN_NAME }).first(); // newest first
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await row.getByText('revoked').waitFor();
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
