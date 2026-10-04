// node --test demos/rig/b10-judge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundTruthFrom, verdictCorrect, catchScore, planDecisions, parseJudgeCard, parseJudgeTile, summarizeSft } from './beats/b10-judge.mjs';

// The seed's shape: 12 runs, 4 wrong, the last one has a tool-call step (2 interactions).
const seed = Array.from({ length: 12 }, (_, i) => ({ prompt: `Question ${String.fromCharCode(65 + i)}?`, response: `Answer ${i}`, wrong: [3, 5, 7, 10].includes(i), tool: i === 11 ? 'budget_status' : null }));
const details = [
  ...seed.slice(0, 11).map((s, i) => ({ id: i + 1, user_prompt: `Query: ${s.prompt}`, response_content: s.response })),
  { id: 12, user_prompt: `Query: ${seed[11].prompt}`, response_content: '' },
  { id: 13, user_prompt: `Original question: ${seed[11].prompt}\n### budget_status(...)`, response_content: seed[11].response },
];

test('ground truth comes from the seed flags, matched by question', () => {
  const t = groundTruthFrom(seed, details);
  assert.deepEqual(t.problems, []);
  assert.deepEqual(t.wrongIds, [4, 6, 8, 11]);
  assert.equal(t.goodIds.length, 9);
  assert.equal(t.byId[12].step, 'tool-call');
  assert.equal(t.byId[12].verdict, 'good');
});

