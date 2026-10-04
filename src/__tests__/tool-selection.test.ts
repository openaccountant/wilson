import { describe, expect, test } from 'bun:test';
import { createFakeEmbedder } from './fake-embedder.js';
import {
  CORE_TOOLS,
  SELECTION_DEFAULTS,
  growSelection,
  selectTools,
  selectionTexts,
  toolsNamedIn,
  type SkillCandidate,
  type ToolCandidate,
} from '../agent/tool-selection.js';
import {
  createCachedEmbedder,
  skillCardText,
  toolCardText,
  whenToUseBullets,
} from '../agent/tool-cards.js';

// Cards share no words except where a test wants overlap, so the fake
// embedder's word-overlap cosine makes rankings readable.
function tool(name: string, card: string, schemaTokens = 100): ToolCandidate {
  return { name, card, schemaTokens };
}

const REGISTRY: ToolCandidate[] = [
  tool('transaction_search', 'find specific purchases merchant lookup', 67),
  tool('spending_summary', 'totals per category period', 100),
  tool('csv_import', 'import bank statement csv file', 157),
  tool('categorize', 'assign categories uncategorized', 90),
  tool('edit_transaction', 'change fix modify one record', 80),
  tool('delete_transaction', 'remove erase record', 70),
  tool('budget_set', 'set monthly limit cap', 90),
  tool('budget_check', 'limit status progress', 80),
  tool('goal_manage', 'savings target vacation fund', 342),
  tool('memory_manage', 'remember facts note', 197),
  tool('tax_flag', 'deductible schedule c business expense', 190),
  tool('export_transactions', 'spreadsheet xlsx download', 144),
  tool('profit_loss', 'income versus expenses quarter', 110),
  tool('profit_diff', 'variance between months drivers', 100),
  tool('plaid_sync', 'refresh linked banks', 30),
  tool('web_search', 'internet lookup current rates', 60),
  tool('skill', 'run workflow instructions', 81),
];
const NAMES = REGISTRY.map((t) => t.name);

const SKILLS: SkillCandidate[] = [
  { name: 'month-end-close', card: 'close books month end reconcile' },
  { name: 'subscription-audit', card: 'audit subscriptions recurring cancel' },
];

describe('tool cards', () => {
  test('When-to-Use bullets are pulled from the rich description', () => {
    const rich = 'Intro.\n\n## When to Use\n\n- When A\n- When "B"\n\n## When NOT to Use\n\n- Never C';
    expect(whenToUseBullets(rich)).toEqual(['When A', 'When "B"']);
    expect(whenToUseBullets('no sections here')).toEqual([]);
  });

  test('a card is the spaced name, the short description and the bullets', () => {
    const card = toolCardText({
      name: 'csv_import',
      tool: { description: 'Import a CSV.' },
      description: '## When to Use\n\n- When the user has a statement\n',
    });
    expect(card).toBe('csv import: Import a CSV. When the user has a statement');
    expect(skillCardText({ name: 'month-end-close', description: 'Close the books.' })).toBe(
      'month end close: Close the books.',
    );
  });

  test('the cached embedder embeds each distinct text once', async () => {
    const fake = createFakeEmbedder();
    const cached = createCachedEmbedder(fake.embed);
    const a = await cached(['one', 'two']);
    const b = await cached(['two', 'three', 'one']);
    expect(fake.calls).toEqual(['one', 'two', 'three']);
    expect(b[0]).toBe(a[1]);
    expect(b[2]).toBe(a[0]);
  });
});

