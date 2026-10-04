// Beat b9-kill: "And you can take it back." One switch, and the agent's next call fails.
//
//  preState (unrecorded): the same September as beat 5: import the two statements through the real Transactions ->
//    Import statement dialog, then /categorize in Chat on the local Ollama model.
//  humanScript (recorded), all on the real Settings -> Agent access center:
//    1. grant two read tools to this tab from the tool table (on camera);
//    2. wait for the agent's first call to land in the product's own audit log (GET /api/mcp/audit, the rows the
//       Activity section renders), never a fixed sleep;
//    3. flip the kill switch and confirm "Turn off" in the real dialog; check the switch reads OFF and no tool is granted;
//    4. wait for the agent to finish on its own, then open Activity and show every agent call the server recorded.
//  After the actor exits, the agent's own calls after the kill are read from the take's ab-audit.jsonl (the wrapper's
//  record, written by the harness) and logged verbatim as `agent-after-kill`, so the cut can quote what really failed.
//
// The AGENT side (claude -p through rig/bin/ab-agent) is not part of this file; its brief is b9-kill.brief.md. Nothing
// here tells the agent about the switch or reacts to what it says.
import fs from 'node:fs';
import path from 'node:path';
import { importStatement } from './b5-propose.mjs';

export const meta = {
  id: 'b9-kill',
  title: 'And you can take it back',
  needsAgent: true,
  agentTools: ['transaction_search', 'spending_summary'],
  actorTimeoutS: 420,
  expectedStates: [
    'settings-before: Settings -> Agent access, kill switch ON, "0 tools live in this tab"',
    'grants-applied: transaction_search and spending_summary show Granted in the tool table, "2 tools live in this tab" (granted on camera)',
    'agent-call-seen: the server audit log has the agent\'s first allowed call (tool, decision, args preview)',
    'kill-confirm: the real "Turn off agent access?" dialog is open',
    'kill-switch-off: the switch reads OFF, "Agent access is off. No tools are exposed to any agent or MCP client.", no tool Granted',
    'activity-after: Activity expanded after the agent exited, listing the calls the server recorded',
    'agent-after-kill: the agent\'s commands after the flip, verbatim from ab-audit.jsonl; the first invoke after it failed',
  ],
};

const TOOLS = ['transaction_search', 'spending_summary'];
const AUDIT_POLL_MS = 2500; // /api/mcp/audit allows 30 requests a minute per user
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export async function preState(page, ctx) {
  const { log, paths } = ctx;
  await ctx.gotoTab('Transactions');
  await page.getByRole('heading', { name: 'Transactions' }).waitFor();
  await importStatement(page, paths.csv.checking, 'checking-2026-09.csv', log);
  await importStatement(page, paths.csv.card, 'card-2026-09.csv', log);

  await ctx.gotoTab('Chat');
  const box = page.getByLabel('Message Wilson');
  await box.click();
  await box.fill('/categorize');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('textarea[aria-label="Message Wilson"][readonly]').waitFor({ timeout: 30000 });
  log('categorize-started', { model: 'local ollama (settings.json modelId)' });
  await page.locator('textarea[aria-label="Message Wilson"]:not([readonly])').waitFor({ timeout: 25 * 60_000 });
  const tail = oneLine((await page.locator('main, body').first().innerText()).slice(-1500)).slice(-400);
  log('categorize-done', { tail });

  // /api/mcp/state needs the tab's agent-session header, so the precondition is read from the real Settings page.
  await ctx.gotoTab('Settings');
  const kill = page.getByTestId('agent-kill-switch');
  await kill.waitFor({ timeout: 20000 });
  if (await kill.getByRole('switch').getAttribute('aria-checked') !== 'true') throw new Error('precondition failed: agent access is not on');
  await kill.getByText(/0 tools live in this tab/).waitFor({ timeout: 10000 }).catch(() => { throw new Error('precondition failed: a tool is already granted before the beat'); });
}

