import { describe, test, expect, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { exportSftJsonl, exportDpoJsonl, getTrainingStats, exportProvenance } from '../training/export.js';
import { insertProposals, setJudgementStatus, revokeJudgement, setJudgementDwellMs, writeHumanVersion } from '../training/annotations.js';
import { HANDOFF_BLOCK_HEADER_PREFIX } from '../training/handoff-block.js';

function insertInteraction(db: Database, opts: {
  run_id: string;
  sequence_num?: number;
  call_type?: string;
  model?: string;
  system_prompt?: string | null;
  user_prompt: string;
  response_content?: string;
  tool_calls_json?: string | null;
}): number {
  const result = db.prepare(`
    INSERT INTO llm_interactions
      (run_id, sequence_num, call_type, model, provider, system_prompt, user_prompt, response_content, tool_calls_json, status)
    VALUES (@run_id, @sequence_num, @call_type, @model, @provider, @system_prompt, @user_prompt, @response_content, @tool_calls_json, 'ok')
  `).run({
    run_id: opts.run_id,
    sequence_num: opts.sequence_num ?? 1,
    call_type: opts.call_type ?? 'agent',
    model: opts.model ?? 'gpt-4',
    provider: 'openai',
    system_prompt: opts.system_prompt ?? null,
    user_prompt: opts.user_prompt,
    response_content: opts.response_content ?? 'Sure, here is the answer.',
    tool_calls_json: opts.tool_calls_json ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid as number;
}

function insertAnnotation(db: Database, opts: {
  interaction_id: number;
  rating?: number | null;
  preference?: string | null;
  pair_id?: string | null;
}): void {
  db.prepare(`
    INSERT INTO interaction_annotations (interaction_id, rating, preference, pair_id)
    VALUES (@interaction_id, @rating, @preference, @pair_id)
  `).run({
    interaction_id: opts.interaction_id,
    rating: opts.rating ?? null,
    preference: opts.preference ?? null,
    pair_id: opts.pair_id ?? null,
  });
}

function insertToolResult(db: Database, opts: {
  interaction_id: number;
  tool_call_id: string;
  tool_name: string;
  tool_result?: string;
}): void {
  db.prepare(`
    INSERT INTO llm_tool_results (interaction_id, tool_call_id, tool_name, tool_args_json, tool_result)
    VALUES (@interaction_id, @tool_call_id, @tool_name, @tool_args_json, @tool_result)
  `).run({
    interaction_id: opts.interaction_id,
    tool_call_id: opts.tool_call_id,
    tool_name: opts.tool_name,
    tool_args_json: '{}',
    tool_result: opts.tool_result ?? 'result',
  });
}

describe('training export', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('exportSftJsonl', () => {
    test('empty db returns empty string', () => {
      const result = exportSftJsonl(db);
      expect(result).toBe('');
    });

    test('with rated interactions returns valid JSONL', () => {
      const id = insertInteraction(db, {
        run_id: 'run-1',
        system_prompt: 'You are a helpful assistant.',
        user_prompt: 'What is my balance?',
        response_content: 'Your balance is $1000.',
      });
      insertAnnotation(db, { interaction_id: id, rating: 5 });

      const result = exportSftJsonl(db);
      expect(result.length).toBeGreaterThan(0);

      const parsed = JSON.parse(result);
      expect(parsed.messages).toBeDefined();
      expect(parsed.messages.length).toBeGreaterThanOrEqual(3); // system + user + assistant
      expect(parsed.messages[0].role).toBe('system');
      expect(parsed.messages[1].role).toBe('user');
      expect(parsed.messages[2].role).toBe('assistant');
    });

    test('with tool calls includes tool_calls field', () => {
      const toolCalls = JSON.stringify([
        { id: 'tc-1', name: 'transaction_search', args: { query: 'groceries' } },
      ]);
      const id = insertInteraction(db, {
        run_id: 'run-2',
        user_prompt: 'Find grocery transactions',
        response_content: 'Found 3 transactions.',
        tool_calls_json: toolCalls,
      });
      insertAnnotation(db, { interaction_id: id, rating: 4 });
      insertToolResult(db, {
        interaction_id: id,
        tool_call_id: 'tc-1',
        tool_name: 'transaction_search',
        tool_result: '[{"description": "Grocery Store", "amount": -85}]',
      });

      const result = exportSftJsonl(db);
      const parsed = JSON.parse(result);
      const assistantMsg = parsed.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistantMsg.tool_calls).toBeDefined();
      expect(assistantMsg.tool_calls[0].function.name).toBe('transaction_search');

      const toolMsg = parsed.messages.find((m: { role: string }) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe('tc-1');
    });

    test('filter by model', () => {
      const id1 = insertInteraction(db, {
        run_id: 'run-3',
        model: 'gpt-4',
        user_prompt: 'Q1',
        response_content: 'A1',
      });
      insertAnnotation(db, { interaction_id: id1, rating: 5 });

      const id2 = insertInteraction(db, {
        run_id: 'run-4',
        model: 'claude-3',
        user_prompt: 'Q2',
        response_content: 'A2',
      });
      insertAnnotation(db, { interaction_id: id2, rating: 5 });

      const gptOnly = exportSftJsonl(db, { model: 'gpt-4' });
      const claudeOnly = exportSftJsonl(db, { model: 'claude-3' });

      // Each should produce exactly one line
      expect(gptOnly.split('\n').filter(Boolean)).toHaveLength(1);
      expect(claudeOnly.split('\n').filter(Boolean)).toHaveLength(1);

      const gptParsed = JSON.parse(gptOnly);
      expect(gptParsed.messages.find((m: { role: string }) => m.role === 'user').content).toBe('Q1');

      const claudeParsed = JSON.parse(claudeOnly);
      expect(claudeParsed.messages.find((m: { role: string }) => m.role === 'user').content).toBe('Q2');
    });

    test('low-rated interactions are excluded', () => {
      const id = insertInteraction(db, {
        run_id: 'run-5',
        user_prompt: 'Bad answer',
        response_content: 'Wrong info.',
      });
      insertAnnotation(db, { interaction_id: id, rating: 2 });

      const result = exportSftJsonl(db);
      expect(result).toBe('');
    });
  });

  describe('exportDpoJsonl', () => {
    test('no pairs returns empty', () => {
      const result = exportDpoJsonl(db);
      expect(result).toBe('');
    });

    test('with chosen/rejected pair returns valid JSONL', () => {
      const chosenId = insertInteraction(db, {
        run_id: 'run-dpo-1',
        system_prompt: 'Be helpful.',
        user_prompt: 'Summarize my spending',
        response_content: 'Good detailed answer.',
      });
      const rejectedId = insertInteraction(db, {
        run_id: 'run-dpo-2',
        system_prompt: 'Be helpful.',
        user_prompt: 'Summarize my spending',
        response_content: 'Bad vague answer.',
      });

      insertAnnotation(db, { interaction_id: chosenId, preference: 'chosen', pair_id: 'pair-1' });
      insertAnnotation(db, { interaction_id: rejectedId, preference: 'rejected', pair_id: 'pair-1' });

      const result = exportDpoJsonl(db);
      expect(result.length).toBeGreaterThan(0);

      const parsed = JSON.parse(result);
      expect(parsed.prompt).toBe('Summarize my spending');
      expect(parsed.chosen).toBeDefined();
      expect(parsed.rejected).toBeDefined();

      const chosenAssistant = parsed.chosen.find((m: { role: string }) => m.role === 'assistant');
      expect(chosenAssistant.content).toBe('Good detailed answer.');

      const rejectedAssistant = parsed.rejected.find((m: { role: string }) => m.role === 'assistant');
      expect(rejectedAssistant.content).toBe('Bad vague answer.');
    });
  });

  describe('getTrainingStats', () => {
    test('empty db returns all zeros', () => {
      const stats = getTrainingStats(db);
      expect(stats.totalInteractions).toBe(0);
      expect(stats.annotated).toBe(0);
      expect(stats.sftReady).toBe(0);
      expect(stats.dpoPairs).toBe(0);
    });

    test('with data returns correct counts', () => {
      const id1 = insertInteraction(db, { run_id: 'stats-1', user_prompt: 'Q1' });
      const id2 = insertInteraction(db, { run_id: 'stats-2', user_prompt: 'Q2' });
      insertInteraction(db, { run_id: 'stats-3', user_prompt: 'Q3' }); // no annotation

      insertAnnotation(db, { interaction_id: id1, rating: 5 });
      insertAnnotation(db, { interaction_id: id2, rating: 3, pair_id: 'pair-stats' });

      const stats = getTrainingStats(db);
      expect(stats.totalInteractions).toBe(3);
      expect(stats.annotated).toBe(2);
      expect(stats.sftReady).toBe(1); // only rating >= 4
      // P4a: 'pair-stats' has only one side, so it is not a complete pair (it used to count any pair_id).
      expect(stats.dpoPairs).toBe(0);
    });
  });
});


// ── P4a: provenance-aware exports ────────────────────────────────────────────

const lines = (jsonl: string): string[] => jsonl.split('\n').filter(Boolean);
const userOf = (line: string): string =>
  (JSON.parse(line).messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content;

function propose(db: Database, interactionId: number, rating: number, principalId = 'p1') {
  const res = insertProposals(db, {
    principalId,
    createdVia: 'webmcp',
    judgeModel: 'test-model',
    rubricVersion: 'rv1',
    items: [{ interactionId, rating, rationale: 'grounded: every number matches the tool result' }],
  });
  if (!res.ok || res.ids.length !== 1) throw new Error('proposal not created');
  return res.ids[0];
}

function accept(db: Database, id: number) {
  const r = setJudgementStatus(db, id, 'accept', { reviewedBy: null, minAgeMs: 0 });
  if (!r.ok) throw new Error(r.reason);
}

describe('P4a exports: human labels by default, opt-ins for the rest', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setJudgementDwellMs(0);
  });

  test('default export excludes accepted judge rows; includeJudge adds them', () => {
    const humanId = insertInteraction(db, { run_id: 'h', user_prompt: 'human-rated' });
    insertAnnotation(db, { interaction_id: humanId, rating: 5 });
    const judgedId = insertInteraction(db, { run_id: 'j', user_prompt: 'judge-rated' });
    accept(db, propose(db, judgedId, 5));

    expect(lines(exportSftJsonl(db)).map(userOf)).toEqual(['human-rated']);
    expect(lines(exportSftJsonl(db, { includeJudge: true })).map(userOf).sort()).toEqual(['human-rated', 'judge-rated']);
  });

  test('proposed, rejected and superseded judge rows are never exported, even with includeJudge', () => {
    const a = insertInteraction(db, { run_id: 'a', user_prompt: 'proposed' });
    const b = insertInteraction(db, { run_id: 'b', user_prompt: 'rejected' });
    const c = insertInteraction(db, { run_id: 'c', user_prompt: 'superseded' });
    propose(db, a, 5);
    setJudgementStatus(db, propose(db, b, 5), 'reject', { reviewedBy: null, minAgeMs: 0 });
    propose(db, c, 5, 'p-old'); // same principal re-proposing supersedes; use the same key below
    propose(db, c, 1, 'p-old'); // supersedes the 5-star proposal; the new one is still only proposed
    expect(exportSftJsonl(db, { includeJudge: true })).toBe('');
    expect(getTrainingStats(db, { includeJudge: true }).sftReady).toBe(0);
  });

  test('a revoked accepted judge row drops out of the opt-in export', () => {
    const id = insertInteraction(db, { run_id: 'r', user_prompt: 'to revoke' });
    const row = propose(db, id, 5);
    accept(db, row);
    expect(lines(exportSftJsonl(db, { includeJudge: true }))).toHaveLength(1);
    expect(revokeJudgement(db, row, { reviewedBy: null }).ok).toBe(true);
    expect(exportSftJsonl(db, { includeJudge: true })).toBe('');
  });

  test('the human row wins over an accepted judge row on the same interaction', () => {
    const id = insertInteraction(db, { run_id: 'both', user_prompt: 'both rated' });
    insertAnnotation(db, { interaction_id: id, rating: 2 }); // human says no
    accept(db, propose(db, id, 5)); // judge says yes
    expect(exportSftJsonl(db, { includeJudge: true })).toBe('');
    const readiness = getTrainingStats(db, { includeJudge: true });
    expect(readiness.sftReady).toBe(0);
  });

  test('accepting a judge row never touches the human row', () => {
    const id = insertInteraction(db, { run_id: 'snap', user_prompt: 'snapshot' });
    insertAnnotation(db, { interaction_id: id, rating: 4 });
    const before = db.prepare("SELECT * FROM interaction_annotations WHERE source = 'human'").all();
    accept(db, propose(db, id, 1));
    expect(db.prepare("SELECT * FROM interaction_annotations WHERE source = 'human'").all()).toEqual(before);
  });

  test('agent-present human rows are excluded by default and included with includeAgentPresent', () => {
    const a = insertInteraction(db, { run_id: 'normal', user_prompt: 'normal' });
    insertAnnotation(db, { interaction_id: a, rating: 5 });
    const b = insertInteraction(db, { run_id: 'present', user_prompt: 'agent present' });
    writeHumanVersion(db, b, { rating: 5 }, { createdVia: 'dashboard_agent_present' });

    expect(lines(exportSftJsonl(db)).map(userOf)).toEqual(['normal']);
    expect(lines(exportSftJsonl(db, { includeAgentPresent: true })).map(userOf).sort()).toEqual(['agent present', 'normal']);
    expect(getTrainingStats(db).sftReady).toBe(1);
    expect(getTrainingStats(db, { includeAgentPresent: true }).sftReady).toBe(2);
  });

  test('an agent-present human row still shadows an accepted judge row (judge opt-in does not resurrect it)', () => {
    const id = insertInteraction(db, { run_id: 'shadow', user_prompt: 'shadow' });
    writeHumanVersion(db, id, { rating: 1 }, { createdVia: 'dashboard_agent_present' });
    accept(db, propose(db, id, 5));
    expect(exportSftJsonl(db, { includeJudge: true })).toBe('');
  });

  test('sftReady equals the number of SFT lines, counting runs not rows', () => {
    // One run with three rated interactions is ONE line, not three.
    for (let seq = 1; seq <= 3; seq++) {
      const id = insertInteraction(db, { run_id: 'multi', sequence_num: seq, user_prompt: `step ${seq}` });
      insertAnnotation(db, { interaction_id: id, rating: 5 });
    }
    const solo = insertInteraction(db, { run_id: 'solo', user_prompt: 'solo' });
    insertAnnotation(db, { interaction_id: solo, rating: 4 });
    const low = insertInteraction(db, { run_id: 'low', user_prompt: 'low' });
    insertAnnotation(db, { interaction_id: low, rating: 2 });
    const other = insertInteraction(db, { run_id: 'cat', user_prompt: 'other call type', call_type: 'categorization' });
    insertAnnotation(db, { interaction_id: other, rating: 5 });

    const stats = getTrainingStats(db);
    expect(stats.sftReady).toBe(lines(exportSftJsonl(db)).length);
    expect(stats.sftReady).toBe(2);
  });

  test('dpoPairs counts complete pairs only', () => {
    const c1 = insertInteraction(db, { run_id: 'c1', user_prompt: 'P' });
    const r1 = insertInteraction(db, { run_id: 'r1', user_prompt: 'P' });
    insertAnnotation(db, { interaction_id: c1, preference: 'chosen', pair_id: 'complete' });
    insertAnnotation(db, { interaction_id: r1, preference: 'rejected', pair_id: 'complete' });
    const lonely = insertInteraction(db, { run_id: 'lonely', user_prompt: 'P' });
    insertAnnotation(db, { interaction_id: lonely, preference: 'chosen', pair_id: 'half' });

    expect(getTrainingStats(db).dpoPairs).toBe(1);
    expect(lines(exportDpoJsonl(db))).toHaveLength(1);
  });

  test('the DPO export needs both sides to qualify', () => {
    const c = insertInteraction(db, { run_id: 'c', user_prompt: 'P' });
    const r = insertInteraction(db, { run_id: 'r', user_prompt: 'P' });
    insertAnnotation(db, { interaction_id: c, preference: 'chosen', pair_id: 'x' });
    writeHumanVersion(db, r, { preference: 'rejected', pairId: 'x' }, { createdVia: 'dashboard_agent_present' });
    expect(exportDpoJsonl(db)).toBe('');
    expect(lines(exportDpoJsonl(db, { includeAgentPresent: true }))).toHaveLength(1);
  });

  test('export provenance names what the export may contain', () => {
    expect(exportProvenance()).toBe('human');
    expect(exportProvenance({ includeJudge: true })).toBe('human+judge');
    expect(exportProvenance({ includeJudge: true, includeAgentPresent: true, includeHandoff: true })).toBe('human+judge+agent-present+handoff');
  });
});

