// Beat b10-judge: "It judges, you decide what trains".
//
//  Real LLM tab only (LLM -> Training and LLM -> Judge queue). The agent is a real model; the human script only REACTS to
//  what appears in the DOM and decides on camera.
//
//  preState (unrecorded, fast): no import, no /categorize. On LLM -> Training it checks that the seed's 13 interactions
//    are loaded and the "Judge: proposed / accepted" tile reads 0 / 0, then derives the GROUND TRUTH (which interaction
//    ids are the seed's deliberately wrong answers) from the seed's own data: src/demo/founder-seed.ts buildInteractions()
//    (run under bun with the workspace's scratch HOME) gives each question and its `wrong` flag; the dashboard API gives
//    each interaction id's prompt; groundTruthFrom() matches them. No id is hand-picked.
//  humanScript (recorded): Training before -> grant the 6 judge tools on camera -> watch the agent (panel opened by the
//    agent, every card read and decided, the human-timed submit of an agent-filled judge form) -> tiles -> read every
//    proposal in the Judge queue, score it against the ground truth, Accept the correct ones and Reject the rest (or one
//    weak one when all are correct) -> tiles -> one annotation of the human's own -> default SFT export vs one with judge + agent-present
//    opt-ins (hold), both parsed and mapped to interaction ids -> opt-ins back to default.
//
// Event contract (consumed by demos/compose): training-before, grants-applied, panel-opened-by-agent, card-shown,
// card-checked, card-resolved, card-behind-dialog, form-submit-clicked, last-card-resolved, tiles (after-agent,
// after-review), queue-shown, catch-score, verdict-accepted, verdict-rejected, human-annotation-saved, export-done,
// beat-end.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from '../lib/common.mjs';
import { headingOf, toolFromHeading } from './b5-propose.mjs';

export const JUDGE_TOOLS = ['get_judge_rubric', 'list_interactions', 'get_interaction', 'open_interaction', 'propose_judgements', 'judge_interaction'];
const READ_TOOLS = new Set(['get_judge_rubric', 'list_interactions', 'get_interaction', 'open_interaction']);
const PROPOSAL_TOOLS = new Set(['propose_judgements', 'judge_interaction']);
const EXPECTED_INTERACTIONS = 13;
const EXPECTED_WRONG = 4;

export const meta = {
  id: 'b10-judge',
  title: 'It judges, you decide what trains',
  needsAgent: true,
  actorTimeoutS: 1500, // run-beat.sh gives the actor this long; 13 reviews with polled proposals outlast the 600 s default
  agentTools: JUDGE_TOOLS,
  opts: {},
  expectedStates: [
    'training-before: LLM -> Training, "13 interactions loaded", tile "Judge: proposed / accepted 0 / 0"',
    'grants-applied: Agent access panel shows 6 tools live in this tab (granted on camera)',
    'panel-opened-by-agent: the Training detail dialog shows "Interaction #N" with the blind notice, opened by open_interaction (no human click)',
    'every card the agent raises is read and decided on camera: a Propose Judgements / Judge Interaction card is approved only when its interactions and ratings rows parse and every id exists; anything else is Rejected; no card is pending at beat end',
    'form-submit-clicked (if the agent used judge_interaction): the human clicks "Submit judgement (agents only)" on an agent-filled form; card-behind-dialog when the modal dialog hides the card (known product bug: closing the dialog cancels the call)',
    'tiles after-agent: "Judge: proposed / accepted" shows what the agent proposed',
    'queue-shown + catch-score: every proposal read in the Judge queue, scored against the seed ground truth (4 wrong answers)',
    'verdict-accepted / verdict-rejected: correct verdicts accepted, incorrect ones rejected (or one weak one rejected when all are correct)',
    'tiles after-review: accepted count moved',
    'human-annotation-saved: the human rates a wrong answer 1 star with a note; the row shows whether it is flagged Agent present',
    'export-done (variant default): SFT with no opt-ins, downloaded and parsed (expected 0 lines, provenance human); held 3+ s',
    'export-done (variant with-judge): both opt-ins ticked on camera, Hold to export SFT; lines mapped to interaction ids, judge/human rows only where proven; held 3+ s',
    'export-options-default: both opt-ins unchecked again before beat end',
  ],
};

// ---------------------------------------------------------------------------------------------------------------------
// Pure functions (unit-tested in demos/rig/b10-judge.test.mjs)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Ground truth: which interaction ids hold the seed's deliberately wrong answers.
 *   seed    - [{prompt, response, wrong, tool}] from founder-seed.ts buildInteractions() (one entry per agent RUN)
 *   details - [{id, run_id, sequence_num, user_prompt, response_content}] from the dashboard (one entry per interaction)
 * Each interaction is matched to the seed run whose question its prompt contains (longest match wins). A run's
 * tool-call step (empty response, tool calls) inherits the run's verdict and is marked step 'tool-call'.
 * Returns {byId: {[id]: {verdict:'wrong'|'good', seedIndex, prompt, step, responseMatches}}, wrongIds, goodIds, problems}.
 */
