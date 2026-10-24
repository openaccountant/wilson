#!/usr/bin/env node
// Live WebMCP segment for the Web AI Summit talk ("Outside" beat), plus a preflight check.
//
// An outside agent (agent-browser, attached over CDP) calls the dashboard's real WebMCP tools, then the
// human flips Agent access OFF and the agent's next call fails with webmcp_tool_not_found. Synthetic seed
// data only, in a scratch HOME; the real keychain and real profiles are never touched.
//
//   node demos/live/webmcp-live.mjs up [--fresh]   # sandbox: seed, dashboard, Chrome (WebMCP + CDP); Ctrl-C stops it
//   node demos/live/webmcp-live.mjs stage          # on stage, in a second terminal: Enter advances each step
//   node demos/live/webmcp-live.mjs check [--fresh]  # preflight: up + scripted human + asserts, then stops (exit 0/1)
//   node demos/live/webmcp-live.mjs reset          # between runs: access back ON with 0 grants, same Chrome
//
// Run from the repo root. One-time: `cd demos/live && npm install` (pins agent-browser 0.38.2).
// Never run `agent-browser close` against this session: it kills the shared Chrome.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const WORK = process.env.WILSON_LIVE_DIR ?? '/private/tmp/claude-501/wilson-live';
const HOME_DIR = path.join(WORK, 'home');
const UDD = path.join(WORK, 'chrome-udd');
const PORT = Number(process.env.WILSON_LIVE_PORT ?? 3141);
const CDP = Number(process.env.WILSON_LIVE_CDP ?? 9333);
const URL_ = `http://localhost:${PORT}/`;
const AB_BIN = path.join(here, 'node_modules/.bin/agent-browser');
const GRANTS = ['get_spending_summary', 'search_transactions'];
const SUMMARY_ARGS = { period: 'month', compareWithPrevious: true };