describe('P4a exports: agent-present provenance is sticky', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setJudgementDwellMs(0);
  });

  test('a later tags-only or notes-only edit without an agent keeps an agent-written rating out of the default export', () => {
    const id = insertInteraction(db, { run_id: 'sticky', user_prompt: 'sticky' });
    const v1 = writeHumanVersion(db, id, { rating: 5 }, { createdVia: 'dashboard_agent_present' });
    expect(v1.created_via).toBe('dashboard_agent_present');
    expect(exportSftJsonl(db)).toBe('');

    const v2 = writeHumanVersion(db, id, { tags: ['ok'] }, { createdVia: 'dashboard' });
    expect(v2.rating).toBe(5);
    expect(v2.created_via).toBe('dashboard_agent_present');
    expect(exportSftJsonl(db)).toBe('');

    const v3 = writeHumanVersion(db, id, { notes: 'looks fine' }, { createdVia: 'dashboard' });
    expect(v3.created_via).toBe('dashboard_agent_present');
    expect(exportSftJsonl(db)).toBe('');
    expect(lines(exportSftJsonl(db, { includeAgentPresent: true }))).toHaveLength(1);
  });

  test('inherited preference or pair id keeps the provenance too, even when the rating is re-sent', () => {
    const id = insertInteraction(db, { run_id: 'sticky-pair', user_prompt: 'p' });
    writeHumanVersion(db, id, { preference: 'chosen', pairId: 'x' }, { createdVia: 'dashboard_agent_present' });
    expect(writeHumanVersion(db, id, { rating: 5 }, { createdVia: 'dashboard' }).created_via).toBe('dashboard_agent_present');
  });

  test('a person who sends every label field explicitly takes the label over: the new version is a clean dashboard row', () => {
    const id = insertInteraction(db, { run_id: 'adopt', user_prompt: 'adopt' });
    writeHumanVersion(db, id, { rating: 5, preference: 'chosen', pairId: 'x' }, { createdVia: 'dashboard_agent_present' });
    const v2 = writeHumanVersion(db, id, { rating: 5, preference: null, pairId: null }, { createdVia: 'dashboard' });
    expect(v2.created_via).toBe('dashboard');
    expect(lines(exportSftJsonl(db))).toHaveLength(1);
    // And it stays clean for later edits that only touch tags.
    expect(writeHumanVersion(db, id, { tags: ['t'] }, { createdVia: 'dashboard' }).created_via).toBe('dashboard');
  });

  test('an agent-present row with no label (notes only) does not taint the next clean edit', () => {
    const id = insertInteraction(db, { run_id: 'nolabel', user_prompt: 'n' });
    writeHumanVersion(db, id, { notes: 'hello' }, { createdVia: 'dashboard_agent_present' });
    expect(writeHumanVersion(db, id, { rating: 4 }, { createdVia: 'dashboard' }).created_via).toBe('dashboard');
  });
});