/** The server's audit rows (newest first), as the Activity section gets them. */
async function auditRows(ctx) {
  const r = await ctx.api('/api/mcp/audit?limit=50');
  if (r.status === 429) return null; // rate limited: try again on the next poll
  if (r.status !== 200) throw new Error(`GET /api/mcp/audit failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.entries ?? [];
}

/**
 * The agent's commands from the take's ab-audit.jsonl that FINISHED at or after `sinceMs` (wall clock), verbatim. A call
 * that was already in flight when the switch was pressed is included, with `startedBeforeMs` > 0 saying by how much.
 */
export function agentCallsSince(auditText, sinceMs) {
  const out = [];
  for (const line of auditText.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (Date.parse(r.endTs ?? r.ts) < sinceMs) continue;
    const firstLine = (s) => oneLine(String(s ?? '').split('\n').find((l) => l.trim()) ?? '');
    out.push({ ts: r.ts, endTs: r.endTs, startedBeforeMs: Math.max(0, sinceMs - Date.parse(r.ts)), argv: r.argv, command: (r.argv ?? []).slice(0, 3).join(' '), exitCode: r.exitCode, stdout: firstLine(r.stdout).slice(0, 240), stderr: firstLine(r.stderr).slice(0, 240) });
  }
  return out;
}

export async function humanScript(page, ctx) {
  const { h, log } = ctx;
  const must = (cond, msg) => { if (!cond) throw new Error('beat precondition failed: ' + msg); };

  // 1. Settings -> Agent access: the switch is on, nothing is granted yet.
  await h.pause(1200);
  await ctx.gotoTabHuman('Settings');
  const center = page.getByTestId('agent-access-center');
  await center.waitFor({ timeout: 20000 });
  const kill = page.getByTestId('agent-kill-switch');
  const sw = kill.getByRole('switch');
  await kill.scrollIntoViewIfNeeded();
  await h.moveTo(kill, { dx: -200 });
  await kill.getByText(/0 tools live in this tab/).waitFor({ timeout: 10000 });
  must(await sw.getAttribute('aria-checked') === 'true', 'kill switch expected ON (agent access enabled)');
  log('settings-before', { on: true, live: 0 }, { keyframe: true });
  await h.pause(1200);

  // 2. Grant the two read tools from the table, on camera.
  const table = page.getByTestId('agent-tool-policies');
  for (const tool of TOOLS) {
    const row = table.locator(':scope > div').filter({ has: page.getByText(tool, { exact: true }) });
    await h.click(row.getByRole('button', { name: 'Grant to this tab' }), { pause: 500 });
    await row.getByText('Granted', { exact: true }).waitFor({ timeout: 10000 });
  }
  await kill.getByText(/2 tools live in this tab/).waitFor({ timeout: 15000 });
  await h.pause(600);
  log('grants-applied', { tools: TOOLS }, { keyframe: true });

  // 3. Wait for the agent's first call to reach the server's audit log, then take it back. The pointer rests near the
  //    switch while the agent works; it is pressed only once a real call is on record.
  await h.moveTo(sw, { dx: -90, settle: 300 });
  const baseline = new Set(((await auditRows(ctx)) ?? []).map((e) => e.id));
  let first = null;
  const t0 = Date.now();
  while (!first) {
    if (Date.now() - t0 > 5 * 60_000) throw new Error('the agent made no call the server recorded within 5 minutes');
    if (await ctx.waitEvent('actor-exited', 1)) throw new Error('the agent exited before any call reached the server');
    await h.pause(AUDIT_POLL_MS);
    const rows = await auditRows(ctx);
    if (!rows) continue;
    first = rows.filter((e) => !baseline.has(e.id) && TOOLS.includes(e.tool_name)).at(-1) ?? null; // oldest new row
  }
  log('agent-call-seen', { tool: first.tool_name, decision: first.decision, auditTs: first.ts, args: first.args_preview }, { keyframe: true });

  await h.click(sw, { pause: 300 });
  const dialog = page.getByRole('dialog').filter({ hasText: 'Turn off agent access?' });
  await dialog.waitFor({ timeout: 10000 });
  log('kill-confirm', { text: oneLine(await dialog.innerText()).slice(0, 300) }, { keyframe: true });
  await h.pause(900);
  // Glide first, then press: kill-clicked marks the press itself, not the start of the pointer's travel.
  await h.moveTo(dialog.getByRole('button', { name: 'Turn off', exact: true }), { settle: 150 });
  await page.mouse.down();
  await h.pause(80);
  await page.mouse.up();
  const pressedAt = Date.now();
  log('kill-clicked');
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-kill-switch"] [role="switch"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 15000 });
  const offText = oneLine(await kill.innerText());
  must(/Agent access is off/.test(offText), `kill switch box does not say agent access is off: ${offText}`);
  const stillGranted = await table.getByText('Granted', { exact: true }).count();
  must(stillGranted === 0, `${stillGranted} tool(s) still show Granted after the switch went off`);
  log('kill-switch-off', { switch: 'OFF', text: offText, granted: stillGranted }, { keyframe: true });
  await h.moveTo(kill, { dx: -200, settle: 400 });

  // 4. The agent carries on by itself; wait for it to finish, then show what the server recorded.
  const exited = await ctx.waitEvent('actor-exited', 8 * 60_000);
  if (!exited) throw new Error('the agent did not exit within 8 minutes of the kill switch');
  const activity = page.getByTestId('agent-activity');
  await h.moveTo(activity, { settle: 300 });
  await h.click(activity.getByRole('button').first(), { pause: 600 });
  await activity.locator(`span[title="${first.tool_name}"]`).first().waitFor({ timeout: 15000 }); // the row's tool cell, not the filter <option>
  await h.pause(600);
  await activity.scrollIntoViewIfNeeded();
  const rows = (await auditRows(ctx)) ?? [];
  const calls = rows.filter((e) => !baseline.has(e.id)).map((e) => ({ tool: e.tool_name, decision: e.decision, ts: e.ts }));
  const afterKill = calls.filter((e) => Date.parse(e.ts) >= pressedAt);
  log('activity-after', { calls: calls.length, beforeKill: calls.length - afterKill.length, afterKill: afterKill.length, afterKillDecisions: afterKill.map((e) => `${e.tool} ${e.decision}`), rows: calls }, { keyframe: true });

  // The agent's side, verbatim from the wrapper's audit (the take's source of truth for its commands).
  const auditFile = exited.takeDir ? path.join(exited.takeDir, 'ab-audit.jsonl') : null;
  if (auditFile && fs.existsSync(auditFile)) {
    const after = agentCallsSince(fs.readFileSync(auditFile, 'utf8'), pressedAt);
    const firstInvoke = after.find((c) => c.argv?.[0] === 'webmcp' && c.argv?.[1] === 'invoke') ?? null;
    log('agent-after-kill', {
      commands: after.length,
      invokes: after.filter((c) => c.argv?.[1] === 'invoke').length,
      failedInvokes: after.filter((c) => c.argv?.[1] === 'invoke' && c.exitCode !== 0).length,
      firstInvoke: firstInvoke ? { command: firstInvoke.command, tool: firstInvoke.argv[2], exitCode: firstInvoke.exitCode, error: firstInvoke.stderr || firstInvoke.stdout, startedBeforeKillMs: firstInvoke.startedBeforeMs, inFlight: firstInvoke.startedBeforeMs > 0 } : null,
      list: after.map((c) => `${c.command} -> exit ${c.exitCode}${c.startedBeforeMs > 0 ? ` (started ${c.startedBeforeMs} ms before the press)` : ''}`),
    });
  } else {
    log('agent-after-kill', { missing: auditFile ?? 'no takeDir on actor-exited' });
  }
  await h.pause(3200); // activity-after hold
  log('beat-end');
}