describe('selectTools', () => {
  test('core tools are always selected, everything else is indexed by name', async () => {
    const sel = await selectTools({ query: 'hello there', tools: REGISTRY, embed: createFakeEmbedder().embed });
    for (const core of CORE_TOOLS) expect(sel.tools).toContain(core);
    expect(new Set([...sel.tools, ...sel.indexed])).toEqual(new Set(NAMES));
    expect(sel.tools.some((t) => sel.indexed.includes(t))).toBe(false);
    expect(sel.reasons.transaction_search).toBe('core');
  });

  test('the best-matching tools by embedding are selected', async () => {
    const sel = await selectTools({
      query: 'import my bank statement csv',
      tools: REGISTRY,
      embed: createFakeEmbedder().embed,
    });
    expect(sel.tools).toContain('csv_import');
    expect(sel.reasons.csv_import).toMatch(/^embedding|keyword/);
    expect(sel.fallback).toBe(false);
  });

  test('a tool or skill named in the query is forced in', async () => {
    const sel = await selectTools({
      query: 'please run plaid_sync and then month end close',
      tools: REGISTRY,
      skills: SKILLS,
      embed: createFakeEmbedder().embed,
      options: { kMax: 0, kMin: 0 },
    });
    expect(sel.tools).toContain('plaid_sync');
    expect(sel.reasons.plaid_sync).toBe('named');
    expect(sel.skills).toContain('month-end-close');
    // A selected skill brings the skill tool with it.
    expect(sel.tools).toContain('skill');
  });

  test('tools used in the last turns stay selected (sticky)', async () => {
    const sel = await selectTools({
      query: 'and for August?',
      tools: REGISTRY,
      stickyTools: ['tax_flag', 'not_registered'],
      embed: createFakeEmbedder().embed,
      options: { kMax: 0, kMin: 0 },
    });
    expect(sel.tools).toContain('tax_flag');
    expect(sel.reasons.tax_flag).toBe('used recently');
    expect(sel.tools).not.toContain('not_registered');
  });

  test('kMin is filled regardless of the floor; kMax caps ranked picks', async () => {
    const embed = createFakeEmbedder().embed;
    const none = await selectTools({ query: 'zzz qqq', tools: REGISTRY, embed, options: { floor: 0.99 } });
    const ranked = none.tools.filter((t) => !CORE_TOOLS.includes(t));
    expect(ranked.length).toBe(SELECTION_DEFAULTS.kMin);

    const capped = await selectTools({ query: 'zzz qqq', tools: REGISTRY, embed, options: { floor: -1, kMax: 4 } });
    expect(capped.tools.filter((t) => !CORE_TOOLS.includes(t)).length).toBe(4);
  });

  test('the floor drops weak matches once kMin is met', async () => {
    const sel = await selectTools({
      query: 'remove erase record',
      tools: REGISTRY,
      embed: createFakeEmbedder().embed,
      options: { kMin: 1, floor: 0.5 },
    });
    const ranked = sel.tools.filter((t) => !CORE_TOOLS.includes(t));
    expect(ranked).toEqual(['delete_transaction']);
  });

  test('packing never exceeds the tool budget', async () => {
    const budget = 400;
    const sel = await selectTools({
      query: 'savings target vacation fund remember facts deductible',
      tools: REGISTRY,
      embed: createFakeEmbedder().embed,
      options: { toolBudget: budget, floor: -1, kMax: 20, kMin: 20 },
    });
    expect(sel.tokens.tools).toBeLessThanOrEqual(budget);
    const cost = new Map(REGISTRY.map((t) => [t.name, t.schemaTokens]));
    expect(sel.tokens.tools).toBe(sel.tools.reduce((n, t) => n + cost.get(t)!, 0));
    // goal_manage (342) cannot fit next to the core (167).
    expect(sel.tools).not.toContain('goal_manage');
  });

  test('keyword groups boost a tool the embedding alone ranks low', async () => {
    const embed = createFakeEmbedder().embed;
    // No card shares a word with this query; the "budget" keyword group lifts
    // budget_set / budget_check above the rest.
    const sel = await selectTools({ query: 'am I over budget', tools: REGISTRY, embed, options: { kMin: 2, floor: 0.1 } });
    expect(sel.tools).toEqual(expect.arrayContaining(['budget_set', 'budget_check']));
    expect(sel.reasons.budget_check).toContain('keyword');
  });

  test('a short follow-up inherits the previous question', async () => {
    const embed = createFakeEmbedder().embed;
    const sel = await selectTools({
      query: 'do the same again',
      prevQuery: 'remove erase record',
      tools: REGISTRY,
      embed,
      options: { kMin: 0, floor: 0.3 },
    });
    expect(sel.tools).toContain('delete_transaction');

    // A long, self-contained question does not.
    const long = await selectTools({
      query: 'please show me the totals per category for each period of this year so far',
      prevQuery: 'remove erase record',
      tools: REGISTRY,
      embed,
      options: { kMin: 0, floor: 0.3 },
    });
    expect(long.tools).not.toContain('delete_transaction');
  });

  test('selection texts: anaphora or ≤ 8 words pull in the previous message', () => {
    expect(selectionTexts('now delete it', 'find the Netflix charge')).toEqual({
      current: 'now delete it',
      previous: 'find the Netflix charge',
    });
    expect(selectionTexts('this is a long question with more than eight words in the text', 'x').previous).toBeNull();
    expect(selectionTexts('this is a long question that also mentions those same charges', 'x').previous).toBe('x');
    expect(selectionTexts('hi', null).previous).toBeNull();
  });

  test('skills clear the cut by embedding; weak matches stay names-only', async () => {
    const embed = createFakeEmbedder().embed;
    const hit = await selectTools({ query: 'audit subscriptions recurring', tools: REGISTRY, skills: SKILLS, embed });
    expect(hit.skills).toEqual(['subscription-audit']);
    expect(hit.tools).toContain('skill');

    const miss = await selectTools({
      query: 'totals per category',
      tools: REGISTRY.filter((t) => t.name !== 'skill'),
      skills: SKILLS,
      embed,
    });
    expect(miss.skills).toEqual([]);
  });

  test('when embedding fails: core + keyword groups + sticky (+ named)', async () => {
    const broken = async () => {
      throw new Error('no model');
    };
    const sel = await selectTools({
      query: 'set a grocery budget',
      tools: REGISTRY,
      stickyTools: ['memory_manage'],
      embed: broken,
    });
    expect(sel.fallback).toBe(true);
    expect(sel.tools).toEqual(expect.arrayContaining([...CORE_TOOLS, 'budget_set', 'budget_check', 'memory_manage']));
    expect(sel.tools).not.toContain('csv_import');
    expect(sel.reasons.budget_set).toBe('keyword');

    const noEmbedder = await selectTools({ query: 'set a grocery budget', tools: REGISTRY, embed: null });
    expect(noEmbedder.fallback).toBe(true);
    expect(noEmbedder.tools).toContain('budget_set');
  });

  test('deterministic: same inputs, same output, same order', async () => {
    const run = () =>
      selectTools({
        query: 'change the Starbucks charge to Dining',
        prevQuery: 'find coffee purchases',
        tools: REGISTRY,
        skills: SKILLS,
        stickyTools: ['categorize'],
        embed: createFakeEmbedder().embed,
      });
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
  });

  test('only registered tools are ever selected', async () => {
    const small = REGISTRY.filter((t) => t.name === 'transaction_search' || t.name === 'csv_import');
    const sel = await selectTools({ query: 'import csv', tools: small, embed: createFakeEmbedder().embed });
    expect(new Set([...sel.tools, ...sel.indexed])).toEqual(new Set(['transaction_search', 'csv_import']));
  });
});

