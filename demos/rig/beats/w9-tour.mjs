// Beat w9-tour: "Agent access center tour". Human-only, no agent. Everything on screen is the real Settings -> Agent
// access center and the real bridge panel; nothing is toggled (the kill switch is only pointed at).
export const meta = {
  id: 'w9-tour',
  title: 'Agent access: zero tools, kill switch, audit log',
  needsAgent: false,
  expectedStates: [
    'overview-start: the real Overview tab, signed in as the admin, before any agent access',
    'bridge-zero-tools: bridge panel "Agent access for this tab" reads "0 tools live in this tab · 0 pending"',
    'kill-switch: Settings -> Agent access, kill switch ON, "0 tools live in this tab"',
    'tool-table: every tool row shows "Grant to this tab" (none granted)',
    'audit-log: Activity expanded, "No agent activity yet."',
  ],
};

export async function preState() {
  // Nothing to set up: the seeded profile has agent access on, zero grants, empty audit log.
}

export async function humanScript(page, ctx) {
  const { h, log } = ctx;
  const must = (cond, msg) => { if (!cond) throw new Error('beat precondition failed: ' + msg); };

  await h.pause(1800);
  log('overview-start', {}, { keyframe: true });
  await h.pause(1200);

  // 1. The bridge panel (bottom-left) for THIS tab.
  const launcher = page.getByRole('button', { name: /agent access/i }).filter({ hasText: /AGENT ACCESS/ });
  await h.click(launcher, { pause: 900 });
  const panel = page.getByText('Agent access for this tab');
  await panel.waitFor({ timeout: 10000 });
  await page.getByText(/0 tools live in this tab · 0 pending/).waitFor({ timeout: 10000 });
  const wm = await page.evaluate(async () => {
    const mc = document.modelContext;
    if (!mc) return { modelContext: false };
    const tools = typeof mc.getTools === 'function' ? await mc.getTools() : null;
    return { modelContext: true, toolCount: tools ? tools.length : null };
  });
  must(wm.modelContext, 'document.modelContext missing (WebMCPTesting not enabled)');
  must(wm.toolCount === 0 || wm.toolCount === null, `expected zero WebMCP tools exposed, saw ${wm.toolCount}`);
  await h.pause(900);
  log('bridge-zero-tools', { webmcp: wm }, { keyframe: true });
  await h.pause(2200);
  await h.click(launcher, { pause: 700 }); // close the panel

  // 2. Settings -> Agent access.
  await ctx.gotoTabHuman('Settings');
  const center = page.getByTestId('agent-access-center');
  await center.waitFor({ timeout: 20000 });
  await center.scrollIntoViewIfNeeded();
  await h.scroll(0);
  const kill = page.getByTestId('agent-kill-switch');
  await h.moveTo(kill, { dx: -120 });
  await kill.getByText(/0 tools live in this tab/).waitFor({ timeout: 10000 });
  must(await kill.getByRole('switch').getAttribute('aria-checked') === 'true', 'kill switch expected ON (agent access enabled)');
  await h.pause(900);
  log('kill-switch', { on: true }, { keyframe: true });
  await h.pause(2000);
  await h.moveTo(kill.getByRole('switch'), { settle: 1400 }); // point at it; do not press

  // 3. The per-tool policy table: nothing granted.
  const table = page.getByTestId('agent-tool-policies');
  await h.moveTo(table.locator('> div').nth(1));
  const grantable = await table.getByRole('button', { name: 'Grant to this tab' }).count();
  const granted = await table.getByText('Granted', { exact: true }).count();
  must(grantable > 0 && granted === 0, `expected only Grant buttons, got grantable=${grantable} granted=${granted}`);
  await h.pause(900);
  log('tool-table', { grantButtons: grantable, granted }, { keyframe: true });
  await h.pause(1500);
  await h.scroll(280, { ms: 1100 });
  await h.pause(1400);

  // 4. The audit log.
  const activity = page.getByTestId('agent-activity');
  await activity.scrollIntoViewIfNeeded();
  await h.click(activity.getByRole('button').first(), { pause: 700 });
  await activity.getByText('No agent activity yet.').waitFor({ timeout: 10000 });
  await h.pause(900);
  log('audit-log', { empty: true }, { keyframe: true });
  await h.pause(2500);
  log('tour-end');
}