export function groundTruthFrom(seed, details, { expectInteractions = EXPECTED_INTERACTIONS, expectWrong = EXPECTED_WRONG } = {}) {
  const problems = [];
  const byId = {};
  const matched = new Set();
  for (const d of details) {
    const prompt = String(d.user_prompt ?? '');
    let best = -1;
    seed.forEach((s, i) => { if (prompt.includes(s.prompt) && (best < 0 || s.prompt.length > seed[best].prompt.length)) best = i; });
    if (best < 0) { problems.push(`interaction #${d.id} matches no seeded question (prompt starts ${JSON.stringify(prompt.slice(0, 80))})`); continue; }
    const s = seed[best];
    matched.add(best);
    const response = String(d.response_content ?? '');
    const step = response === '' ? 'tool-call' : 'answer';
    const responseMatches = step === 'answer' ? response === s.response : null;
    if (step === 'answer' && !responseMatches) problems.push(`interaction #${d.id} answer differs from the seed's answer for ${JSON.stringify(s.prompt)}`);
    byId[d.id] = { verdict: s.wrong ? 'wrong' : 'good', seedIndex: best, prompt: s.prompt, step, responseMatches };
  }
  seed.forEach((s, i) => { if (!matched.has(i)) problems.push(`seeded question ${JSON.stringify(s.prompt)} has no interaction in the dashboard`); });
  const ids = Object.keys(byId).map(Number).sort((a, b) => a - b);
  const wrongIds = ids.filter((id) => byId[id].verdict === 'wrong');
  const goodIds = ids.filter((id) => byId[id].verdict === 'good');
  if (details.length !== expectInteractions) problems.push(`expected ${expectInteractions} interactions, the dashboard has ${details.length}`);
  if (wrongIds.length !== expectWrong) problems.push(`expected ${expectWrong} wrong answers, matched ${wrongIds.length} (${wrongIds.join(', ')})`);
  if (seed.filter((s) => s.wrong).length !== expectWrong) problems.push(`the seed marks ${seed.filter((s) => s.wrong).length} answers wrong, expected ${expectWrong}`);
  return { byId, wrongIds, goodIds, problems };
}

/** A judge verdict is right when it rates a wrong answer 1-2 or a good one 3-5. */
export function verdictCorrect(verdict, rating) {
  if (!Number.isInteger(rating)) return false;
  return (verdict === 'wrong' && rating <= 2) || (verdict === 'good' && rating >= 3);
}

/** How the agent's proposals line up with the ground truth. proposals: [{proposalId, interactionId, rating}]. */
export function catchScore(truth, proposals) {
  const low = (id) => proposals.some((p) => p.interactionId === id && Number.isInteger(p.rating) && p.rating <= 2);
  const caught = truth.wrongIds.filter(low);
  const missed = truth.wrongIds.filter((id) => !low(id));
  const falseAlarms = truth.goodIds.filter(low);
  const proposed = [...new Set(proposals.map((p) => p.interactionId))].sort((a, b) => a - b);
  const unknown = proposals.filter((p) => !truth.byId[p.interactionId]).map((p) => p.interactionId);
  return { wrongIds: truth.wrongIds, caught, missed, falseAlarms, proposedInteractions: proposed, unknown };
}

/**
 * What the human does with each proposal: Accept a correct verdict, Reject an incorrect one (or one for an interaction
 * the ground truth does not know). When every proposal is correct and there are at least two, the one with the shortest
 * rationale is Rejected as 'weak rationale' so the reject path is shown and at least one accept remains.
 */
export function planDecisions(truth, proposals) {
  const plan = proposals.map((p) => {
    const t = truth.byId[p.interactionId];
    if (!t) return { ...p, verdict: null, correct: false, decision: 'reject', reason: `interaction #${p.interactionId} is not one of the seeded interactions` };
    const correct = verdictCorrect(t.verdict, p.rating);
    const reason = correct
      ? (t.verdict === 'wrong' ? `caught a wrong answer (rated ${p.rating})` : `good answer rated ${p.rating}`)
      : (t.verdict === 'wrong' ? `rated a wrong answer ${p.rating}` : `rated a good answer ${p.rating}`);
    return { ...p, verdict: t.verdict, correct, decision: correct ? 'accept' : 'reject', reason };
  });
  if (plan.length >= 2 && plan.every((d) => d.correct)) {
    const weakest = plan.reduce((w, d) => (String(d.rationale ?? '').length < String(w.rationale ?? '').length ? d : w), plan[0]);
    weakest.decision = 'reject';
    weakest.reason = 'weak rationale';
  }
  return plan;
}

/**
 * A careful human's read of a Propose Judgements / Judge Interaction card. rows: [[field, from, to]] from the card's table.
 * Returns {tool, judgements, ids, ratings, judgeModel, rubric, truncated, problems}.
 */