describe('P4a exports: a human-negative interaction is never pulled in by a judge row on its run', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    setJudgementDwellMs(0);
  });

  test('an accepted judge 5 on interaction B does not bring in a run whose interaction A a person rated 1', () => {
    const a = insertInteraction(db, { run_id: 'run', sequence_num: 1, user_prompt: 'A bad answer' });
    const b = insertInteraction(db, { run_id: 'run', sequence_num: 2, user_prompt: 'B' });
    insertAnnotation(db, { interaction_id: a, rating: 1 });
    accept(db, propose(db, b, 5));
    expect(exportSftJsonl(db, { includeJudge: true })).toBe('');
    expect(getTrainingStats(db, { includeJudge: true }).sftReady).toBe(0);
  });

  test('an agent-present human 1 still counts as a human negative', () => {
    const a = insertInteraction(db, { run_id: 'run', sequence_num: 1, user_prompt: 'A' });
    const b = insertInteraction(db, { run_id: 'run', sequence_num: 2, user_prompt: 'B' });
    writeHumanVersion(db, a, { rating: 1 }, { createdVia: 'dashboard_agent_present' });
    accept(db, propose(db, b, 5));
    expect(exportSftJsonl(db, { includeJudge: true })).toBe('');
  });

  test('a run a person already qualified stays in the opt-in export (it is still a superset of the default)', () => {
    const a = insertInteraction(db, { run_id: 'run', sequence_num: 1, user_prompt: 'A good' });
    const b = insertInteraction(db, { run_id: 'run', sequence_num: 2, user_prompt: 'B' });
    const c = insertInteraction(db, { run_id: 'run', sequence_num: 3, user_prompt: 'C low' });
    insertAnnotation(db, { interaction_id: a, rating: 5 });
    insertAnnotation(db, { interaction_id: c, rating: 1 });
    accept(db, propose(db, b, 5));
    expect(lines(exportSftJsonl(db))).toHaveLength(1);
    expect(lines(exportSftJsonl(db, { includeJudge: true }))).toHaveLength(1);
  });

  test('a judge-only run with no human rating inside it still exports with includeJudge', () => {
    const a = insertInteraction(db, { run_id: 'run', sequence_num: 1, user_prompt: 'A' });
    insertInteraction(db, { run_id: 'run', sequence_num: 2, user_prompt: 'B' });
    accept(db, propose(db, a, 5));
    expect(lines(exportSftJsonl(db, { includeJudge: true }))).toHaveLength(1);
  });
});

