// Beat b5-propose: "It proposes, you decide".
//
//  The target is EXPLICIT: opts.target (default "SQ *KILN & CO STUDIO", -$240.00 on Sep 22), the row that genuinely stays
//  uncategorized after Wilson's own /categorize because it is ambiguous (business or personal?). There is no fallback to
//  some other merchant: if /categorize crashed with batch errors, or the target is not uncategorized afterwards, the
//  preState FAILS and nothing is recorded.
//
//  preState (unrecorded): import the two September statements through the REAL Transactions -> Import statement
//    dialog, then run /categorize in Chat with the local Ollama model and wait for it to finish.
//  humanScript (recorded): grant three tools to THIS tab through the real Agent access panel, wait for the agent's
//    confirmation card, READ it, and only then act. A change card must be categorize_transaction, name the target
//    description and show -$240.00; anything else is logged and Rejected (never blind-approved). opts.decision
//    'approve' (default) holds Approve; 'deny' clicks Reject and shows "Rejected. Nothing was changed.".
//
// The AGENT side (an external client calling transaction_search / categorize_transaction through WebMCP) is not part
// of this file. The human script only REACTS to what appears in the DOM. The agent chooses the category itself.
export const meta = {
  id: 'b5-propose',
  title: 'It proposes, you decide',
  needsAgent: true,
  agentTools: ['transaction_search', 'spending_summary', 'categorize_transaction'],
  opts: { target: 'SQ *KILN & CO STUDIO (default)', decision: 'approve | deny' },
  expectedStates: [
    'ledger-before: Transactions, September, search for the target; the SQ *KILN & CO STUDIO -$240.00 row shows Uncategorized',
    'grants-applied: bridge panel shows 3 tools live in this tab (granted on camera)',
    'card-shown: confirmation card "Confirm: Categorize Transaction" naming SQ *KILN & CO STUDIO and -$240.00, Category Uncategorized -> the agent\'s chosen category, no unchanged entity_id row',
    'card-read-checked: the human script verified tool, description and amount before acting (events card-checked)',
    'approve-held (decision=approve): Hold to approve in progress',
    'card-resolved: approve -> "Done. The change was applied."; deny -> "Rejected. Nothing was changed."',
    'ledger-after: approve -> the target row carries the agent\'s category; deny -> the target row is still Uncategorized',
  ],
};

const TOOLS = ['categorize_transaction', 'transaction_search', 'spending_summary'];
const READ_TOOLS = new Set(['transaction_search', 'spending_summary']);
const DEFAULT_TARGET = 'SQ *KILN & CO STUDIO';
const AMOUNT = '-$240.00';
let TARGET = null;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (x) => x.replace(/\s+/g, ' ').trim().toUpperCase();
function targetFrom(opts) {
  const description = String(opts.target ?? DEFAULT_TARGET);
  // Search on the merchant words after any "SQ *" style processor prefix; the row is still matched on the full text.
  const search = description.replace(/^[^*]*\*/, '').trim() || description;
  return { description, search, amount: AMOUNT };
}
const rowRe = () => new RegExp(esc(TARGET.description).replace(/\s+/g, '\\s+'), 'i');
const CARD = '[data-card-id], [data-testid="agent-approval-card"]';