export function parseJudgeCard(heading, rows, knownIds) {
  const tool = toolFromHeading(heading);
  const problems = [];
  if (!PROPOSAL_TOOLS.has(tool)) problems.push(`card is for tool ${JSON.stringify(tool)} (heading ${JSON.stringify(heading)}), not a judge proposal`);
  const ALLOWED = ['judgements', 'interactions', 'ratings', 'judge model (declared by agent)', 'rubric'];
  const val = (name) => { const r = rows.find((x) => (x[0] ?? '').trim().toLowerCase() === name); return r ? String(r[r.length - 1] ?? '').trim() : null; };
  const extra = rows.filter((r) => r.length > 0 && !ALLOWED.includes((r[0] ?? '').trim().toLowerCase()));
  if (extra.length) problems.push(`card has rows a judge proposal does not have: ${JSON.stringify(extra)}`);
  const jRaw = val('judgements'); const iRaw = val('interactions'); const rRaw = val('ratings');
  const judgements = jRaw !== null && /^\d+$/.test(jRaw) ? Number(jRaw) : null;
  if (judgements === null || judgements < 1) problems.push(`judgements row ${JSON.stringify(jRaw)} is not a positive count`);
  const split = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const truncated = /…|\.\.\./.test(iRaw ?? '') || /…|\.\.\./.test(rRaw ?? '');
  const idParts = split(iRaw).filter((x) => !/^(…|\.\.\.)$/.test(x));
  const ratingParts = split(rRaw).filter((x) => !/^(…|\.\.\.)$/.test(x));
  const ids = idParts.map((x) => (/^#(\d+)$/.exec(x) ? Number(x.slice(1)) : NaN));
  const ratings = ratingParts.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
  if (iRaw === null) problems.push('card has no interactions row');
  else if (ids.length === 0 || ids.some((x) => !Number.isInteger(x))) problems.push(`interactions row ${JSON.stringify(iRaw)} does not parse as #ids`);
  if (rRaw === null) problems.push('card has no ratings row');
  else if (ratings.length === 0 || ratings.some((x) => !Number.isInteger(x) || x < 1 || x > 5)) problems.push(`ratings row ${JSON.stringify(rRaw)} is not 1-5 ratings`);
  if (ids.length !== ratings.length) problems.push(`${ids.length} ids but ${ratings.length} ratings`);
  if (judgements !== null) {
    if (!truncated && ids.length !== judgements) problems.push(`judgements says ${judgements} but the card lists ${ids.length} ids`);
    if (truncated && (judgements <= ids.length)) problems.push(`card is truncated but judgements is only ${judgements}`);
  }
  if (tool === 'judge_interaction' && judgements !== 1) problems.push(`a judge_interaction card must carry exactly 1 judgement, has ${judgements}`);
  if (new Set(ids).size !== ids.length) problems.push(`duplicate interaction ids ${JSON.stringify(ids)}`);
  const known = new Set(knownIds);
  const unknown = ids.filter((x) => Number.isInteger(x) && !known.has(x));
  if (unknown.length) problems.push(`interaction id(s) ${unknown.map((x) => '#' + x).join(', ')} do not exist`);
  return { tool, judgements, ids, ratings, judgeModel: val('judge model (declared by agent)'), rubric: val('rubric'), truncated, problems };
}

/** "Judge: proposed / accepted" tile text (any case, any whitespace) -> {proposed, accepted}. */
export function parseJudgeTile(text) {
  const m = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*$/.exec(String(text).trim());
  if (!m) return null;
  return { proposed: Number(m[1].replace(/,/g, '')), accepted: Number(m[2].replace(/,/g, '')) };
}

/**
 * What a downloaded SFT file holds. The SFT format (src/training/export.ts exportSftJsonl) is one JSON line per RUN,
 * {"messages":[system?, user, assistant, tool?, user, assistant, ...]}; it carries no per-line label source. Each line is
 * mapped back to interaction ids by pairing every user message with the assistant message after it and looking the
 * pair up in `details` (the same /api/interactions/:id text the ground truth uses: user_prompt and response_content
 * must both match exactly).
 *
 * A line's source is reported only where the export's own rule proves it. SFT emits a run only when one of its
 * interactions has a qualifying label rated >= minRating (annotations.ts qualifyingSftRuns), and that label is either the
 * current human row or, with includeJudge, an accepted judge row:
 *  - provenance without "judge": every line is human-qualified;
 *  - otherwise a fully mapped line with an interaction whose human rating qualifies (>= minRating; an agent-present one
 *    only with includeAgentPresent) is 'human'; a fully mapped line with none can only have come from a judge row: 'judge';
 *  - a line that does not map completely is null, and then the totals are null too.
 *   human: {[interactionId]: {rating, via}} from /api/interactions (via = annotation_via)
 */
export function summarizeSft(text, { details, seed, human = {}, provenance, includeAgentPresent = false, minRating = 4 }) {
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  const parsed = []; const parseErrors = [];
  lines.forEach((l, i) => { try { parsed.push(JSON.parse(l)); } catch (e) { parseErrors.push(`line ${i + 1}: ${e.message}`); } });
  const prov = String(provenance ?? '').split('+').filter(Boolean);
  const judgeAllowed = prov.includes('judge');
  const humanQualifies = (id) => {
    const hr = human[id];
    return !!hr && Number.isInteger(hr.rating) && hr.rating >= minRating && (hr.via !== 'dashboard_agent_present' || includeAgentPresent);
  };
  const perLine = parsed.map((obj) => {
    const msgs = obj.messages ?? [];
    const ids = []; let unmapped = 0;
    msgs.forEach((m, i) => {
      if (m.role !== 'user') return;
      const reply = msgs.slice(i + 1).find((x) => x.role === 'assistant');
      const d = details.find((x) => String(x.user_prompt ?? '') === String(m.content ?? '') && String(x.response_content ?? '') === String(reply?.content ?? ''));
      if (d) ids.push(d.id); else unmapped++;
    });
    const users = msgs.filter((m) => m.role === 'user').map((m) => String(m.content ?? ''));
    const question = (seed ?? []).find((s) => users.some((u) => u.includes(s.prompt)))?.prompt ?? null;
    let source = null;
    if (!judgeAllowed) source = 'human';
    else if (unmapped === 0 && ids.length > 0) source = ids.some(humanQualifies) ? 'human' : 'judge';
    return { ids, unmapped, question, source };
  });
  const proven = parseErrors.length === 0 && perLine.every((l) => l.source !== null);
  return {
    rows: parsed.length,
    judgeRows: proven ? perLine.filter((l) => l.source === 'judge').length : null,
    humanRows: proven ? perLine.filter((l) => l.source === 'human').length : null,
    interactionIdsInFile: perLine.map((l) => l.ids),
    lines: perLine,
    parseErrors,
    provenance: prov.join('+') || null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Ground truth I/O
// ---------------------------------------------------------------------------------------------------------------------

let SEED = null;   // [{prompt, response, wrong, tool}]
let TRUTH = null;  // groundTruthFrom()
let DETAILS = null; // [{id, run_id, sequence_num, user_prompt, response_content}] the ground truth was derived from

/** The seed's own question list, computed by founder-seed.ts under bun with the workspace's scratch HOME. */
function seedInteractions(home) {
  const src = path.join(REPO, 'src/demo/founder-seed.ts');
  const code = `const m = await import(${JSON.stringify(src)}); console.log(JSON.stringify(m.buildInteractions(m.buildHistory({})).map((i) => ({ prompt: i.prompt, response: i.response, wrong: i.wrong, tool: i.tool?.name ?? null }))));`;
  const r = spawnSync('bun', ['-e', code], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`could not read the seed's interactions with bun: ${(r.stderr || r.stdout).slice(0, 500)}`);
  const line = r.stdout.trim().split('\n').pop();
  return JSON.parse(line);
}

async function deriveTruth(ctx) {
  SEED = seedInteractions(ctx.paths.home);
  const list = await ctx.api('/api/interactions?limit=100&offset=0');
  if (list.status !== 200 || !Array.isArray(list.body)) throw new Error(`GET /api/interactions failed: ${list.status}`);
  const details = [];
  for (const row of list.body) {
    const d = await ctx.api(`/api/interactions/${row.id}`);
    if (d.status !== 200) throw new Error(`GET /api/interactions/${row.id} failed: ${d.status}`);
    details.push({ id: row.id, run_id: row.run_id, sequence_num: row.sequence_num, user_prompt: d.body.user_prompt, response_content: d.body.response_content });
  }
  const truth = groundTruthFrom(SEED, details);
  if (truth.problems.length) throw new Error(`ground truth could not be derived from the seed: ${truth.problems.join('; ')}`);
  TRUTH = truth;
  DETAILS = details;
  ctx.log('ground-truth', {
    wrongIds: truth.wrongIds,
    goodIds: truth.goodIds,
    wrong: truth.wrongIds.map((id) => ({ id, prompt: truth.byId[id].prompt })),
    source: 'src/demo/founder-seed.ts buildInteractions() wrong flags, matched by question to /api/interactions/:id',
  });
  return truth;
}

// ---------------------------------------------------------------------------------------------------------------------
// DOM readers
// ---------------------------------------------------------------------------------------------------------------------

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function readTraining(page) {
  const loaded = page.getByText(/\d+ interactions loaded/);
  await loaded.waitFor({ timeout: 20000 });
  const interactions = Number(/(\d+) interactions loaded/.exec(await loaded.innerText())?.[1]);
  const tile = page.getByText('Judge: proposed / accepted', { exact: true }).locator('xpath=..');
  await tile.waitFor({ timeout: 20000 });
  const tiles = parseJudgeTile(clean(await tile.innerText()));
  if (!tiles) throw new Error(`could not read the Judge tile: ${clean(await tile.innerText())}`);
  return { interactions, tiles, tile };
}

async function openTraining(page, ctx, human) {
  const btn = page.getByRole('button', { name: 'Training', exact: true });
  if (human) await ctx.h.click(btn, { pause: 700 }); else await btn.click();
}

/** Re-mount the Training sub-tab (Traces, then Training) so its stats and list refetch, like a person refreshing. */
async function refreshTraining(page, ctx) {
  await ctx.h.click(page.getByRole('button', { name: 'Traces', exact: true }), { pause: 500 });
  await openTraining(page, ctx, true);
}

async function dialogState(page) {
  return page.evaluate(() => {
    const d = [...document.querySelectorAll('dialog[open]')].pop();
    if (!d) return { open: false };
    const title = (d.querySelector('h2')?.textContent || '').trim();
    const id = /^Interaction #(\d+)/.exec(title)?.[1];
    const text = d.textContent || '';
    return {
      open: true,
      title,
      id: id ? Number(id) : null,
      blind: text.includes('Human labels are hidden: an agent opened this panel'),
      banner: text.includes('Agent filled this form'),
    };
  });
}

async function readQueue(page) {
  return page.locator('[data-testid="judgement-row"]').evaluateAll((ns) => ns.map((n) => {
    const cb = n.querySelector('input[type=checkbox][aria-label^="Select judgement "]');
    const idBtn = [...n.querySelectorAll('button')].find((b) => /^#\d+$/.test((b.textContent || '').trim()));
    const stars = n.querySelector('[aria-label$=" of 5"]');
    const model = n.querySelector('span.font-mono');
    const p = n.querySelector('p');
    return {
      proposalId: cb ? Number(cb.getAttribute('aria-label').replace('Select judgement ', '')) : null,
      interactionId: idBtn ? Number(idBtn.textContent.trim().slice(1)) : null,
      rating: stars ? Number(/^(\d)/.exec(stars.getAttribute('aria-label'))?.[1]) : null,
      judgeModel: model ? (model.textContent || '').trim() : null,
      rationale: p ? (p.textContent || '').trim() : '',
    };
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// preState
// ---------------------------------------------------------------------------------------------------------------------

export async function preState(page, ctx) {
  await ctx.gotoTab('LLM');
  await openTraining(page, ctx, false);
  const { interactions, tiles } = await readTraining(page);
  if (interactions !== EXPECTED_INTERACTIONS) throw new Error(`precondition failed: Training shows ${interactions} interactions loaded, expected ${EXPECTED_INTERACTIONS}`);
  if (tiles.proposed !== 0 || tiles.accepted !== 0) throw new Error(`precondition failed: Judge tile reads ${tiles.proposed} / ${tiles.accepted}, expected 0 / 0 on a fresh seed`);
  await deriveTruth(ctx);
  ctx.log('training-precheck', { interactions, tiles });
}

// ---------------------------------------------------------------------------------------------------------------------
// humanScript
// ---------------------------------------------------------------------------------------------------------------------

const CARD_OUTCOME_RE = /Done\. The change was applied\.|Nothing was changed\.|nothing was applied\.|Could not confirm what happened/;

export async function humanScript(page, ctx) {
  const { h, log } = ctx;
  if (!TRUTH) await deriveTruth(ctx); // --no-prestate: same derivation, from inside the recorded tab (API reads only)
  const knownIds = Object.keys(TRUTH.byId).map(Number);

  // 1. Training before.
  await h.pause(1200);
  await ctx.gotoTabHuman('LLM');
  await openTraining(page, ctx, true);
  const before = await readTraining(page);
  await h.moveTo(before.tile);
  await h.pause(900);
  log('training-before', { interactions: before.interactions, tiles: before.tiles }, { keyframe: true });
  await h.pause(1500);

  // 2. Grant the six judge tools to this tab through the real Agent access panel.
  const launcher = page.getByRole('button').filter({ hasText: /AGENT ACCESS/ });
  await h.click(launcher, { pause: 800 });
  await page.getByText('Agent access for this tab').waitFor({ timeout: 10000 });
  for (const tool of JUDGE_TOOLS) {
    const line = page.locator('label').filter({ has: page.getByText(tool, { exact: true }) });
    await h.click(line.locator('input[type=checkbox]'), { pause: 400 });
  }
  const apply = page.getByRole('button', { name: 'Apply', exact: true }).last();
  await h.pause(700);
  await h.click(apply, { pause: 500 });
  await page.getByText(new RegExp(`${JUDGE_TOOLS.length} tools live in this tab`)).waitFor({ timeout: 15000 });
  await h.pause(700);
  log('grants-applied', { tools: JUDGE_TOOLS }, { keyframe: true });
  await h.pause(1600);
  await h.click(launcher, { pause: 700 });

  // 3. While the agent works: notice the panel it opens, decide every card, click submit on an agent-filled form.
  const actorExited = async () => !!(await ctx.waitEvent('actor-exited', 1));
  const decidedIds = new Set();
  const pendingCards = async () => (await page.locator('[data-card-id]').evaluateAll((ns) => ns.map((n) => ({ id: n.getAttribute('data-card-id'), text: (n.textContent || '').replace(/\s+/g, ' ').trim() }))))
    .filter((c) => c.id && !decidedIds.has(c.id) && !CARD_OUTCOME_RE.test(c.text));
  const settle = async (opId) => {
    const seen = await page.waitForFunction(({ id, src }) => {
      const n = [...document.querySelectorAll('[data-card-id]')].find((x) => x.getAttribute('data-card-id') === id);
      if (!n) return '__gone__';
      const t = (n.textContent || '').replace(/\s+/g, ' ');
      return new RegExp(src).test(t) ? t : null;
    }, { id: opId, src: CARD_OUTCOME_RE.source }, { timeout: 10000 }).then((hnd) => hnd.jsonValue(), () => null);
    if (seen === null) return null;
    return seen === '__gone__' ? 'card cleared' : (CARD_OUTCOME_RE.exec(seen)?.[0] ?? 'card cleared');
  };
  const closeDialog = async () => {
    const x = page.locator('dialog[open]').last().getByRole('button', { name: '×' }).first();
    await h.click(x, { pause: 600 });
    await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  };

  // Never give up before the actor's own timeout: the actor can sit between cards for most of its run.
  const AGENT_PHASE_MS = (meta.actorTimeoutS + 180) * 1000;
  const decided = [];
  let index = 0;
  let lastDialogId = null;
  let submittedFor = null;
  let idleSince = null;
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > AGENT_PHASE_MS) throw new Error(`agent phase ran ${Math.round(AGENT_PHASE_MS / 60_000)} minutes without the actor exiting (${decided.length} card(s) decided)`);
    const d = await dialogState(page);
    if (!d.open) { lastDialogId = null; submittedFor = null; }
    else if (d.id !== null && d.id !== lastDialogId) {
      lastDialogId = d.id; submittedFor = null;
      await h.pause(600);
      log('panel-opened-by-agent', { interactionId: d.id, title: d.title, blindNotice: d.blind, knownInteraction: knownIds.includes(d.id), verdict: TRUTH.byId[d.id]?.verdict ?? null }, { keyframe: true });
    }

    const pending = await pendingCards();
    if (pending.length > 0) {
      idleSince = null;
      const opId = pending[pending.length - 1].id; // oldest (the column lists newest first)
      if (d.open) {
        // A modal <dialog> sits in the top layer and takes every pointer event: the card behind it cannot be clicked.
        await h.pause(1200);
        await closeDialog();
        await h.pause(1500);
        const after = await page.evaluate((id) => {
          const n = [...document.querySelectorAll('[data-card-id]')].find((x) => x.getAttribute('data-card-id') === id);
          return n ? (n.textContent || '').replace(/\s+/g, ' ').trim() : null;
        }, opId);
        const outcome = after === null ? 'card gone' : (CARD_OUTCOME_RE.exec(after)?.[0] ?? null);
        log('card-behind-dialog', { opId, dialog: d.title, interactionId: d.id, afterClose: outcome ? 'ended' : 'still-pending', outcome }, { keyframe: true });
        if (outcome) {
          decidedIds.add(opId);
          log('card-resolved', { index, opId, tool: toolFromHeading(headingOf(pending[pending.length - 1].text)), decision: 'none', reason: 'the call ended when the dialog was closed', outcome });
          decided.push({ index: index++, opId, decision: 'none', outcome });
        }
        continue; // still pending: decided on the next pass, now that it is reachable
      }

      decidedIds.add(opId);
      const i = index++;
      const card = page.locator(`[data-card-id="${opId}"]`);
      await h.pause(1800);
      const text = clean(await card.innerText());
      const heading = headingOf(text);
      const tool = toolFromHeading(heading);
      const isRead = (await card.getByRole('button', { name: /Hold to allow/ }).count()) > 0;
      const bb = await card.boundingBox();
      const box = bb ? { x: Math.round(bb.x), y: Math.round(bb.y), width: Math.round(bb.width), height: Math.round(bb.height) } : null; // CSS px, 1440x900 viewport
      log('card-shown', { index: i, opId, tool, change: !isRead, box, text: text.slice(0, 700) }, { keyframe: !isRead });
      await h.moveTo(card, { settle: 2200 });

      const reject = async (reason, extra = {}) => {
        await h.click(card.getByRole('button', { name: /Reject|Don't allow/ }), { pause: 100 });
        log('reject-clicked', { index: i, opId, reason });
        const outcome = await settle(opId);
        if (outcome === null) throw new Error(`card ${opId} did not show an outcome or leave the page after Reject`);
        log('card-resolved', { index: i, opId, tool, decision: 'reject', reason, outcome, ...extra }, { keyframe: !isRead });
        decided.push({ index: i, opId, tool, decision: 'reject', outcome, ...extra });
        await h.pause(1400);
      };

      if (isRead) {
        if (!READ_TOOLS.has(tool)) { log('card-checked', { index: i, opId, tool, kind: 'read', problems: [`read card for a tool this beat did not grant as a read: ${tool}`] }); await reject(`read card for unexpected tool ${JSON.stringify(tool)}`); continue; }
        log('card-checked', { index: i, opId, tool, kind: 'read', problems: [] });
        const allow = card.getByRole('button', { name: /Hold to allow/ });
        await allow.waitFor({ timeout: 10000 });
        await h.hold(allow, 1200);
        await h.pause(900);
        log('card-resolved', { index: i, opId, tool, decision: 'allow' });
        decided.push({ index: i, opId, tool, decision: 'allow' });
        await h.pause(1500);
        continue;
      }

      const rows = await card.locator('table tr').evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim())));
      const check = parseJudgeCard(heading, rows, knownIds);
      log('card-checked', { index: i, opId, tool: check.tool, kind: 'change', rows, ids: check.ids, ratings: check.ratings, judgements: check.judgements, judgeModel: check.judgeModel, rubric: check.rubric, truncated: check.truncated, problems: check.problems });
      if (check.problems.length) { await reject(check.problems.join('; '), { ids: check.ids, ratings: check.ratings }); continue; }
      const approve = card.getByRole('button', { name: /Hold to approve/ });
      await approve.waitFor({ timeout: 10000 });
      await h.hold(approve, 1600, {
        onDown: async () => { log('approve-pressed', { index: i, opId }); await h.pause(500); log('approve-held', { index: i, opId }, { keyframe: true }); },
        onUp: async () => { log('approve-released', { index: i, opId }); },
      });
      const outcome = await settle(opId);
      if (outcome === null) throw new Error(`card ${opId} did not show an outcome or leave the page after Approve`);
      await h.pause(300);
      log('card-resolved', { index: i, opId, tool: check.tool, decision: 'approve', ids: check.ids, ratings: check.ratings, outcome }, { keyframe: true });
      decided.push({ index: i, opId, tool: check.tool, decision: 'approve', ids: check.ids, ratings: check.ratings, outcome });
      await h.pause(1400);
      continue;
    }

    // No card waiting. An agent-filled judge form waits for a person's click on its submit button.
    if (d.open && d.banner && d.id !== null && submittedFor !== d.id) {
      idleSince = null;
      submittedFor = d.id;
      const dlg = page.locator('dialog[open]').last();
      const submit = dlg.getByRole('button', { name: 'Submit judgement (agents only)' });
      const form = dlg.locator('form[aria-label="Agent judgement"]');
      const filled = await form.evaluate((f) => Object.fromEntries(['rating', 'preference', 'judge_model', 'rationale'].map((k) => [k, f.elements[k]?.value ?? null]))).catch(() => null);
      await h.moveTo(dlg.getByText('Agent filled this form').first(), { settle: 1500 });
      await h.click(submit, { pause: 400 });
      log('form-submit-clicked', { interactionId: d.id, verdict: TRUTH.byId[d.id]?.verdict ?? null, filled }, { keyframe: true });
      await h.pause(1200);
      continue;
    }

    if (await actorExited()) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 4000) break;
    }
    await h.pause(400);
  }
  if ((await pendingCards()).length > 0) throw new Error('a confirmation card is still pending after the agent exited');
  log('last-card-resolved', { decided: decided.length, approved: decided.filter((x) => x.decision === 'approve').length, rejected: decided.filter((x) => x.decision === 'reject').length, ended: decided.filter((x) => x.decision === 'none').length });
  if ((await dialogState(page)).open) await closeDialog();

  // 4. Tiles after the agent.
  await h.pause(1200);
  await refreshTraining(page, ctx);
  const afterAgent = await readTraining(page);
  await h.moveTo(afterAgent.tile);
  await h.pause(900);
  log('tiles', { phase: 'after-agent', ...afterAgent.tiles }, { keyframe: true });
  await h.pause(1800);

  // 5. Judge queue: read every proposal, score it, decide each on camera.
  await h.click(page.getByRole('button', { name: 'Judge queue', exact: true }), { pause: 900 });
  await page.getByTestId('judge-queue-header').waitFor({ timeout: 15000 });
  await h.pause(800);
  const proposals = await readQueue(page);
  const header = clean(await page.getByTestId('judge-queue-header').innerText());
  await h.moveTo(page.getByTestId('judge-queue-header'));
  log('queue-shown', { header, proposals }, { keyframe: true });
  const score = catchScore(TRUTH, proposals);
  log('catch-score', score);
  await h.pause(1600);

  if (proposals.length === 0) {
    log('verdicts-skipped', { reason: 'the agent left no proposal in the Judge queue' });
  } else {
    const plan = planDecisions(TRUTH, proposals);
    let firstAccept = true; let firstReject = true;
    const rowFor = (pid) => page.locator('[data-testid="judgement-row"]').filter({ has: page.locator(`input[aria-label="Select judgement ${pid}"]`) });
    for (const p of plan) {
      const row = rowFor(p.proposalId);
      await row.waitFor({ timeout: 15000 });
      await h.moveTo(row, { settle: 500 });
      const expand = row.getByRole('button', { name: 'Expand', exact: true });
      if (await expand.count()) await h.click(expand, { pause: 1400 }); // read it; also clears the accept dwell
      else await h.pause(1400);
      const label = p.decision === 'accept' ? 'Accept' : 'Reject';
      const fields = { proposalId: p.proposalId, interactionId: p.interactionId, rating: p.rating, verdict: p.verdict, reason: p.reason };
      for (let attempt = 0; attempt < 3; attempt++) {
        await h.click(row.getByRole('button', { name: label, exact: true }), { pause: 300 });
        const gone = await row.waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false);
        if (gone) break;
        const note = clean(await row.innerText().catch(() => ''));
        if (attempt === 2 || !/Too quick|wait/i.test(note)) throw new Error(`${label} on proposal ${p.proposalId} did not take: ${note.slice(0, 200)}`);
        await h.pause(1200);
      }
      if (p.decision === 'accept') { log('verdict-accepted', fields, { keyframe: firstAccept }); firstAccept = false; }
      else { log('verdict-rejected', fields, { keyframe: firstReject }); firstReject = false; }
      await h.pause(900);
    }
  }

  // 6. Tiles after the review.
  await h.pause(800);
  await openTraining(page, ctx, true);
  const afterReview = await readTraining(page);
  await h.moveTo(afterReview.tile);
  await h.pause(900);
  log('tiles', { phase: 'after-review', ...afterReview.tiles }, { keyframe: true });
  await h.pause(1800);

  // 7. The human's own annotation, on a wrong answer (one the agent missed, if any).
  const annotateId = score.missed[0] ?? TRUTH.wrongIds[0];
  const listRow = page.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*${annotateId}\\s*$`) }) }).first();
  await h.click(listRow.locator('td').first(), { pause: 900 }); // the ID cell: the Rating cell's stars would rate the row
  const dlg = page.locator('dialog[open]').last();
  await dlg.getByRole('heading', { name: new RegExp(`^Interaction #${annotateId}\\b`) }).waitFor({ timeout: 15000 });
  await dlg.getByRole('button', { name: 'Save Annotation' }).waitFor({ timeout: 15000 });
  const opened = await dialogState(page);
  await h.moveTo(dlg.getByText('Response', { exact: true }).first(), { dy: 40, settle: 1600 });
  const rating = 1;
  const note = 'Checked against my books: this answer is wrong. Do not train on it.';
  await h.click(dlg.locator(`button[title="Rate ${rating}"]`), { pause: 600 });
  const notes = dlg.locator('textarea:not([name])').first();
  await h.type(notes, note, { delay: 35, pause: 600 });
  await h.click(dlg.getByRole('button', { name: 'Save Annotation' }), { pause: 400 });
  await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 10000 });
  await h.pause(1500);
  const savedRow = page.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^\\s*${annotateId}\\s*$`) }) }).first();
  await h.moveTo(savedRow.locator('td').first(), { settle: 800 });
  const rowText = clean(await savedRow.innerText());
  log('human-annotation-saved', { interactionId: annotateId, rating, note, agentPresent: /Agent present/i.test(rowText), labelsVisibleWhenOpened: !opened.blind, verdict: TRUTH.byId[annotateId]?.verdict ?? null, row: rowText }, { keyframe: true });
  await h.pause(2200);

  // 8. Two SFT exports. First the default (no opt-ins), then with accepted judge rows and agent-present labels ticked on
  //    camera (a press-and-hold). The difference is what the default export leaves out.
  const opts = page.getByTestId('export-options');
  const boxes = opts.locator('input[type=checkbox]');
  const boxJudge = opts.locator('label', { hasText: 'Include accepted agent judgements' }).locator('input[type=checkbox]');
  const boxAgent = opts.locator('label', { hasText: 'Include ratings made while an agent had access' }).locator('input[type=checkbox]');
  const status = opts.getByRole('status');
  const statusNow = async () => ((await status.count()) ? clean(await status.innerText()) : '');
  const agentPresentRows = await page.locator('tbody tr').filter({ hasText: 'Agent present' }).count();

  const exportSft = async (variant, trigger) => {
    const checked = await boxes.evaluateAll((ns) => ns.map((n) => n.checked));
    const prev = await statusNow();
    const file = path.join(ctx.paths.beatDir, `export-sft-${variant}.jsonl`);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), trigger()]);
    const statusText = await page.waitForFunction((p) => {
      const n = document.querySelector('[data-testid="export-options"] [role="status"]');
      const t = (n?.textContent || '').replace(/\s+/g, ' ').trim();
      return t && t !== p ? t : null;
    }, prev, { timeout: 10000 }).then((hnd) => hnd.jsonValue(), () => '');
    const provenance = /\(([^)]+)\)\.?\s*$/.exec(statusText)?.[1] ?? null;
    let body = null;
    if (download) { await download.saveAs(file); body = fs.readFileSync(file, 'utf8'); }
    // Current human labels (rating + whether made while an agent was present), read from the API, invisible on camera.
    const list = await ctx.api('/api/interactions?limit=100&offset=0');
    const human = Object.fromEntries((Array.isArray(list.body) ? list.body : []).filter((r) => r.rating !== null).map((r) => [r.id, { rating: r.rating, via: r.annotation_via }]));
    const sft = summarizeSft(body ?? '', { details: DETAILS, seed: SEED, human, provenance, includeAgentPresent: !!checked[1] });
    if ((await status.count()) > 0) await h.moveTo(status, { settle: 300 });
    log('export-done', {
      kind: 'sft', variant, includeJudge: checked[0] ?? null, includeAgentPresent: checked[1] ?? null, includeHandoff: checked[2] ?? null,
      downloaded: !!download, file: download ? file : null, suggestedFilename: download?.suggestedFilename() ?? null, bytes: body?.length ?? 0,
      rows: sft.rows, judgeRows: sft.judgeRows, humanRows: sft.humanRows, interactionIdsInFile: sft.interactionIdsInFile,
      lines: sft.lines, parseErrors: sft.parseErrors, provenance: sft.provenance, status: statusText, humanLabels: human,
      excludedAgentPresent: agentPresentRows, acceptedJudgements: afterReview.tiles.accepted,
    }, { keyframe: true });
    await h.pause(3400); // hold on the result (>= 3 s)
    return { checked, sft };
  };

  // 8a. Default: three opt-ins unchecked.
  await h.moveTo(page.getByText('Include accepted agent judgements', { exact: true }), { settle: 1400 });
  await exportSft('default', () => h.click(page.getByRole('button', { name: 'Export SFT', exact: true }), { pause: 300 }));

  // 8b. Tick both opt-ins on camera, then hold "Hold to export SFT".
  await h.click(boxJudge, { pause: 600 });
  await h.click(boxAgent, { pause: 600 });
  const ticked = await boxes.evaluateAll((ns) => ns.map((n) => n.checked));
  if (!ticked[0] || !ticked[1] || ticked[2]) throw new Error(`export opt-ins are ${JSON.stringify(ticked)} after ticking judge + agent-present`);
  const holdBtn = opts.getByRole('button', { name: 'Hold to export SFT' }); // its name reads "Read the card…" until armed
  await holdBtn.waitFor({ timeout: 10000 });
  await h.pause(500);
  await exportSft('with-judge', () => h.hold(holdBtn, 1300));

  // 8c. Back to the default state: untick whatever is still ticked (the product resets the opt-ins after each export).
  const left = await boxes.evaluateAll((ns) => ns.map((n) => n.checked));
  const unticked = [];
  for (const [i, box] of [[0, boxJudge], [1, boxAgent]]) {
    if (left[i]) { await h.click(box, { pause: 500 }); unticked.push(i === 0 ? 'includeJudge' : 'includeAgentPresent'); }
    else await h.moveTo(box, { settle: 500 });
  }
  const final = await boxes.evaluateAll((ns) => ns.map((n) => n.checked));
  log('export-options-default', { before: left, unticked, after: final, resetByProduct: !left[0] && !left[1] });
  if (final.some(Boolean)) throw new Error(`export opt-ins not back to default: ${JSON.stringify(final)}`);
  await h.pause(1200);
  log('beat-end');
}