describe('P4a exports: browser-subagent handoff blocks', () => {
  const handoffPrompt = `${HANDOFF_BLOCK_HEADER_PREFIX} \u2014 UNTRUSTED, computed in the browser. Hints only.]\nsearch: coffee 42.10\n[End of on-device assistant notes]\n\nHow much did I spend on coffee?`;
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test('runs whose prompt carries a handoff block are excluded unless includeHandoff', () => {
    const plain = insertInteraction(db, { run_id: 'plain', user_prompt: 'plain question' });
    insertAnnotation(db, { interaction_id: plain, rating: 5 });
    const handed = insertInteraction(db, { run_id: 'handed', user_prompt: handoffPrompt });
    insertAnnotation(db, { interaction_id: handed, rating: 5 });

    expect(lines(exportSftJsonl(db)).map(userOf)).toEqual(['plain question']);
    expect(lines(exportSftJsonl(db, { includeHandoff: true }))).toHaveLength(2);
    const stats = getTrainingStats(db);
    expect(stats.sftReady).toBe(1);
    expect(stats.handoffExcluded.sft).toBe(1);
    expect(getTrainingStats(db, { includeHandoff: true }).sftReady).toBe(2);
  });

  test('a run is excluded when any one of its interactions carries a block', () => {
    const first = insertInteraction(db, { run_id: 'mixed', sequence_num: 1, user_prompt: 'first' });
    insertInteraction(db, { run_id: 'mixed', sequence_num: 2, user_prompt: handoffPrompt });
    insertAnnotation(db, { interaction_id: first, rating: 5 });
    expect(exportSftJsonl(db)).toBe('');
  });

  test('a DPO pair with a block on either side is excluded unless includeHandoff', () => {
    const c = insertInteraction(db, { run_id: 'c', user_prompt: 'P' });
    const r = insertInteraction(db, { run_id: 'r', user_prompt: handoffPrompt });
    insertAnnotation(db, { interaction_id: c, preference: 'chosen', pair_id: 'hp' });
    insertAnnotation(db, { interaction_id: r, preference: 'rejected', pair_id: 'hp' });
    expect(exportDpoJsonl(db)).toBe('');
    expect(getTrainingStats(db).dpoPairs).toBe(0);
    expect(getTrainingStats(db).handoffExcluded.dpo).toBe(1);
    expect(lines(exportDpoJsonl(db, { includeHandoff: true }))).toHaveLength(1);
  });
});

