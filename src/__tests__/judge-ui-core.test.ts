import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_LABEL_NOTICE,
  BLIND_NOTICE,
  BULK_ACCEPT_MAX,
  DEFAULT_EXPORT_CHOICES,
  INITIAL_BLIND_STATE,
  JUDGE_ENABLE_AFTER_MS,
  JUDGE_HOLD_MS,
  agreementLabel,
  annotateBody,
  bulkConfirmText,
  bulkEligible,
  exportFileName,
  exportNeedsHold,
  exportPath,
  gapIsLarge,
  isAgentPresentLabel,
  labelPrefill,
  labelsHidden,
  nextBlindState,
  queueHeader,
  queueUrl,
  acceptedHeader,
  replaceUrls,
  withoutHumanLabels,
} from '../dashboard/judge-ui-core.js';
import { CARD_ENABLE_AFTER_MS, CARD_HOLD_MS } from '../mcp/confirmation-card.js';
import { exportProvenance } from '../training/export.js';

/**
 * The Training tab's judge rules. The BLIND RULE test is the one P3 carried over as binding: a Training detail panel
 * opened by an agent (`open_interaction`) must not show the human's rating, preference, notes or pair id until a
 * person interacts with it.
 */

const UI_SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dashboard', 'ui', 'src');
const read = (rel: string): string => readFileSync(join(UI_SRC, rel), 'utf8');

describe('blind rule: an agent-opened detail panel hides the human label until a person interacts', () => {
  test('a panel a person opened shows labels; one an agent opened hides them', () => {
    expect(labelsHidden(nextBlindState(INITIAL_BLIND_STATE, { type: 'open', byAgent: false }))).toBe(false);
    expect(labelsHidden(nextBlindState(INITIAL_BLIND_STATE, { type: 'open', byAgent: true }))).toBe(true);
    expect(BLIND_NOTICE).toContain('agent opened');
  });

  test('only a trusted interaction reveals; a synthetic event does not', () => {
    const opened = nextBlindState(INITIAL_BLIND_STATE, { type: 'open', byAgent: true });
    const synthetic = nextBlindState(opened, { type: 'interact', isTrusted: false });
    expect(labelsHidden(synthetic)).toBe(true);
    const real = nextBlindState(opened, { type: 'interact', isTrusted: true });
    expect(labelsHidden(real)).toBe(false);
    // Once revealed it stays revealed for this panel.
    expect(labelsHidden(nextBlindState(real, { type: 'interact', isTrusted: false }))).toBe(false);
  });

  test('opening another panel (or the same one again) by agent starts hidden again; closing resets', () => {
    const revealed = nextBlindState(nextBlindState(INITIAL_BLIND_STATE, { type: 'open', byAgent: true }), { type: 'interact', isTrusted: true });
    expect(labelsHidden(nextBlindState(revealed, { type: 'open', byAgent: true }))).toBe(true);
    expect(labelsHidden(nextBlindState(revealed, { type: 'open', byAgent: false }))).toBe(false);
    expect(nextBlindState(revealed, { type: 'close' })).toEqual(INITIAL_BLIND_STATE);
  });

  test('the withheld detail has no rating, preference, notes, pair id, tags, version or "rated" trace in it', () => {
    const detail = {
      id: 7,
      user_prompt: 'Q',
      annotation: { rating: 5, preference: 'chosen', pair_id: 'pair-1', notes: 'SECRET-HUMAN-NOTE', tags: '["x"]', created_via: 'dashboard' },
      annotations: [{ rating: 5, preference: 'chosen', pair_id: 'pair-1', notes: 'SECRET-HUMAN-NOTE' }],
      history: [{ rating: 2, notes: 'older SECRET-HUMAN-NOTE' }, { rating: 5 }],
      judgements: [{ id: 3, rating: 3, status: 'proposed' }],
    };
    const hidden = withoutHumanLabels(detail);
    const text = JSON.stringify(hidden);
    expect(text).not.toContain('SECRET-HUMAN-NOTE');
    expect(text).not.toContain('pair-1');
    expect(text).not.toContain('chosen');
    expect(hidden.annotation).toBeNull();
    expect(hidden.annotations).toEqual([]);
    expect(hidden.history).toEqual([]);
    // The agent's own judgements are not a human label: they stay.
    expect(hidden.judgements).toEqual(detail.judgements);
    expect(hidden.user_prompt).toBe('Q');
    expect(detail.annotation.rating).toBe(5); // the input is untouched
  });

  test('LlmTab wires it: open_interaction opens by agent, every load goes through the mask, a trusted pointer or key reveals', () => {
    const src = read('tabs/LlmTab.tsx');
    expect(src).toContain("from '@judge-ui'");
    // The agent handler marks the request as agent-opened.
    expect(src).toMatch(/open_interaction:[\s\S]{0,400}byAgent:\s*true/);
    // Detail data passes through withoutHumanLabels while labels are hidden, so state never holds them.
    expect(src).toContain('withoutHumanLabels(');
    expect(src).toContain('labelsHidden(');
    expect(src).toContain('BLIND_NOTICE');
    // The panel listens for real pointer and key events and passes isTrusted.
    expect(src).toMatch(/type:\s*'interact',\s*isTrusted:\s*[A-Za-z.]*isTrusted/);
    expect(src).toMatch(/onPointerDownCapture|onKeyDownCapture/);
    // A person's click on a row opens a visible panel.
    expect(src).toMatch(/byAgent:\s*false/);
  });
});