test('ground truth fails loudly on drift', () => {
  assert.match(groundTruthFrom(seed, details.slice(0, 12)).problems.join(' '), /expected 13 interactions/);
  const changed = details.map((d) => (d.id === 4 ? { ...d, response_content: 'something else' } : d));
  assert.match(groundTruthFrom(seed, changed).problems.join(' '), /#4 answer differs/);
  const stray = [...details.slice(0, 12), { id: 99, user_prompt: 'Query: unseeded?', response_content: 'x' }];
  assert.match(groundTruthFrom(seed, stray).problems.join(' '), /#99 matches no seeded question/);
});

test('verdicts', () => {
  assert.equal(verdictCorrect('wrong', 1), true);
  assert.equal(verdictCorrect('wrong', 2), true);
  assert.equal(verdictCorrect('wrong', 3), false);
  assert.equal(verdictCorrect('good', 3), true);
  assert.equal(verdictCorrect('good', 2), false);
  assert.equal(verdictCorrect('good', null), false);
});

test('catch score and decisions', () => {
  const t = groundTruthFrom(seed, details);
  const proposals = [
    { proposalId: 1, interactionId: 4, rating: 1, rationale: 'wrong total for July groceries' },
    { proposalId: 2, interactionId: 6, rating: 4, rationale: 'looks plausible' },
    { proposalId: 3, interactionId: 1, rating: 2, rationale: 'seems off' },
    { proposalId: 4, interactionId: 2, rating: 5, rationale: 'matches the client payments' },
  ];
  const s = catchScore(t, proposals);
  assert.deepEqual(s.caught, [4]);
  assert.deepEqual(s.missed, [6, 8, 11]);
  assert.deepEqual(s.falseAlarms, [1]);
  const plan = planDecisions(t, proposals);
  assert.deepEqual(plan.map((p) => p.decision), ['accept', 'reject', 'reject', 'accept']);
  assert.equal(plan[1].reason, 'rated a wrong answer 4');
});

test('all correct: the shortest rationale is rejected as weak; a single proposal is not', () => {
  const t = groundTruthFrom(seed, details);
  const plan = planDecisions(t, [
    { proposalId: 1, interactionId: 4, rating: 1, rationale: 'the July grocery total is overstated' },
    { proposalId: 2, interactionId: 2, rating: 4, rationale: 'fine answer here' },
  ]);
  assert.deepEqual(plan.map((p) => [p.decision, p.reason]), [['accept', 'caught a wrong answer (rated 1)'], ['reject', 'weak rationale']]);
  assert.deepEqual(planDecisions(t, [{ proposalId: 1, interactionId: 4, rating: 1, rationale: 'x' }]).map((p) => p.decision), ['accept']);
  assert.equal(planDecisions(t, [{ proposalId: 9, interactionId: 77, rating: 1, rationale: 'x' }])[0].decision, 'reject');
});

test('judge card read', () => {
  const rows = [['judgements', '—', '3'], ['interactions', '—', '#4, #6, #2'], ['ratings', '—', '1, 2, 5'], ['judge model (declared by agent)', '—', 'claude-sonnet'], ['rubric', '—', 'a1b2c3']];
  const ok = parseJudgeCard('Confirm: Propose Judgements', rows, [2, 4, 6]);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.ids, [4, 6, 2]);
  assert.deepEqual(ok.ratings, [1, 2, 5]);
  assert.match(parseJudgeCard('Confirm: Propose Judgements', rows, [2, 4]).problems.join(' '), /#6 do not exist/);
  assert.match(parseJudgeCard('Confirm: Categorize Transaction', rows, [2, 4, 6]).problems.join(' '), /not a judge proposal/);
  const extra = [...rows, ['category', 'Dining', 'Travel']];
  assert.match(parseJudgeCard('Confirm: Propose Judgements', extra, [2, 4, 6]).problems.join(' '), /rows a judge proposal does not have/);
  const bad = rows.map((r) => (r[0] === 'ratings' ? ['ratings', '—', '1, 9, 5'] : r));
  assert.match(parseJudgeCard('Confirm: Propose Judgements', bad, [2, 4, 6]).problems.join(' '), /not 1-5/);
  const trunc = [['judgements', '—', '10'], ['interactions', '—', '#1, #2, #3, #4, #5, #6, #7, #8, …'], ['ratings', '—', '1, 2, 3, 4, 5, 1, 2, 3, …']];
  const tr = parseJudgeCard('Confirm: Propose Judgements', trunc, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(tr.problems, []);
  assert.equal(tr.truncated, true);
  const one = [['judgements', '—', '1'], ['interactions', '—', '#4'], ['ratings', '—', '2'], ['judge model (declared by agent)', '—', 'm'], ['rubric', '—', 'v']];
  assert.deepEqual(parseJudgeCard('Confirm: Judge Interaction', one, [4]).problems, []);
});

test('tile and SFT file', () => {
  assert.deepEqual(parseJudgeTile('JUDGE: PROPOSED / ACCEPTED 3 / 1'), { proposed: 3, accepted: 1 });
  assert.equal(parseJudgeTile('nothing'), null);
  const line = (...pairs) => JSON.stringify({ messages: [{ role: 'system', content: 'sys' }, ...pairs.flatMap(([q, r]) => [{ role: 'user', content: q }, { role: 'assistant', content: r }])] });
  const d = (id) => details.find((x) => x.id === id);
  const def = summarizeSft('', { details, seed, provenance: 'human' });
  assert.equal(def.rows, 0); assert.equal(def.judgeRows, 0); assert.equal(def.humanRows, 0);
  // with-judge: #2 brought in by an accepted judge row; #13's run (two iterations) mapped to [12, 13]; #9 has a human 5.
  const file = [line([d(2).user_prompt, d(2).response_content]), line([d(12).user_prompt, ''], [d(13).user_prompt, d(13).response_content]), line([d(9).user_prompt, d(9).response_content])].join('\n');
  const human = { 4: { rating: 1, via: 'dashboard_agent_present' }, 9: { rating: 5, via: 'dashboard' } };
  const w = summarizeSft(file, { details, seed, human, provenance: 'human+judge+agent-present', includeAgentPresent: true });
  assert.deepEqual(w.interactionIdsInFile, [[2], [12, 13], [9]]);
  assert.equal(w.judgeRows, 2); assert.equal(w.humanRows, 1);
  assert.equal(w.lines[0].question, 'Question B?');
  // an agent-present human 5 does not qualify without the opt-in, so that line can only be a judge row
  const ap = summarizeSft(line([d(9).user_prompt, d(9).response_content]), { details, seed, human: { 9: { rating: 5, via: 'dashboard_agent_present' } }, provenance: 'human+judge' });
  assert.equal(ap.judgeRows, 1);
  // a line whose text does not match exactly is not proven: totals are null
  const odd = summarizeSft(line([d(2).user_prompt, 'edited answer']), { details, seed, provenance: 'human+judge' });
  assert.deepEqual(odd.interactionIdsInFile, [[]]); assert.equal(odd.judgeRows, null); assert.equal(odd.humanRows, null);
  // default provenance: every line is human-qualified by the export's own rule
  assert.equal(summarizeSft(file, { details, seed, provenance: 'human' }).humanRows, 3);
});