describe('P4a acceptance: proposals are inert until accepted, and accepting is not exporting', () => {
  test('20 proposals change neither the stats nor the default export; accepting 5 changes the default export by 0 lines, the opt-in export by exactly 5, and a revoke removes one', () => {
    const db = createTestDb();
    setJudgementDwellMs(0);
    // Three runs a person rated 5 and twenty unrated ones.
    for (let i = 0; i < 3; i++) {
      const id = insertInteraction(db, { run_id: `human-${i}`, user_prompt: `human ${i}` });
      insertAnnotation(db, { interaction_id: id, rating: 5 });
    }
    const unrated = Array.from({ length: 20 }, (_, i) => insertInteraction(db, { run_id: `u-${i}`, user_prompt: `unrated ${i}` }));
    const baseline = { stats: getTrainingStats(db), lines: lines(exportSftJsonl(db)).length };
    expect(baseline.lines).toBe(3);

    const result = insertProposals(db, {
      principalId: 'agent-1',
      createdVia: 'webmcp',
      judgeModel: 'm',
      rubricVersion: 'rv',
      items: unrated.map((interactionId) => ({ interactionId, rating: 5, rationale: 'grounded: every number matches the tool result' })),
    });
    expect(result.ok && result.created).toBe(20);
    const afterProposals = getTrainingStats(db);
    expect(afterProposals.sftReady).toBe(baseline.stats.sftReady);
    expect(afterProposals.dpoPairs).toBe(baseline.stats.dpoPairs);
    expect(afterProposals.annotated).toBe(baseline.stats.annotated);
    expect(afterProposals.judge.proposed).toBe(20);
    expect(lines(exportSftJsonl(db)).length).toBe(baseline.lines);
    expect(lines(exportSftJsonl(db, { includeJudge: true })).length).toBe(baseline.lines); // proposed rows never export, opt-in or not

    const ids = (result as { ids: number[] }).ids;
    for (const id of ids.slice(0, 5)) accept(db, id);
    expect(lines(exportSftJsonl(db)).length).toBe(baseline.lines); // default: +0
    expect(lines(exportSftJsonl(db, { includeJudge: true })).length).toBe(baseline.lines + 5); // opt-in: exactly the 5
    expect(getTrainingStats(db).sftReady).toBe(baseline.lines);
    expect(getTrainingStats(db, { includeJudge: true }).sftReady).toBe(baseline.lines + 5);

    expect(revokeJudgement(db, ids[0], { reviewedBy: null }).ok).toBe(true);
    expect(lines(exportSftJsonl(db, { includeJudge: true })).length).toBe(baseline.lines + 4);
    expect(lines(exportSftJsonl(db)).length).toBe(baseline.lines);
  });
});