async function importStatement(page, file, label, log) {
  await page.getByRole('button', { name: 'Import statement' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor({ timeout: 10000 });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByText('Drop a bank statement here').click(),
  ]);
  await chooser.setFiles(file);
  await dialog.getByText('Net total').waitFor({ timeout: 15000 });
  const rows = await dialog.getByText('Transactions', { exact: true }).locator('xpath=following-sibling::div').first().innerText();
  await dialog.getByRole('button', { name: 'Import to database' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
  const banner = await page.locator('div.border-green-700\\/50').first().innerText().catch(() => '');
  log('imported', { statement: label, parsedRows: rows, banner: banner.slice(0, 200) });
}

async function targetRow(page) {
  const search = page.getByPlaceholder('Search by merchant or description...');
  await search.fill('');
  await search.fill(TARGET.search);
  const row = page.locator('tr[data-tx-id]', { hasText: rowRe() }).first();
  await row.waitFor({ timeout: 20000 });
  return row;
}

export async function preState(page, ctx) {
  const { log, paths } = ctx;
  TARGET = targetFrom(ctx.opts);
  await ctx.gotoTab('Transactions');
  await page.getByRole('heading', { name: 'Transactions' }).waitFor();
  await importStatement(page, paths.csv.checking, 'checking-2026-09.csv', log);
  await importStatement(page, paths.csv.card, 'card-2026-09.csv', log);

  // /categorize in Chat (local Ollama). Typing the command is the consent; the tab shows live progress.
  await ctx.gotoTab('Chat');
  const box = page.getByLabel('Message Wilson');
  await box.click();
  await box.fill('/categorize');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('textarea[aria-label="Message Wilson"][readonly]').waitFor({ timeout: 30000 });
  log('categorize-started', { model: 'local ollama (settings.json modelId)' });
  await page.locator('textarea[aria-label="Message Wilson"]:not([readonly])').waitFor({ timeout: 25 * 60_000 });
  const reply = (await page.locator('main, body').first().innerText()).slice(-1500);
  const tail = reply.replace(/\s+/g, ' ').slice(-600);
  log('categorize-done', { tail: tail.slice(-400) });
  if (/batch errors? occurred/i.test(reply)) throw new Error(`precondition failed: /categorize reported "batch errors occurred", so the target could be left over by a crash rather than by Review: ${tail}`);

  // Precondition, from the real ledger: THE target (no fallback) must be uncategorized.
  await ctx.gotoTab('Transactions');
  const row = await targetRow(page).catch((e) => { throw new Error(`precondition failed: target row ${TARGET.description} not found in the ledger: ${e.message}`); });
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  if (!/Uncategorized/.test(text)) throw new Error(`precondition failed: ${TARGET.description} is not uncategorized after /categorize: ${text}`);
  if (!text.includes('240.00')) throw new Error(`precondition failed: target row is not the $240.00 charge: ${text}`);
  log('target-before', { target: TARGET.description, row: text });
}

async function readCard(card) {
  return (await card.innerText()).replace(/\s+/g, ' ').trim();
}

/** The card's heading, read from its own text ("Confirm: Categorize Transaction" / "Allow read: Transaction Search"), before the close button or the requester line. */
export function headingOf(text) {
  return /^((?:Confirm|Allow read):\s*.+?)\s*(?:×|Requested by:)/i.exec(text)?.[1] ?? '';
}

/** "Confirm: Categorize Transaction" -> categorize_transaction; "Allow read: Transaction Search" -> transaction_search. */
export function toolFromHeading(heading) {
  const title = heading.replace(/^(Confirm|Allow read):\s*/i, '').trim();
  return title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * What a careful human checks before holding Approve on a CHANGE card. Returns {tool, text, rows, problems}:
 * the tool must be categorize_transaction, the card must name the target description and show -$240.00, and Category
 * must move from Uncategorized to some real category (the agent's own choice).
 */
export async function checkChangeCard(card) {
  const text = await readCard(card);
  const heading = headingOf(text);
  const tool = toolFromHeading(heading);
  const problems = [];
  if (tool !== 'categorize_transaction') problems.push(`card is for tool ${JSON.stringify(tool)} (heading ${JSON.stringify(heading)}), expected categorize_transaction`);
  if (!norm(text).includes(norm(TARGET.description))) problems.push(`card text does not contain ${TARGET.description}`);
  if (!text.includes(TARGET.amount)) problems.push(`card text does not contain ${TARGET.amount}`);
  const rows = await card.locator('table tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim())));
  const cat = rows.find((r) => /^categor/i.test(r[0] ?? ''));
  if (!cat) problems.push(`card has no Category change row (rows: ${JSON.stringify(rows)})`);
  else {
    if (!/^uncategorized$/i.test(cat[1] ?? '')) problems.push(`Category "before" is ${JSON.stringify(cat[1])}, expected Uncategorized`);
    if (!cat[2] || /^(uncategorized|—)$/i.test(cat[2])) problems.push(`Category "after" is ${JSON.stringify(cat[2])}, expected a real category`);
  }
  return { tool, heading, text, rows, problems };
}

export async function humanScript(page, ctx) {
  const { h, log } = ctx;
  TARGET = targetFrom(ctx.opts);
  const decision = ctx.opts.decision === 'deny' ? 'deny' : ctx.opts.decision === undefined || ctx.opts.decision === 'approve' ? 'approve' : null;
  if (!decision) throw new Error(`opts.decision must be "approve" or "deny", got ${JSON.stringify(ctx.opts.decision)}`);
  let chosenCategory = null;

  // 1. The ledger before.
  await h.pause(1200);
  await ctx.gotoTabHuman('Transactions');
  await page.getByRole('heading', { name: 'Transactions' }).waitFor();
  await h.type(page.getByPlaceholder('Search by merchant or description...'), TARGET.search, { delay: 70, pause: 700 });
  const row = page.locator('tr[data-tx-id]', { hasText: rowRe() }).first();
  // A fresh tab opens on the current month (October); the September statements live one month back.
  if (!(await row.waitFor({ timeout: 3000 }).then(() => true, () => false))) {
    await h.click(page.getByRole('button', { name: '←' }), { pause: 900 });
  }
  await row.waitFor({ timeout: 20000 });
  const rowBefore = (await row.innerText()).replace(/\s+/g, ' ');
  if (!/Uncategorized/.test(rowBefore) || !rowBefore.includes('240.00')) throw new Error(`beat precondition failed: ${TARGET.description} (240.00) is not uncategorized: ${rowBefore}`);
  await h.moveTo(row, { dx: 60 });
  await h.pause(900);
  log('ledger-before', { row: rowBefore }, { keyframe: true });
  await h.pause(1500);

  // 2. Grant three tools to this tab through the real Agent access panel.
  const launcher = page.getByRole('button').filter({ hasText: /AGENT ACCESS/ });
  await h.click(launcher, { pause: 800 });
  await page.getByText('Agent access for this tab').waitFor({ timeout: 10000 });
  for (const tool of TOOLS) {
    const line = page.locator('label').filter({ has: page.getByText(tool, { exact: true }) });
    await h.click(line.locator('input[type=checkbox]'), { pause: 450 });
  }
  const apply = page.getByRole('button', { name: 'Apply', exact: true }).last(); // the bridge panel's; the filter form has one too
  await h.pause(700);
  await h.click(apply, { pause: 500 });
  await page.getByText(/3 tools live in this tab/).waitFor({ timeout: 15000 });
  await h.pause(700);
  log('grants-applied', { tools: TOOLS }, { keyframe: true });
  await h.pause(1600);
  await h.click(launcher, { pause: 700 }); // close the panel so the card has the room

  // 3. Wait for the agent's confirmation card(s). Read each BEFORE acting; never blind-approve.
  const reject = async (card, i, reason, extra = {}) => {
    log('card-unexpected', { index: i, reason, ...extra });
    const btn = card.getByRole('button', { name: /Reject|Don't allow/ });
    await h.click(btn, { pause: 300 });
    log('reject-clicked', { index: i, reason });
    rejectedOther++;
    await h.pause(1500);
  };
  // The agent chooses its own proposals. A card that is not the target change is rejected (never approved) and the
  // human keeps waiting for the agent's next proposal; only a take with no resolved target card fails.
  let rejectedOther = 0;
  for (let i = 0; i < 8; i++) {
    const card = page.locator(CARD).first();
    await card.waitFor({ timeout: rejectedOther ? 150_000 : 10 * 60_000 }).catch((e) => {
      if (rejectedOther) throw new Error(`the agent proposed ${rejectedOther} other change(s), which were rejected, and then never proposed the target ${TARGET.description}: ${e.message}`);
      throw e;
    });
    await h.pause(1800); // the card arms after 800 ms; give a viewer time to read it
    const text = await readCard(card);
    const heading = headingOf(text);
    const isRead = (await card.getByRole('button', { name: /Hold to allow/ }).count()) > 0;
    const tool = toolFromHeading(heading);
    log('card-shown', { index: i, tool, change: !isRead, text: text.slice(0, 700) }, { keyframe: !isRead });
    await h.moveTo(card, { settle: 2200 });
    if (isRead) {
      // A read card is allowed only for a tool we granted that is read-only.
      if (!READ_TOOLS.has(tool)) { await reject(card, i, `read card for unexpected tool ${JSON.stringify(tool)}`, { text }); continue; }
      log('card-checked', { index: i, tool, kind: 'read', problems: [] });
      const allow = card.getByRole('button', { name: /Hold to allow/ });
      await allow.waitFor({ timeout: 10000 });
      await h.hold(allow, 1200, { onDown: async () => { log('allow-pressed', { index: i }); }, onUp: async () => { log('allow-released', { index: i }); } });
      await h.pause(900);
      log('card-resolved', { index: i, kind: 'read', tool });
      await h.pause(2800); // a read card clears itself; the agent's next call may bring the change card
      continue;
    }
    const check = await checkChangeCard(card);
    log('card-checked', { index: i, tool: check.tool, kind: 'change', rows: check.rows, problems: check.problems });
    if (check.problems.length) { await reject(card, i, check.problems.join('; '), { text: check.text }); continue; }
    chosenCategory = check.rows.find((r) => /^categor/i.test(r[0] ?? ''))?.[2] ?? null;

    if (decision === 'deny') {
      await h.click(card.getByRole('button', { name: /Reject/ }), { pause: 100 });
      log('reject-clicked', { index: i, reason: 'opts.decision=deny' });
      await page.getByText('Rejected. Nothing was changed.').first().waitFor({ timeout: 8000 });
      await h.pause(400);
      log('card-resolved', { index: i, decision, outcome: 'Rejected. Nothing was changed.' }, { keyframe: true });
      await h.pause(1200);
    } else {
      const approve = card.getByRole('button', { name: /Hold to approve/ });
      await approve.waitFor({ timeout: 10000 });
      await h.hold(approve, 1200, {
        onDown: async () => { log('approve-pressed', { index: i }); await h.pause(500); log('approve-held', { index: i }, { keyframe: true }); },
        onUp: async () => { log('approve-released', { index: i }); },
      });
      await page.getByText('Done. The change was applied.').first().waitFor({ timeout: 8000 });
      await h.pause(300);
      log('card-resolved', { index: i, decision, outcome: 'Done. The change was applied.' }, { keyframe: true });
      await h.pause(1200);
    }
    break;
  }
  if (chosenCategory === null) throw new Error(`no change card for the target was resolved (${rejectedOther} other card(s) rejected)`);

  // 4. The ledger after: switch away and back so the Transactions tab refetches, then show the row.
  await h.pause(2600);
  await ctx.gotoTabHuman('Overview');
  await h.pause(500);
  await ctx.gotoTabHuman('Transactions');
  const search = page.getByPlaceholder('Search by merchant or description...');
  if ((await search.inputValue()) !== TARGET.search) await h.type(search, TARGET.search, { delay: 60, pause: 500 });
  const after = page.locator('tr[data-tx-id]', { hasText: rowRe() }).first();
  await after.waitFor({ timeout: 20000 });
  if (decision === 'approve') {
    await page.waitForFunction((src) => {
      const re = new RegExp(src, 'i');
      const r = [...document.querySelectorAll('tr[data-tx-id]')].find((x) => re.test(x.textContent || ''));
      return r && !/Uncategorized/.test(r.textContent || '');
    }, rowRe().source, { timeout: 20000 });
  }
  await h.moveTo(after, { dx: 60 });
  await h.pause(900);
  const rowAfter = (await after.innerText()).replace(/\s+/g, ' ');
  if (decision === 'deny' && !/Uncategorized/.test(rowAfter)) throw new Error(`deny must leave the row uncategorized, got: ${rowAfter}`);
  if (decision === 'approve' && !rowAfter.toLowerCase().includes(String(chosenCategory).toLowerCase())) throw new Error(`row does not carry the approved category ${chosenCategory}: ${rowAfter}`);
  log('ledger-after', { decision, category: chosenCategory, row: rowAfter }, { keyframe: true });
  await h.pause(2800);
  log('beat-end');
}
