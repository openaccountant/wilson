// Beat b5-propose: "It proposes, you decide".
//
//  preState (unrecorded): import the two September statements through the REAL Transactions -> Import statement
//    dialog, then run /categorize in Chat with the local Ollama model and wait for it to finish. Then check, from the
//    real Transactions tab, that a leftover target (Brightwell Pharmacy, else Kiln & Co Studio, else Amazon) is still uncategorized. If it is not, the beat stops: we do not
//    fake the starting state.
//  humanScript (recorded): grant three tools to THIS tab through the real Agent access panel, wait for the agent's
//    confirmation card, read it, hold Approve (or click Reject with opts.decision = "deny"), then show the ledger row.
//
// The AGENT side (an external client calling transaction_search / categorize_transaction through WebMCP) is not part
// of this file. The human script only REACTS to what appears in the DOM.
export const meta = {
  id: 'b5-propose',
  title: 'It proposes, you decide',
  needsAgent: true,
  agentTools: ['transaction_search', 'spending_summary', 'categorize_transaction'],
  expectedStates: [
    'ledger-before: Transactions, search for the target merchant, row shows Uncategorized',
    'grants-applied: bridge panel shows 3 tools live in this tab (granted on camera)',
    'card-shown: confirmation card with the exact bank row and before/after (Uncategorized -> category)',
    'approve-held: Hold to approve in progress (fill)',
    'card-resolved: outcome text on the card',
    'ledger-after: the target row now carries the new category',
  ],
};

const TOOLS = ['categorize_transaction', 'transaction_search', 'spending_summary'];
// Leftover merchants, in order of preference. The target is whichever is REALLY still uncategorized after /categorize
// on the real ledger (a local model may confidently categorize Brightwell; then the beat honestly uses the next one).
const CANDIDATES = [
  { id: 'brightwell', search: 'Brightwell', card: 'BRIGHTWELL PHARMACY', amount: '38.47' },
  { id: 'kiln', search: 'Kiln', card: 'KILN & CO STUDIO', amount: '240.00' },
  { id: 'amzn', search: 'AMZN', card: 'AMZN MKTP', amount: '73.22' },
];
let TARGET = null;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowRe = () => new RegExp(esc(TARGET.card.split(' ')[0]), 'i');
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

async function targetRow(page, cand) {
  const search = page.getByPlaceholder('Search by merchant or description...');
  await search.fill('');
  await search.fill(cand.search);
  const row = page.locator('tr[data-tx-id]', { hasText: new RegExp(esc(cand.card.split(' ')[0]), 'i') }).first();
  await row.waitFor({ timeout: 20000 });
  return row;
}

export async function preState(page, ctx) {
  const { log, paths } = ctx;
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
  if (/batch errors? occurred/i.test(reply)) throw new Error(`precondition failed: /categorize reported batch errors, so the target would be left over by a crash, not by Review: ${tail}`);

  // Precondition, from the real ledger: pick the first candidate that is still uncategorized.
  await ctx.gotoTab('Transactions');
  const wanted = ctx.opts.target ? CANDIDATES.filter((c) => c.id === ctx.opts.target) : CANDIDATES;
  const seen = [];
  for (const cand of wanted) {
    const row = await targetRow(page, cand);
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    seen.push(text);
    if (/Uncategorized/.test(text)) { TARGET = cand; log('target-before', { target: cand.id, row: text, considered: seen }); break; }
  }
  if (!TARGET) throw new Error(`precondition failed: none of the candidate rows is left uncategorized: ${JSON.stringify(seen)}`);
}

async function readCard(card) {
  return (await card.innerText()).replace(/\s+/g, ' ').trim();
}

/**
 * What a careful human checks before holding Approve on a CHANGE card: it must be about the target row (merchant and
 * amount on the card), and move Category from Uncategorized to a real category. Returns a list of problems.
 */