const [mode = 'up', ...rest] = process.argv.slice(2);
const fresh = rest.includes('--fresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

// ── agent side: agent-browser over CDP ─────────────────────────────────────────

function ab(...args) {
  if (!fs.existsSync(AB_BIN)) throw new Error(`agent-browser missing: run \`cd ${path.relative(process.cwd(), here)} && npm install\``);
  try {
    return { ok: true, out: execFileSync(AB_BIN, ['--cdp', String(CDP), '--session', 'wilson-live', ...args], { encoding: 'utf8', timeout: 30_000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function listTools() {
  const r = ab('webmcp', 'list', '--json');
  const j = JSON.parse(r.out);
  if (!j.success) throw new Error(`webmcp list failed: ${j.error}`);
  return j.data.tools.map((t) => t.name);
}

function invoke(tool, params) {
  const r = ab('webmcp', 'invoke', tool, '--params', JSON.stringify(params), '--json');
  const j = JSON.parse(r.out);
  return j.success ? { ok: true, result: j.data.output } : { ok: false, code: j.code, error: j.error };
}

const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function printSummary(result) {
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  const items = data.items ?? [];
  console.log(c.dim(`  ${'category'.padEnd(16)}${'this month'.padStart(13)}${'last month'.padStart(13)}`));
  for (const it of items) console.log(`  ${it.category.padEnd(16)}${money(it.total).padStart(13)}${money(it.prev ?? 0).padStart(13)}`);
  return items;
}

// ── sandbox: seed, dashboard, Chrome ───────────────────────────────────────────

const children = [];
let browserCtx = null;

function assertScratch(p) {
  const real = path.resolve(p);
  if (!real.startsWith('/private/tmp/') || real.split('/').length < 5) throw new Error(`refusing non-scratch path ${real}`);
  return real;
}

function waitHttp(url, ms) {
  const until = Date.now() + ms;
  return (async () => {
    while (Date.now() < until) {
      try { if ((await fetch(url)).ok) return; } catch {}
      await sleep(300);
    }
    throw new Error(`${url} did not come up in ${ms} ms`);
  })();
}

function portBusy(port) {
  try { return execFileSync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim() !== ''; } catch { return false; }
}

async function up() {
  for (const p of [PORT, CDP]) if (portBusy(p)) throw new Error(`port ${p} is already in use; stop whatever holds it first`);
  assertScratch(WORK);
  if (fresh) fs.rmSync(assertScratch(HOME_DIR), { recursive: true, force: true });
  const shimDir = path.join(HOME_DIR, '.webmcp-live-bin');
  const env = { ...process.env, HOME: HOME_DIR, PATH: `${shimDir}:${process.env.PATH}` };

  if (!fs.existsSync(path.join(HOME_DIR, '.openaccountant'))) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    console.log(c.dim('seeding synthetic profile…'));
    execFileSync('bun', ['run', 'scripts/webmcp-live-seed.ts'], { cwd: repo, env, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (!fs.existsSync(path.join(repo, 'src/dashboard/ui/dist/index.html'))) {
    console.log(c.dim('building dashboard UI…'));
    execFileSync('npm', ['run', 'build'], { cwd: path.join(repo, 'src/dashboard/ui'), stdio: 'inherit' });
  }

  const log = fs.openSync(path.join(WORK, 'dashboard.log'), 'w');
  const dash = spawn('bun', ['run', path.join(repo, 'src/index.tsx'), '--dashboard', '--port', String(PORT)], { cwd: HOME_DIR, env, stdio: ['ignore', log, log] });
  children.push(dash);
  await waitHttp(URL_, 30_000);

  const { chromium } = await import('playwright');
  fs.rmSync(assertScratch(UDD), { recursive: true, force: true });
  browserCtx = await chromium.launchPersistentContext(UDD, {
    channel: 'chrome', headless: false, viewport: null,
    // Our own signal handler owns shutdown; Playwright's would exit first and orphan the dashboard on :PORT.
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: ['--enable-features=WebMCPTesting', `--remote-debugging-port=${CDP}`, '--no-first-run', '--no-default-browser-check', '--start-maximized'],
  });
  const page = browserCtx.pages()[0] ?? (await browserCtx.newPage());
  await page.goto(URL_);
  if (!(await page.evaluate(() => !!document.modelContext))) throw new Error('this Chrome has no document.modelContext (needs WebMCPTesting)');
  console.log(`${c.green('READY')} dashboard ${URL_}  cdp ${CDP}  home ${HOME_DIR}`);
  return page;
}

async function down() {
  // Only tear down what this process started (`stage` starts nothing and must not touch `up`'s Chrome).
  // Children first and synchronously, so the dashboard dies even if closing Chrome hangs.
  for (const ch of children.splice(0)) if (ch.exitCode === null) ch.kill('SIGTERM');
  if (browserCtx) {
    try { await browserCtx.close(); } catch {}
    fs.rmSync(UDD, { recursive: true, force: true });
    browserCtx = null;
  }
}

// ── the human side, scripted (check only) ──────────────────────────────────────

async function openPanel(page) {
  if (!(await page.getByText('Agent access for this tab').isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'AGENT ACCESS', exact: true }).click();
  }
}

async function grant(page, tools) {
  await openPanel(page);
  for (const t of tools) await page.getByRole('checkbox', { name: t }).check();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}

async function setAccess(page, on) {
  await openPanel(page);
  const toggle = page.getByRole('button', { name: on ? 'OFF' : 'ON', exact: true });
  if (!(await toggle.count())) return; // already in that state
  await toggle.click();
  if (!on) await page.getByRole('button', { name: 'Turn off', exact: true }).click();
}

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}

async function check() {
  const page = await up();
  const step = (ok, msg) => { console.log(`${ok ? c.green('✓') : c.red('✗')} ${msg}`); if (!ok) throw new Error(msg); };
  try {
    await setAccess(page, true);
    step(listTools().length === 0, 'fresh tab exposes 0 tools');
    await grant(page, GRANTS);
    await until(() => GRANTS.every((g) => listTools().includes(g)), 10_000, 'granted tools to appear');
    step(true, `agent sees granted tools: ${listTools().join(', ')}`);
    const r = invoke('get_spending_summary', SUMMARY_ARGS);
    step(r.ok, `get_spending_summary ok${r.ok ? '' : `: ${r.error}`}`);
    const items = printSummary(r.result);
    step(items.length > 0, `${items.length} categories returned`);
    await setAccess(page, false);
    await until(() => listTools().length === 0, 10_000, 'tools to disappear after Access OFF');
    step(true, 'Access OFF: agent sees 0 tools');
    const after = invoke('get_spending_summary', SUMMARY_ARGS);
    step(!after.ok && after.code === 'webmcp_tool_not_found', `next call refused: ${after.code ?? 'it succeeded!'}`);
    await setAccess(page, true);
    console.log(c.green('PREFLIGHT PASSED'));
  } finally {
    await down();
  }
}

// ── on stage ───────────────────────────────────────────────────────────────────

async function stage() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pause = (label) => new Promise((r) => rl.question(c.dim(`\n⏎ ${label}`), r));
  const show = (cmd) => console.log(`\n${c.bold('$')} ${c.bold(cmd)}`);

  await pause('ask the page what tools it offers');
  show('agent-browser webmcp list');
  let tools = listTools();
  console.log(tools.length ? tools.map((t) => `  ${t}`).join('\n') : c.dim('  (none, nothing granted to agents in this tab)'));

  if (!tools.length) {
    console.log(c.dim('\n  → grant get_spending_summary + search_transactions in AGENT ACCESS, then Apply'));
    await until(() => (tools = listTools()).length > 0, 10 * 60_000, 'a grant');
    show('agent-browser webmcp list');
    console.log(tools.map((t) => `  ${c.green(t)}`).join('\n'));
  }

  await pause('call get_spending_summary');
  show(`agent-browser webmcp invoke get_spending_summary --params '${JSON.stringify(SUMMARY_ARGS)}'`);
  const r = invoke('get_spending_summary', SUMMARY_ARGS);
  if (r.ok) printSummary(r.result); else console.log(c.red(`  ✗ ${r.code}: ${r.error}`));

  console.log(c.dim('\n  → now flip Agent access OFF in the page (Turn off)'));
  await until(() => listTools().length === 0, 10 * 60_000, 'Access OFF');
  await pause('the agent tries again');
  show(`agent-browser webmcp invoke get_spending_summary --params '${JSON.stringify(SUMMARY_ARGS)}'`);
  const after = invoke('get_spending_summary', SUMMARY_ARGS);
  console.log(after.ok ? c.red('  it still answered (Access is not off?)') : `\n  ${c.red(c.bold(`✗ REFUSED  ${after.code}`))}`);
  show('agent-browser webmcp list');
  const left = listTools().length;
  console.log(left ? c.red(`  ${left} tools still exposed`) : c.dim('  (none, the tool is no longer exposed)'));
  console.log(c.dim(`\n  another run: node demos/live/webmcp-live.mjs reset`));
  rl.close();
}

// ── between runs: back to a fresh tab without restarting `up` ──────────────────

async function reset() {
  const { chromium } = await import('playwright');
  // Attach to `up`'s Chrome and never close it: the process exits and only the CDP socket drops.
  const browser = await chromium.connectOverCDP(`http://localhost:${CDP}`);
  const page = browser.contexts().flatMap((ctx) => ctx.pages()).find((p) => p.url().startsWith(URL_));
  if (!page) throw new Error(`no dashboard tab at ${URL_}; is \`up\` running?`);
  await page.bringToFront();
  // OFF then ON revokes any grant left over from a half-finished run.
  await setAccess(page, false);
  await setAccess(page, true);
  await until(() => listTools().length === 0, 10_000, 'tools to clear');
  console.log(`${c.green('RESET')} access ON, 0 tools granted; run \`stage\` again`);
}

// ── main ───────────────────────────────────────────────────────────────────────

const main = { up: async () => { await up(); await new Promise(() => {}); }, stage, check, reset }[mode];
if (!main) { console.error(`unknown mode ${mode}: use up | stage | check | reset`); process.exit(2); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await down(); process.exit(130); });
main().then(() => process.exit(0), async (e) => { console.error(c.red(`✗ ${e.message}`)); await down(); process.exit(1); });