describe('growSelection', () => {
  test('a called out-of-subset tool joins the set; nothing is removed', async () => {
    const sel = await selectTools({ query: 'hello', tools: REGISTRY, embed: createFakeEmbedder().embed });
    expect(sel.tools).not.toContain('plaid_sync');
    const { selection, added } = growSelection(sel, { called: ['plaid_sync'] }, REGISTRY);
    expect(added).toContain('plaid_sync');
    expect(selection.reasons.plaid_sync).toBe('called');
    for (const t of sel.tools) expect(selection.tools).toContain(t);
    expect(selection.indexed).not.toContain('plaid_sync');
    expect(new Set([...selection.tools, ...selection.indexed])).toEqual(new Set(NAMES));
  });

  test('affinities follow the trigger tool (search → edit/delete, import → categorize)', async () => {
    const sel = await selectTools({ query: 'hello', tools: REGISTRY, embed: createFakeEmbedder().embed, options: { kMin: 0, kMax: 0 } });
    const afterSearch = growSelection(sel, { called: ['transaction_search'] }, REGISTRY).selection;
    expect(afterSearch.tools).toEqual(expect.arrayContaining(['edit_transaction', 'delete_transaction']));
    expect(afterSearch.reasons.edit_transaction).toBe('after transaction_search');

    const afterImport = growSelection(sel, { called: ['csv_import'] }, REGISTRY).selection;
    expect(afterImport.tools).toEqual(expect.arrayContaining(['csv_import', 'categorize']));
  });

  test('skill-referenced tools are added', async () => {
    const sel = await selectTools({ query: 'hello', tools: REGISTRY, embed: createFakeEmbedder().embed, options: { kMin: 0, kMax: 0 } });
    const { selection } = growSelection(sel, { skillTools: ['profit_loss', 'unknown_tool'] }, REGISTRY);
    expect(selection.tools).toContain('profit_loss');
    expect(selection.reasons.profit_loss).toBe('skill');
    expect(selection.tools).not.toContain('unknown_tool');
  });

  test('affinity and skill growth respect the tool budget; called tools always join', async () => {
    const sel = await selectTools({
      query: 'hello',
      tools: REGISTRY,
      embed: createFakeEmbedder().embed,
      options: { kMin: 0, kMax: 0, toolBudget: 200 },
    });
    const { selection } = growSelection(
      sel,
      { called: ['goal_manage'], skillTools: ['tax_flag'] },
      REGISTRY,
      { toolBudget: 200 },
    );
    expect(selection.tools).toContain('goal_manage');
    expect(selection.tools).not.toContain('tax_flag');
  });

  test('no change reports nothing added', async () => {
    const sel = await selectTools({ query: 'hello', tools: REGISTRY, embed: createFakeEmbedder().embed });
    const { selection, added } = growSelection(sel, { called: ['spending_summary'] }, REGISTRY);
    expect(added).toEqual([]);
    expect(selection.tools).toEqual(sel.tools);
  });

  test('tool names mentioned in skill instructions are found', () => {
    expect(toolsNamedIn('Step 1: call transaction_search, then profit_loss. Not profit_lossy.', NAMES)).toEqual([
      'transaction_search',
      'profit_loss',
    ]);
  });
});
