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
    'every card the agent raises is read and decided on camera (target approved, any other change Rejected, read cards allowed); no card is pending at beat end',
    'card-shown: confirmation card "Confirm: Categorize Transaction" naming SQ *KILN & CO STUDIO and -$240.00, Category Uncategorized -> the agent\'s chosen category, no unchanged entity_id row',
    'card-read-checked: the human script verified tool, description and amount before acting (events card-checked)',
    'approve-held (decision=approve): Hold to approve in progress',
    'card-resolved: approve -> "Done. The change was applied."; deny -> "Rejected. Nothing was changed."',
    'ledger-after: search cleared; approve -> the target row carries the agent\'s category; deny -> still Uncategorized; every other decided row shown and checked; held 3+ s',
  ],
};

const TOOLS = ['categorize_transaction', 'transaction_search', 'spending_summary'];
const READ_TOOLS = new Set(['transaction_search', 'spending_summary']);
const DEFAULT_TARGET = 'SQ *KILN & CO STUDIO';
const AMOUNT = '-$240.00';
let TARGET = null;
let TARGET_TX = null; // data-tx-id of the target row, read from the ledger; a card is the target only if its #txId equals this
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
export async function checkChangeCard(card, targetTx = TARGET_TX) {
  const text = await readCard(card);
  const heading = headingOf(text);
  const tool = toolFromHeading(heading);
  const problems = [];
  if (tool !== 'categorize_transaction') problems.push(`card is for tool ${JSON.stringify(tool)} (heading ${JSON.stringify(heading)}), expected categorize_transaction`);
  // Identity, not text: the transaction id on the card must be the ledger row we looked at. Description/amount text can be
  // forged by bank text or by the agent's category string, so it is only a sanity check on top of this.
  const ids = [...text.matchAll(/#(\d+)/g)].map((m) => m[1]);
  if (!targetTx) problems.push('no target transaction id recorded from the ledger');
  else if (ids.length === 0 || ids.some((x) => x !== targetTx)) problems.push(`card transaction id(s) ${JSON.stringify(ids)} are not the target row #${targetTx}`);
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
  TARGET_TX = await row.getAttribute('data-tx-id');
  if (!TARGET_TX) throw new Error('target row has no data-tx-id');
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

  // 3. Decide EVERY card the agent raises, on camera, by reading it. Only the beat's target change (categorize_transaction,
  //    the target description, -$240.00, Uncategorized -> a real category) is approved; any other change card is Rejected
  //    (a legitimate "you decide" moment); a read card for a granted read-only tool is allowed. The human keeps waiting
  //    until the actor process has exited (run-beat.sh posts `actor-exited`), then sweeps up any last card. No card may be
  //    left pending at beat end.
  const actorExited = async () => !!(await ctx.waitEvent('actor-exited', 1));
  const OUTCOME_RE = /Done\. The change was applied\.|Rejected\. Nothing was changed\./;
  const decidedIds = new Set();
  /** Snapshot of the cards in the DOM as {id, text}; a card that already shows its outcome (the bridge keeps it ~2.5 s) is not pending. */
  const pendingCards = async () => (await page.locator('[data-card-id]').evaluateAll((ns) => ns.map((n) => ({ id: n.getAttribute('data-card-id'), text: (n.textContent || '').replace(/\s+/g, ' ').trim() })))).filter((c) => c.id && !decidedIds.has(c.id) && !OUTCOME_RE.test(c.text));
  /** Oldest pending card's op id (the DOM lists newest first), or null once the actor has exited and nothing is pending. */
  const nextCard = async () => {
    const t0 = Date.now(); let exitedAt = null;
    for (;;) {
      const p = await pendingCards();
      if (p.length > 0) return p[p.length - 1].id;
      if (await actorExited()) { exitedAt ??= Date.now(); if (Date.now() - exitedAt > 4000) return null; }
      else if (Date.now() - t0 > 12 * 60_000) throw new Error(`no confirmation card for 12 minutes while the agent is still running (${decided.length} decided so far)`);
      await h.pause(400);
    }
  };
  /** Wait for this card to show its outcome text or leave the DOM; returns the text seen ('card cleared' if it just went away). */
  const settle = async (opId, re) => {
    if (!opId) { await h.pause(900); return 'card cleared'; }
    const seen = await page.waitForFunction(({ id, src }) => {
      const n = [...document.querySelectorAll('[data-card-id]')].find((x) => x.getAttribute('data-card-id') === id);
      if (!n) return '__gone__';
      const t = (n.textContent || '').replace(/\s+/g, ' ');
      return new RegExp(src).test(t) ? t : null;
    }, { id: opId, src: re.source }, { timeout: 8000 }).then((hnd) => hnd.jsonValue(), () => null);
    if (seen === null) return null;
    return seen === '__gone__' ? 'card cleared' : (re.exec(seen)?.[0] ?? 'card cleared');
  };
  const decided = []; // every card handled: {index, opId, txId, tool, kind, decision, target, before, after, outcome}
  let target = null;  // the decided target change card
  for (let i = 0; i < 24; i++) {
    const opId = await nextCard();
    if (!opId) break;
    decidedIds.add(opId); // read once; every later action is pinned to THIS card, never to "whichever card is first"
    const card = page.locator(`[data-card-id="${opId}"]`);
    await h.pause(1800); // the card arms after 800 ms; give a viewer time to read it
    const text = await readCard(card);
    const heading = headingOf(text);
    const isRead = (await card.getByRole('button', { name: /Hold to allow/ }).count()) > 0;
    const tool = toolFromHeading(heading);
    const txId = /#(\d+)/.exec(text)?.[1] ?? null;
    log('card-shown', { index: i, opId, txId, tool, change: !isRead, text: text.slice(0, 700) }, { keyframe: !isRead });
    await h.moveTo(card, { settle: 2200 });
    const rec = { index: i, opId, txId, tool, kind: isRead ? 'read' : 'change' };

    const doReject = async (reason, extra = {}) => {
      const btn = card.getByRole('button', { name: /Reject|Don't allow/ });
      await h.click(btn, { pause: 100 });
      log('reject-clicked', { index: i, opId, txId, reason });
      const outcome = await settle(opId, /Rejected\. Nothing was changed\./);
      if (outcome === null && opId) throw new Error(`card ${opId} did not show Rejected or leave the page after Reject`);
      await h.pause(400);
      log('card-resolved', { index: i, opId, txId, kind: rec.kind, tool, decision: 'reject', target: !!extra.target, reason, outcome }, { keyframe: rec.kind === 'change' });
      decided.push({ ...rec, decision: 'reject', target: !!extra.target, outcome, ...extra });
      await h.pause(1400);
    };

    if (isRead) {
      // A read card is allowed only for a tool we granted that is read-only.
      if (!READ_TOOLS.has(tool)) { log('card-unexpected', { index: i, opId, reason: `read card for unexpected tool ${JSON.stringify(tool)}`, text }); await doReject(`read card for unexpected tool ${JSON.stringify(tool)}`); continue; }
      log('card-checked', { index: i, opId, txId, tool, kind: 'read', problems: [] });
      const allow = card.getByRole('button', { name: /Hold to allow/ });
      await allow.waitFor({ timeout: 10000 });
      await h.hold(allow, 1200, { onDown: async () => { log('allow-pressed', { index: i, opId }); }, onUp: async () => { log('allow-released', { index: i, opId }); } });
      await h.pause(900);
      log('card-resolved', { index: i, opId, txId, kind: 'read', tool, decision: 'allow', target: false });
      decided.push({ ...rec, decision: 'allow', target: false });
      await h.pause(2200); // a read card clears itself; the agent's next call may bring the next card
      continue;
    }

    const check = await checkChangeCard(card);
    const cat = check.rows.find((r) => /^categor/i.test(r[0] ?? ''));
    const before = cat?.[1] ?? null; const after = cat?.[2] ?? null;
    const isTarget = check.problems.length === 0 && !target && txId === TARGET_TX;
    log('card-checked', { index: i, opId, txId, tool: check.tool, kind: 'change', rows: check.rows, problems: check.problems, target: isTarget });
    if (!isTarget) {
      const reason = check.problems.length ? check.problems.join('; ') : `the target ${TARGET.description} was already decided; not deciding it twice`;
      log('card-unexpected', { index: i, opId, reason, text: check.text });
      await doReject(reason, { before, after });
      continue;
    }
    if (decision === 'deny') {
      await doReject('opts.decision=deny', { before, after, target: true });
      target = decided.at(-1);
    } else {
      const approve = card.getByRole('button', { name: /Hold to approve/ });
      await approve.waitFor({ timeout: 10000 });
      await h.hold(approve, 1200, {
        onDown: async () => { log('approve-pressed', { index: i, opId, txId }); await h.pause(500); log('approve-held', { index: i, opId, txId }, { keyframe: true }); },
        onUp: async () => { log('approve-released', { index: i, opId, txId }); },
      });
      const outcome = await settle(opId, /Done\. The change was applied\./);
      if (outcome === null && opId) throw new Error(`card ${opId} did not show "Done. The change was applied." or leave the page after Approve`);
      await h.pause(300);
      log('card-resolved', { index: i, opId, txId, kind: 'change', tool, decision: 'approve', target: true, outcome: outcome ?? 'card cleared' }, { keyframe: true });
      target = { ...rec, decision: 'approve', target: true, before, after, outcome };
      decided.push(target);
      await h.pause(1400);
    }
  }
  if (!target) throw new Error(`the target ${TARGET.description} was never proposed and decided (${decided.length} card(s) decided: ${decided.map((d) => `${d.tool}/${d.decision}`).join(', ') || 'none'})`);
  await h.pause(1500);
  const pendingLeft = (await pendingCards()).length;
  if (pendingLeft > 0) throw new Error(`${pendingLeft} confirmation card(s) still pending at beat end; every card must be decided on camera`);
  const chosenCategory = target.after;

  // 4. The ledger after: switch away and back so the Transactions tab refetches, CLEAR the search so every decided row is
  //    in the list, then show the target row first and each other decided change row.
  await h.pause(2000);
  await ctx.gotoTabHuman('Overview');
  await h.pause(500);
  await ctx.gotoTabHuman('Transactions');
  const search = page.getByPlaceholder('Search by merchant or description...');
  if ((await search.inputValue()) !== '') { await h.click(search, { pause: 200 }); await page.keyboard.press('Meta+a'); await page.keyboard.press('Backspace'); await h.pause(700); }
  const changeCards = decided.filter((d) => d.kind === 'change' && d.txId);
  const rowFor = (txId) => page.locator(`tr[data-tx-id="${txId}"]`).first();
  const anchor = rowFor(target.txId ?? '0');
  if (!(await anchor.waitFor({ timeout: 4000 }).then(() => true, () => false))) await h.click(page.getByRole('button', { name: '←' }), { pause: 900 });
  await anchor.waitFor({ timeout: 20000 });
  if (decision === 'approve') {
    await page.waitForFunction((id) => { const r = document.querySelector(`tr[data-tx-id="${id}"]`); return r && !/Uncategorized/.test(r.textContent || ''); }, target.txId, { timeout: 20000 });
  }
  const rows = [];
  for (const d of [target, ...changeCards.filter((c) => c !== target)]) {
    const r = rowFor(d.txId);
    await r.waitFor({ timeout: 20000 });
    await h.moveTo(r, { dx: 60 });
    await h.pause(d === target ? 900 : 1100);
    const text = (await r.innerText()).replace(/\s+/g, ' ');
    if (d.decision === 'approve' && !text.toLowerCase().includes(String(d.after).toLowerCase())) throw new Error(`row #${d.txId} does not carry the approved category ${d.after}: ${text}`);
    if (d.decision === 'reject' && d.after && d.before !== d.after && text.toLowerCase().includes(String(d.after).toLowerCase())) throw new Error(`row #${d.txId} carries ${d.after} although its card was rejected: ${text}`);
    if (d.decision === 'reject' && /^uncategorized$/i.test(d.before ?? '') && !/Uncategorized/.test(text)) throw new Error(`row #${d.txId} was rejected but is no longer uncategorized: ${text}`);
    rows.push({ txId: d.txId, opId: d.opId, decision: d.decision, target: d.target, row: text });
  }
  await h.moveTo(anchor, { dx: 60 });
  const rowAfter = rows.find((r) => r.target)?.row ?? '';
  log('ledger-after', { decision: target.decision, category: chosenCategory, row: rowAfter, rows }, { keyframe: true });
  await h.pause(3200); // ledger-after hold (the cut asserts >= 2.5 s)
  log('beat-end');
}