describe('judge queue rules', () => {
  test('replaceUrls turns links into [link], including bare domains with a path', () => {
    expect(replaceUrls('see https://evil.example/x?y=1 and www.evil.example now')).toBe('see [link] and [link] now');
    expect(replaceUrls('open evil.example/accept-all please')).toBe('open [link] please');
    expect(replaceUrls('grounded: totals match, 12.50 vs 12.50')).toBe('grounded: totals match, 12.50 vs 12.50');
  });

  test('agreement is shown with n, in the spec wording', () => {
    expect(agreementLabel({ n: 23, within1Pct: 78 })).toBe('agreement 78% on n=23 blind proposals (within ±1)');
    expect(agreementLabel({ n: 0, within1Pct: null })).toBe('agreement: no blind proposals yet');
    expect(agreementLabel(null)).toBe('agreement: no blind proposals yet');
    expect(queueHeader(5, { n: 23, within1Pct: 78 })).toBe('5 proposals · agreement 78% on n=23 blind proposals (within ±1)');
    expect(queueHeader(1, null)).toBe('1 proposal · agreement: no blind proposals yet');
  });

  test('a gap of two stars or more is flagged; a missing human rating never is', () => {
    expect(gapIsLarge(5, 3)).toBe(true);
    expect(gapIsLarge(1, 4)).toBe(true);
    expect(gapIsLarge(4, 3)).toBe(false);
    expect(gapIsLarge(4, null)).toBe(false);
    expect(gapIsLarge(4, undefined)).toBe(false);
  });

  test('bulk accept takes only rows the person expanded, in selection order, at most 10', () => {
    expect(BULK_ACCEPT_MAX).toBe(10);
    const selected = Array.from({ length: 14 }, (_, i) => i + 1);
    const expanded = new Set(selected.filter((i) => i !== 2));
    const eligible = bulkEligible(selected, expanded);
    expect(eligible).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(eligible).toHaveLength(10);
    expect(bulkEligible([5], new Set())).toEqual([]);
    expect(bulkConfirmText(6)).toBe("Accept 6 judgements? They'll be eligible for export only when you opt in.");
    expect(bulkConfirmText(1)).toBe("Accept 1 judgement? They'll be eligible for export only when you opt in.");
  });

  test('the enable delay and the hold match the approval card', () => {
    expect(JUDGE_ENABLE_AFTER_MS).toBe(CARD_ENABLE_AFTER_MS);
    expect(JUDGE_HOLD_MS).toBe(CARD_HOLD_MS);
  });
});