export async function checkChangeCard(card) {
  const text = await readCard(card);
  const problems = [];
  if (!text.toUpperCase().includes(TARGET.card)) problems.push(`card does not name ${TARGET.card}`);
  const amtRe = new RegExp('\\$\\s?' + esc(TARGET.amount).replace(/\\\.00$/, '(\\.00)?') + '(?![0-9])');
  if (!amtRe.test(text)) problems.push(`card does not show the $${TARGET.amount} amount`);
  const rows = await card.locator('table tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim())));
  const cat = rows.find((r) => /categor/i.test(r[0] ?? ''));
  if (!cat) problems.push(`card has no Category change row (rows: ${JSON.stringify(rows)})`);
  else {
    if (!/^uncategorized$/i.test(cat[1] ?? '')) problems.push(`Category "before" is ${JSON.stringify(cat[1])}, expected Uncategorized`);
    if (!cat[2] || /^uncategorized$/i.test(cat[2])) problems.push(`Category "after" is ${JSON.stringify(cat[2])}, expected a real category`);
  }
  return { text, rows, problems };
}

export async function humanScript(page, ctx) {
  const { h, log } = ctx;
  if (!TARGET) {
    // humanScript run without this process's preState: find the target from the real ledger, same rule.
    await ctx.gotoTab('Transactions');
    for (const cand of ctx.opts.target ? CANDIDATES.filter((c) => c.id === ctx.opts.target) : CANDIDATES) {
      if (/Uncategorized/.test(await (await targetRow(page, cand)).innerText())) { TARGET = cand; break; }
    }
    if (!TARGET) throw new Error('no uncategorized candidate row in the ledger');
  }
  const decision = ctx.opts.decision === 'deny' ? 'deny' : 'approve';

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
  if (!/Uncategorized/.test(await row.innerText())) throw new Error(`beat precondition failed: ${TARGET.card} is not uncategorized`);
  await h.moveTo(row, { dx: 60 });
  await h.pause(900);
  log('ledger-before', { row: (await row.innerText()).replace(/\s+/g, ' ') }, { keyframe: true });
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

  // 3. Wait for the agent's confirmation card(s). Read cards are Ask-able too, so react to each in turn.
  for (let i = 0; i < 8; i++) {
    const card = page.locator(CARD).first();
    await card.waitFor({ timeout: 10 * 60_000 });
    await h.pause(1800); // the card arms after 800 ms; give a viewer time to read it
    const text = await readCard(card);
    // A read card's button says "Hold to allow"; anything else is a change card and must pass the content check.
    const isRead = (await card.getByRole('button', { name: /Hold to allow/ }).count()) > 0;
    const isChange = !isRead;
    log('card-shown', { index: i, change: isChange, text: text.slice(0, 700) }, { keyframe: isChange });
    await h.moveTo(card, { settle: 2200 });
    if (isChange) {
      const check = await checkChangeCard(card);
      log('card-checked', { index: i, rows: check.rows, problems: check.problems });
      if (check.problems.length) {
        await h.click(card.getByRole('button', { name: /Reject/ }), { pause: 300 });
        log('reject-clicked', { index: i, reason: 'card content did not match the beat' });
        throw new Error(`refusing to approve an unexpected card: ${check.problems.join('; ')} | card text: ${check.text.slice(0, 500)}`);
      }
    }
    if (decision === 'deny' && isChange) {
      await h.click(card.getByRole('button', { name: /Reject/ }), { pause: 300 });
      log('reject-clicked', { index: i, reason: 'opts.decision=deny' });
    } else {
      const approve = card.getByRole('button', { name: /Hold to (approve|allow)/ });
      await approve.waitFor({ timeout: 10000 });
      await h.hold(approve, 1200, {
        onDown: async () => { log('approve-pressed', { index: i }); await h.pause(500); log('approve-held', { index: i }, { keyframe: isChange }); },
        onUp: async () => { log('approve-released', { index: i }); },
      });
    }
    await h.pause(900);
    const outcome = await card.innerText().catch(() => '(card gone)');
    log('card-resolved', { index: i, outcome: outcome.replace(/\s+/g, ' ').slice(0, 200) }, { keyframe: isChange });
    if (isChange) break;
    await h.pause(2800); // a read card clears itself; the agent's next call may bring the change card
  }

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
  log('ledger-after', { decision, row: (await after.innerText()).replace(/\s+/g, ' ') }, { keyframe: true });
  await h.pause(2800);
  log('beat-end');
}