describe('training export choices', () => {
  test('every opt-in starts off', () => {
    expect(DEFAULT_EXPORT_CHOICES).toEqual({ includeJudge: false, includeAgentPresent: false, includeHandoff: false });
    expect(exportPath('sft', DEFAULT_EXPORT_CHOICES)).toBe('/api/export/training/sft');
    expect(exportPath('dpo', DEFAULT_EXPORT_CHOICES)).toBe('/api/export/training/dpo');
    expect(exportNeedsHold(DEFAULT_EXPORT_CHOICES)).toBe(false);
  });

  test('each choice is its own query flag; the file name says "with-judge" only for judge rows', () => {
    expect(exportPath('sft', { ...DEFAULT_EXPORT_CHOICES, includeJudge: true })).toBe('/api/export/training/sft?includeJudge=true');
    expect(exportPath('sft', { includeJudge: true, includeAgentPresent: true, includeHandoff: true })).toBe(
      '/api/export/training/sft?includeJudge=true&includeAgentPresent=true&includeHandoff=true'
    );
    expect(exportFileName('sft', DEFAULT_EXPORT_CHOICES)).toBe('wilson-sft.jsonl');
    expect(exportFileName('sft', { ...DEFAULT_EXPORT_CHOICES, includeJudge: true })).toBe('wilson-sft-with-judge.jsonl');
    expect(exportFileName('dpo', { ...DEFAULT_EXPORT_CHOICES, includeAgentPresent: true })).toBe('wilson-dpo.jsonl');
    expect(exportNeedsHold({ ...DEFAULT_EXPORT_CHOICES, includeAgentPresent: true })).toBe(true);
  });

  test('the query flags are exactly the ones the server reads', () => {
    for (const key of ['includeJudge', 'includeAgentPresent', 'includeHandoff'] as const) {
      const choices = { ...DEFAULT_EXPORT_CHOICES, [key]: true };
      expect(exportPath('sft', choices)).toBe(`/api/export/training/sft?${key}=true`);
      expect(exportProvenance({ [key]: true })).not.toBe('human');
    }
  });

  test('training exports download with fetch and an Authorization header, never a ?token= URL, and the choices reset after each export', () => {
    const tab = read('tabs/LlmTab.tsx');
    expect(tab).toContain('<ExportOptions');
    expect(tab).not.toContain('?token=');
    expect(tab).not.toMatch(/\/api\/export\/training/);
    const options = read('components/judge/ExportOptions.tsx');
    expect(options).not.toContain('token=');
    expect(options).toContain('authedFetch(exportPath(');
    expect(read('api.ts')).toMatch(/Authorization/); // authedFetch adds it
    expect(options).toContain('URL.createObjectURL');
    expect(options).toContain('setChoices(DEFAULT_EXPORT_CHOICES)');
    expect(options).toContain('useState<ExportChoices>(DEFAULT_EXPORT_CHOICES)');
  });
});

describe('judge components', () => {
  function listFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? listFiles(full) : [full];
    });
  }

  test('no dangerouslySetInnerHTML under ui/src/components/judge, and the directory exists', () => {
    const files = listFiles(join(UI_SRC, 'components', 'judge'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toContain('dangerouslySetInnerHTML');
  });

  test('an agent-written rationale is rendered through replaceUrls under an AGENT-WRITTEN label, and the model is DECLARED BY AGENT', () => {
    const queue = read('components/judge/JudgeQueue.tsx');
    expect(queue).toContain('replaceUrls(');
    // 10px uppercase labels (the brand allows uppercase for tiny labels only).
    expect(queue).toMatch(/uppercase[^\n]*>\s*Agent-written/i);
    expect(queue).toMatch(/uppercase[^\n]*>Declared by agent</i);
    expect(queue).toContain('isTrusted');
  });

  test('A3: the queue has an Accepted view that reads status=accepted and revokes through the revoke route, for people who can act only', () => {
    const queue = read('components/judge/JudgeQueue.tsx');
    expect(queue).toContain('queueUrl(view');
    expect(queue).toContain("'accepted'");
    expect(queue).toContain('/revoke');
    expect(queue).toMatch(/canAct && \(\s*<div[^>]*>\s*<button[\s\S]*?Revoke/);
  });

  test('the judge form carries its own tool name, no autosubmit, and the human controls never do', () => {
    const form = read('components/judge/JudgeInteractionForm.tsx');
    expect(form).toContain("tool: 'propose_judgment'");
    expect(form).not.toContain('toolautosubmit');
    const tab = read('tabs/LlmTab.tsx');
    expect(tab).not.toMatch(/toolname/);
    expect(tab).toContain('JudgeInteractionForm');
    expect(tab).toContain('JudgementHistory');
  });
});

describe('the label form never turns an agent-written label into the person\'s own', () => {
  const agentLabel = { rating: 5, preference: 'chosen', pair_id: 'p1', notes: 'n', created_via: 'dashboard_agent_present' };
  const humanLabel = { ...agentLabel, created_via: 'dashboard' };

  test('a human label prefills the form; an agent-present label prefills only the notes', () => {
    expect(labelPrefill(humanLabel)).toEqual({ rating: 5, preference: 'chosen', pairId: 'p1', notes: 'n' });
    expect(labelPrefill(agentLabel)).toEqual({ rating: 0, preference: '', pairId: '', notes: 'n' });
    expect(labelPrefill(null)).toEqual({ rating: 0, preference: '', pairId: '', notes: '' });
    expect(isAgentPresentLabel(agentLabel)).toBe(true);
    expect(isAgentPresentLabel(humanLabel)).toBe(false);
    expect(AGENT_LABEL_NOTICE).toContain('Rate it again');
  });

  test('saving an agent-present label without re-rating sends no label field, so the server keeps it flagged', () => {
    expect(annotateBody(labelPrefill(agentLabel), agentLabel)).toEqual({ notes: 'n' });
  });

  test('re-rating adopts the whole label on screen: preference and pair id go explicitly, null when empty', () => {
    expect(annotateBody({ rating: 4, preference: '', pairId: '', notes: '' }, agentLabel)).toEqual({ rating: 4, preference: null, pairId: null });
    expect(annotateBody({ rating: 4, preference: 'chosen', pairId: 'p2', notes: 'x' }, agentLabel)).toEqual({ rating: 4, preference: 'chosen', pairId: 'p2', notes: 'x' });
  });

  test('a human label saves exactly what is filled in', () => {
    expect(annotateBody(labelPrefill(humanLabel), humanLabel)).toEqual({ rating: 5, preference: 'chosen', pairId: 'p1', notes: 'n' });
    expect(annotateBody({ rating: 0, preference: '', pairId: '', notes: '' }, humanLabel)).toEqual({});
  });
});

describe('A3: the Accepted view of the judge queue', () => {
  test('reads GET /api/judgements?status=accepted, with a cursor when paging', () => {
    expect(queueUrl('accepted')).toBe('/api/judgements?status=accepted&limit=50');
    expect(queueUrl('proposed')).toBe('/api/judgements?status=proposed&limit=50');
    expect(queueUrl('accepted', '50')).toBe('/api/judgements?status=accepted&limit=50&cursor=50');
  });

  test('its header counts accepted rows and says how to take one back', () => {
    expect(acceptedHeader(1)).toBe('1 accepted judgement · exported only when you opt in · revoke to take one back');
    expect(acceptedHeader(3)).toContain('3 accepted judgements');
  });
});
