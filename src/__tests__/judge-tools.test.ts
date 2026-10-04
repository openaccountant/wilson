import { afterEach, describe, expect, test } from 'bun:test';
import { createTestDb, ensureTestProfile } from './helpers.js';
import { count, grantTools, makeUser, mintTestToken, testScope } from './mcp-helpers.js';
import { enableAuth, disableAuth } from '../dashboard/auth.js';
import { checkTokenTools, resolveClientToken } from '../mcp/client-tokens.js';
import { visibleToolDefs } from '../mcp/http-server.js';
import { approveWebMcpOperation, callTool, exposedTools, type RequestScope } from '../mcp/engine.js';
import { MCP_TOOL_CATALOG, getToolDef, jsonSchemaFor, parseToolArgs, schemaDigest, toolAnnotations } from '../mcp/tool-catalog.js';
import { setPolicy } from '../mcp/policies.js';
import { setJudgeDailyLimit } from '../mcp/agent-settings.js';
import { DAILY_READ_ROWS, RateLimiter, limiterFor, setLimiterFor } from '../mcp/rate-limit.js';
import { principalFor } from '../mcp/audit.js';
import { JUDGE_RUBRIC, JUDGE_RUBRIC_VERSION } from '../training/judge-rubric.js';
import { HANDOFF_BLOCK_HEADER_PREFIX } from '../training/handoff-block.js';
import { agreement, insertProposals, setJudgementDwellMs } from '../training/annotations.js';
import { CHAIN_ITERATION_CLOSING, ITERATION_PROMPT_CLOSING, ITERATION_TOOL_RESULTS_MARKER, TEAM_ITERATION_CLOSING, buildOrchestrationIterationPrompt } from '../agent/iteration-prompt-format.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * P4a judge tools. A judge agent reads recorded model calls (blind: never a human label, never the system prompt,
 * tool results as previews only) and PROPOSES judgements. Proposals are rows with source='judge', status='proposed'
 * that a human accepts or rejects; nothing a tool can do changes a human row or training data.
 */

const ADMIN = { userId: null, role: 'admin' as const, authEnabled: false };
const RATIONALE = 'grounded: every figure matches the tool result';
const JUDGE_TOOLS = ['list_interactions', 'get_interaction', 'get_judge_rubric', 'propose_judgements', 'judge_interaction'] as const;

afterEach(() => {
  ensureTestProfile();
  setJudgeDailyLimit(300);
});

function addInteraction(
  db: Database,
  opts: { runId?: string; userPrompt?: string; response?: string; systemPrompt?: string | null; toolCalls?: unknown; model?: string; callType?: string; status?: string; error?: string | null } = {}
): number {
  const res = db
    .prepare(
      `INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, system_prompt, user_prompt, response_content, tool_calls_json, status, error)
       VALUES (@runId, 1, @callType, @model, 'openai', @systemPrompt, @userPrompt, @response, @toolCalls, @status, @error)`
    )
    .run({
      runId: opts.runId ?? `run-${Math.random().toString(36).slice(2)}`,
      callType: opts.callType ?? 'agent',
      model: opts.model ?? 'gpt-4',
      systemPrompt: opts.systemPrompt === undefined ? 'You are Wilson. SECRET-SYSTEM-PROMPT. The user lives at 12 Elm St.' : opts.systemPrompt,
      userPrompt: opts.userPrompt ?? 'How much did I spend on coffee?',
      response: opts.response ?? 'You spent $42.10 on coffee.',
      toolCalls: opts.toolCalls === undefined ? null : JSON.stringify(opts.toolCalls),
      status: opts.status ?? 'ok',
      error: opts.error ?? null,
    });
  return (res as { lastInsertRowid: number }).lastInsertRowid as number;
}

function addToolResult(db: Database, interactionId: number, name: string, result: string): void {
  db.prepare(
    `INSERT INTO llm_tool_results (interaction_id, tool_call_id, tool_name, tool_args_json, tool_result) VALUES (@interactionId, 'tc', @name, '{}', @result)`
  ).run({ interactionId, name, result });
}

function addHumanRating(db: Database, interactionId: number, rating: number, notes = 'HUMAN-NOTE-SECRET'): void {
  db.prepare(
    `INSERT INTO interaction_annotations (interaction_id, rating, preference, notes, tags) VALUES (@interactionId, @rating, 'chosen', @notes, '["human-tag"]')`
  ).run({ interactionId, rating, notes });
}

function setup(tools: readonly string[] = JUDGE_TOOLS, scopeOverrides: Partial<RequestScope> = {}, allowProposals = true) {
  const db = createTestDb();
  const scope = testScope(scopeOverrides);
  const grants = grantTools(db, scope, [...tools]);
  if (allowProposals) {
    for (const tool of ['propose_judgements', 'judge_interaction']) {
      if (tools.includes(tool)) expect(setPolicy(db, ADMIN, tool, 'allow').ok).toBe(true);
    }
  }
  setJudgementDwellMs(0);
  const call = (tool: string, args: unknown, transport: 'imperative' | 'declarative' | 'page' | 'http-mcp' = 'imperative') =>
    callTool(db, scope, grants[tool] ?? null, tool, args, transport);
  return { db, scope, grants, call };
}

type Call = ReturnType<typeof setup>['call'];

async function read(call: Call, tool: string, args: unknown = {}): Promise<any> {
  const out = await call(tool, args);
  if (!out.ok) throw new Error(`${tool} refused: ${out.error}`);
  if (out.kind !== 'read') throw new Error(`${tool} gave ${out.kind}`);
  return out.data;
}

const propose = (call: Call, items: unknown[], extra: Record<string, unknown> = {}) =>
  call('propose_judgements', { judgeModel: 'claude-test', rubricVersion: JUDGE_RUBRIC_VERSION, items, ...extra });

const item = (interactionId: number, extra: Record<string, unknown> = {}) => ({ interactionId, rating: 4, rationale: RATIONALE, ...extra });

describe('catalog entries for the judge', () => {
  test('five tools, with the classes, surfaces, transports and policies the spec gives them', () => {
    for (const name of JUDGE_TOOLS) expect(getToolDef(name), name).toBeDefined();
    for (const name of ['list_interactions', 'get_interaction', 'get_judge_rubric']) {
      const def = getToolDef(name)!;
      expect(def.classification).toBe('read');
      expect(def.defaultPolicy).toBe('allow');
      expect(def.minRole).toBe('viewer');
      expect(def.surface as unknown).toEqual({ tab: 'llm' });
      expect([...def.transports]).toEqual(['webmcp', 'http-mcp']);
      expect(def.exposure).toBe('imperative');
    }
    expect(getToolDef('get_judge_rubric')!.untrustedOutput).toBe(false);
    expect(getToolDef('list_interactions')!.untrustedOutput).toBe(true);
    expect(getToolDef('get_interaction')!.untrustedOutput).toBe(true);

    const propose = getToolDef('propose_judgements')!;
    expect(propose.classification).toBe('proposal');
    expect(propose.defaultPolicy).toBe('ask');
    expect(propose.minRole).toBe('admin');
    expect([...propose.transports]).toEqual(['webmcp', 'http-mcp']);

    const form = getToolDef('judge_interaction')!;
    expect(form.classification).toBe('proposal');
    expect(form.exposure).toBe('declarative');
    expect([...form.transports]).toEqual(['webmcp']);
    expect(form.surface as unknown).toEqual({ tab: 'llm' });
    expect(form.autosubmit).not.toBe(true); // the agent submits; a human sees the card
  });

  test('proposal tools are consequential, not read-only; reads are read-only', () => {
    for (const name of ['propose_judgements', 'judge_interaction']) {
      expect(toolAnnotations(name)).toEqual({ readOnlyHint: false, consequentialHint: true, untrustedContentHint: false });
    }
    expect(toolAnnotations('get_interaction')).toEqual({ readOnlyHint: true, consequentialHint: false, untrustedContentHint: true });
  });

  test('propose_judgements has no pair input, no status, no source (the schema is strict)', () => {
    const schema = jsonSchemaFor('propose_judgements') as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['items', 'judgeModel', 'rubricVersion']);
    const itemSchema = (schema.properties.items as { items: { properties: Record<string, unknown>; additionalProperties: unknown } }).items;
    expect(Object.keys(itemSchema.properties).sort()).toEqual(['criteria', 'interactionId', 'preference', 'rating', 'rationale', 'tags']);
    expect(itemSchema.additionalProperties).toBe(false);
    for (const key of ['pairs', 'pair_id', 'pairId', 'status', 'source']) {
      const top = parseToolArgs('propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(1)], [key]: 'x' });
      expect(top.ok, `top-level ${key}`).toBe(false);
      const nested = parseToolArgs('propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(1, { [key]: 'x' })] });
      expect(nested.ok, `item ${key}`).toBe(false);
    }
  });

  test('the judge tools respect the catalog limits: name 30, description 500, param describe 150', () => {
    for (const name of JUDGE_TOOLS) {
      const def = getToolDef(name)!;
      expect(def.name.length).toBeLessThanOrEqual(30);
      expect(def.description.length).toBeLessThanOrEqual(500);
      for (const [key, shape] of Object.entries(def.zodShape)) {
        const text = (shape as { description?: string }).description ?? '';
        expect(text.length, `${name}.${key}`).toBeLessThanOrEqual(150);
      }
    }
  });
});

describe('list_interactions', () => {
  test('is at most 1,500 characters, defaults to unjudged, and pages with a cursor', async () => {
    const { db, call } = setup();
    const ids = Array.from({ length: 12 }, (_, i) => addInteraction(db, { model: `model-${'x'.repeat(40)}-${i}` }));
    const first = await read(call, 'list_interactions');
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(1500);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThanOrEqual(5);
    expect(first.nextCursor).toBeDefined();

    const seen = new Set<number>(first.items.map((r: { id: number }) => r.id));
    let cursor: string | undefined = first.nextCursor;
    for (let guard = 0; cursor && guard < 10; guard++) {
      const page = await read(call, 'list_interactions', { cursor });
      for (const row of page.items) {
        expect(seen.has(row.id)).toBe(false); // no overlap between pages
        seen.add(row.id);
      }
      cursor = page.nextCursor;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(ids);
    // Newest first.
    expect(first.items[0].id).toBe(ids[ids.length - 1]);
  });

  test('"unjudged" hides what this principal already judged; "judged" shows only that; "all" both', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    const b = addInteraction(db);
    expect((await propose(call, [item(a)])).ok).toBe(true);

    const unjudged = await read(call, 'list_interactions');
    expect(unjudged.items.map((r: { id: number }) => r.id)).toEqual([b]);
    const judged = await read(call, 'list_interactions', { filter: 'judged' });
    expect(judged.items.map((r: { id: number }) => r.id)).toEqual([a]);
    expect(judged.items[0].openProposal).toBe(true);
    const all = await read(call, 'list_interactions', { filter: 'all' });
    expect(all.items.map((r: { id: number }) => r.id).sort()).toEqual([a, b].sort());
  });

  test('another principal\'s proposals do not make an interaction "judged" for this one', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    insertProposals(db, { principalId: 'someone-else', createdVia: 'webmcp', judgeModel: 'm', rubricVersion: 'rv', items: [{ interactionId: a, rating: 3, rationale: RATIONALE }] });
    expect((await read(call, 'list_interactions')).items.map((r: { id: number }) => r.id)).toEqual([a]);
  });

  test('filters by call type and model', async () => {
    const { db, call } = setup();
    addInteraction(db, { callType: 'agent', model: 'gpt-4' });
    const cat = addInteraction(db, { callType: 'categorization', model: 'qwen' });
    expect((await read(call, 'list_interactions', { callType: 'categorization' })).items.map((r: { id: number }) => r.id)).toEqual([cat]);
    expect((await read(call, 'list_interactions', { model: 'qwen' })).items.map((r: { id: number }) => r.id)).toEqual([cat]);
  });

  test('marks interactions whose prompt carries a handoff block', async () => {
    const { db, call } = setup();
    const plain = addInteraction(db);
    const handed = addInteraction(db, { userPrompt: `${HANDOFF_BLOCK_HEADER_PREFIX} — UNTRUSTED.]\nx\n[End of on-device assistant notes]\n\nQ?` });
    const out = await read(call, 'list_interactions');
    const byId = new Map<number, Record<string, unknown>>(out.items.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(handed)!.handoffNotes).toBe(true);
    expect(byId.get(plain)!.handoffNotes).toBeUndefined();
  });
});

describe('blind judging: no human label in any judge output', () => {
  test('no judge tool output (nor open_interaction) contains a human rating value, note, tag, preference or rated flag', async () => {
    const { db, call } = setup([...JUDGE_TOOLS, 'open_interaction']);
    const rated = addInteraction(db, { userPrompt: 'rated question', toolCalls: [{ id: 'tc', name: 'transaction_search', args: { query: 'coffee' } }] });
    addToolResult(db, rated, 'transaction_search', JSON.stringify({ items: [{ id: 1, desc: 'Cafe', amount: -4.5 }] }));
    addHumanRating(db, rated, 5, 'HUMAN-NOTE-SECRET');
    const unrated = addInteraction(db);

    const outputs: unknown[] = [];
    outputs.push(await read(call, 'list_interactions', { filter: 'all' }));
    outputs.push(await read(call, 'get_interaction', { id: rated }));
    for (const section of ['user_prompt', 'response', 'tool_calls']) outputs.push(await read(call, 'get_interaction', { id: rated, section }));
    outputs.push(await read(call, 'get_judge_rubric'));
    const opened = await call('open_interaction', { id: rated }, 'page');
    expect(opened.ok).toBe(true);
    outputs.push(opened);
    const proposed = await propose(call, [item(rated), item(unrated)]);
    expect(proposed.ok).toBe(true);
    outputs.push(proposed);

    for (const out of outputs) {
      const text = JSON.stringify(out);
      expect(text).not.toContain('HUMAN-NOTE-SECRET');
      expect(text).not.toContain('human-tag');
      expect(text).not.toContain('chosen');
      expect(text).not.toMatch(/humanRated|human_rated|"rated"|annotated|"human/i);
      // The seeded human rating is 5: no field called rating may carry it in a read.
      expect(text).not.toMatch(/"(rating|humanRating|human_rating)":/);
    }
  });

  test('a judge proposal on a human-rated interaction leaves the human row unchanged (row-level snapshot)', async () => {
    const { db, call } = setup();
    const rated = addInteraction(db);
    addHumanRating(db, rated, 2);
    const before = db.prepare("SELECT * FROM interaction_annotations WHERE source = 'human'").all();
    const out = await propose(call, [item(rated, { rating: 5 })]);
    expect(out.ok).toBe(true);
    expect(db.prepare("SELECT * FROM interaction_annotations WHERE source = 'human'").all()).toEqual(before);
    expect(count(db, 'interaction_annotations', "source = 'judge' AND status = 'proposed'")).toBe(1);
  });
});

describe('get_interaction', () => {
  test('the overview is capped, wraps text as untrusted_text, strips bidi, masks digits and emails', async () => {
    const { db, call } = setup();
    const id = addInteraction(db, {
      userPrompt: `Card 4111 1111 1111 1234 and mail jd@example.com ‮evil​ ${'long '.repeat(200)}`,
      response: `Spent $42.10. Account 123456789012. ${'filler '.repeat(200)}`,
      toolCalls: [{ id: 'tc1', name: 'transaction_search', args: { query: 'coffee' } }],
      error: 'e'.repeat(400),
    });
    addToolResult(db, id, 'transaction_search', JSON.stringify({ items: [{ id: 1, desc: 'Cafe 4111111111111111' }, { id: 2 }], total: 2 }));
    const out = await read(call, 'get_interaction', { id });
    const text = JSON.stringify(out);
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(out.user_prompt.untrusted_text).toBeString();
    expect(out.response.untrusted_text).toBeString();
    expect(text).not.toContain('‮');
    expect(text).not.toContain('​');
    expect(text).not.toContain('4111 1111 1111 1234');
    expect(text).not.toContain('123456789012');
    expect(text).not.toContain('jd@example.com');
    expect(out.user_prompt.untrusted_text).toContain('•••1234');
    expect(out.user_prompt.untrusted_text).toContain('[email]');
    expect(out.response.untrusted_text).toContain('$42.10'); // decimal amounts survive
    expect(out.user_prompt.untrusted_text.length).toBeLessThanOrEqual(300);
    expect(out.response.untrusted_text.length).toBeLessThanOrEqual(500);
    expect(out.tool_calls[0]).toMatchObject({ name: 'transaction_search' });
    expect(out.sectionSizes.response).toBeGreaterThan(500);
    expect(out.id).toBe(id);
    expect(out.model).toBe('gpt-4');
  });

  test('a tool result longer than its preview cannot be reconstructed: 80 characters plus its size, never paged', async () => {
    const { db, call } = setup();
    const id = addInteraction(db);
    const secret = `START-${'x'.repeat(90)}-${'SECRET-TAIL-'.repeat(50)}`;
    addToolResult(db, id, 'transaction_search', secret);
    const overview = await read(call, 'get_interaction', { id });
    const result = overview.tool_results[0];
    expect(result.tool).toBe('transaction_search');
    expect(result.chars).toBe(secret.length);
    expect(result.preview.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(overview)).not.toContain('SECRET-TAIL');
    // No section returns tool results, so there is nothing to page through.
    const refused = await call('get_interaction', { id, section: 'tool_results' });
    expect(refused.ok).toBe(false);
    for (const section of ['user_prompt', 'response', 'tool_calls']) {
      expect(JSON.stringify(await read(call, 'get_interaction', { id, section }))).not.toContain('SECRET-TAIL');
    }
  });

  test('an iteration prompt that embeds the full tool results does not give them back through the user_prompt section', async () => {
    const { db, call } = setup();
    const rows = Array.from({ length: 120 }, (_, i) => ({ merchant: `MERCHANT_${i}`, amount: -(i + 0.5) }));
    const full = JSON.stringify(rows);
    expect(full.length).toBeGreaterThan(1200 * 3);
    // A tool result may quote the closing line of the prompt: the cut still covers everything up to the real one.
    const quoting = `${full} Continue working toward answering the query. QUOTED-TAIL-SECRET`;
    // The shape buildIterationPrompt produces (agent.test.ts mocks it for a whole non-isolated run, so it is spelled out
    // here from the shared constants; prompts.test.ts checks the real builder against the same cut).
    const userPrompt = `Query: what did I buy?\n\n${ITERATION_TOOL_RESULTS_MARKER}\n${quoting}\n\n## Tool Usage This Query\n\n- transaction_search: 1/3 calls\n\n${ITERATION_PROMPT_CLOSING} When you have gathered sufficient data to answer, write your complete answer directly and do not call more tools.`;
    const id = addInteraction(db, { userPrompt });
    addToolResult(db, id, 'transaction_search', quoting);

    const seen: string[] = [];
    const overview = await read(call, 'get_interaction', { id });
    seen.push(JSON.stringify(overview));
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(call, 'get_interaction', { id, section: 'user_prompt', ...(cursor ? { cursor } : {}) });
      seen.push(page.untrusted_text);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    const all = seen.join('\n');
    expect(all).toContain('what did I buy?');
    expect(all).toContain('tool results omitted');
    expect(all).not.toContain('MERCHANT_59');
    expect(all).not.toContain('MERCHANT_119');
    expect(all).not.toContain('QUOTED-TAIL-SECRET');
    expect(all).not.toContain('-59.5');
    // The closing line of the prompt is kept.
    expect(all).toContain('Continue working toward answering the query.');
    expect(overview.sectionSizes.user_prompt).toBeLessThan(600);
  });

  async function pageUserPrompt(call: Call, id: number): Promise<string> {
    const seen: string[] = [JSON.stringify(await read(call, 'get_interaction', { id }))];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(call, 'get_interaction', { id, section: 'user_prompt', ...(cursor ? { cursor } : {}) });
      seen.push(page.untrusted_text);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    return seen.join('\n');
  }

  for (const [kind, closing] of [['chain', CHAIN_ITERATION_CLOSING], ['team', TEAM_ITERATION_CLOSING]] as const) {
    test(`a ${kind} step prompt that embeds the full tool results does not give them back through the user_prompt section`, async () => {
      const { db, call } = setup();
      const rows = Array.from({ length: 200 }, (_, i) => `MERCHANT_${i} amount -${i + 0.5}`);
      // A result may quote the closing line and the heading; the cut still ends at the real closing and starts at the first heading.
      const result = `[transaction_search] ${rows.join('\n')}\n\n${closing} QUOTED-TAIL-SECRET`;
      const stepPrompt = `Original query: what did I buy?\n\nCurrent task input:\nstart\n\nUse the available tools.`;
      const prompt = `${buildOrchestrationIterationPrompt(stepPrompt, [result, '[spending_summary] OTHER-RESULT'], closing)}\n\nYou've reached the iteration limit. Provide your final output now.`;
      expect(result.length).toBeGreaterThan(1200 * 2);
      const id = addInteraction(db, { callType: kind, userPrompt: prompt });
      addToolResult(db, id, 'transaction_search', result);
      const all = await pageUserPrompt(call, id);
      expect(all).toContain('what did I buy?');
      expect(all).toContain('tool results omitted');
      expect(all).not.toContain('MERCHANT_30 ');
      expect(all).not.toContain('MERCHANT_59');
      expect(all).not.toContain('MERCHANT_199');
      expect(all).not.toContain('QUOTED-TAIL-SECRET');
      expect(all).not.toContain('OTHER-RESULT');
      expect(all).toContain('iteration limit'); // the text after the real closing line is kept
    });
  }

  test('a prompt of a call type whose format is not known is not paged, and its overview shows an 80-character preview', async () => {
    const { db, call: rawCall } = setup();
    const clock = { now: Date.now() };
    setLimiterFor(db, new RateLimiter({ now: () => clock.now }));
    const call: Call = (tool, args, transport) => {
      clock.now += 4_000;
      return rawCall(tool, args, transport);
    };
    const prompt = `Unknown shape. ${'TOOLDATA-'.repeat(100)}`;
    for (const callType of ['standalone', 'brand-new-type']) {
      const id = addInteraction(db, { callType, userPrompt: prompt });
      const refused = await call('get_interaction', { id, section: 'user_prompt' });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe('invalid_args');
      const overview = await read(call, 'get_interaction', { id });
      expect(overview.user_prompt.untrusted_text.length).toBeLessThanOrEqual(80);
      // The other sections still work.
      expect((await read(call, 'get_interaction', { id, section: 'response' })).untrusted_text).toContain('coffee');
    }
    // A known call type is unaffected.
    const known = addInteraction(db, { callType: 'categorization', userPrompt: prompt });
    expect((await read(call, 'get_interaction', { id: known, section: 'user_prompt' })).untrusted_text).toContain('TOOLDATA-');
  });

  test('there is no system_prompt section and the system prompt never appears in any output', async () => {
    const { db, call } = setup();
    const id = addInteraction(db);
    const refused = await call('get_interaction', { id, section: 'system_prompt' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(400);
    const everything = [
      await read(call, 'get_interaction', { id }),
      await read(call, 'get_interaction', { id, section: 'user_prompt' }),
      await read(call, 'get_interaction', { id, section: 'response' }),
      await read(call, 'get_interaction', { id, section: 'tool_calls' }),
      await read(call, 'list_interactions', { filter: 'all' }),
    ];
    for (const out of everything) {
      expect(JSON.stringify(out)).not.toContain('SECRET-SYSTEM-PROMPT');
      expect(JSON.stringify(out)).not.toContain('Elm St');
    }
  });

  test('a section is paged with a cursor and reassembles the sanitized text', async () => {
    const { db, call } = setup();
    const response = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const id = addInteraction(db, { response });
    let text = '';
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(call, 'get_interaction', cursor ? { id, section: 'response', cursor } : { id, section: 'response' });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(1500);
      expect(page.section).toBe('response');
      expect(page.untrusted_text.length).toBeLessThanOrEqual(1200);
      text += page.untrusted_text;
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect(text.replace(/\s/g, '')).toBe(response.replace(/\s/g, ''));
  });

  test('masking holds across page boundaries: a card number split between two pages is still masked', async () => {
    const { db, call } = setup();
    // Put 8 digits right at the 1200-character boundary of a sanitized page: "…1234|5678…".
    const filler = 'a'.repeat(1196);
    const id = addInteraction(db, { response: `${filler}12345678 and the rest` });
    const first = await read(call, 'get_interaction', { id, section: 'response' });
    const second = await read(call, 'get_interaction', { id, section: 'response', cursor: first.nextCursor });
    const joined = `${first.untrusted_text}${second.untrusted_text}`;
    expect(joined).not.toContain('12345678');
    expect(joined).not.toContain('1234');
    expect(joined).toContain('•••5678');
  });

  test('a handoff block in the prompt is marked untrusted and shown only as an excerpt', async () => {
    const { db, call } = setup();
    const block = `${HANDOFF_BLOCK_HEADER_PREFIX} — UNTRUSTED, computed in the browser. Hints only.]\n${'LOCAL-NOTE '.repeat(60)}\n[End of on-device assistant notes]`;
    const id = addInteraction(db, { userPrompt: `${block}\n\nWhat did I spend on coffee?` });
    const out = await read(call, 'get_interaction', { id });
    expect(out.user_prompt.handoff_block).toBe(true);
    expect(out.user_prompt.untrusted_text).toContain('What did I spend on coffee?');
    expect(out.user_prompt.untrusted_text).toContain('UNTRUSTED on-device assistant notes');
    // The block is cut to an excerpt: nowhere near 60 repetitions survive.
    expect(out.user_prompt.untrusted_text.split('LOCAL-NOTE').length - 1).toBeLessThan(15);
    const section = await read(call, 'get_interaction', { id, section: 'user_prompt' });
    expect(section.handoff_block).toBe(true);
    expect(section.untrusted_text.split('LOCAL-NOTE').length - 1).toBeLessThan(15);
  });

  test('an unknown interaction is an actionable 404', async () => {
    const { call } = setup();
    const out = await call('get_interaction', { id: 99999 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(404);
      expect(out.error).toContain('list_interactions');
    }
  });

  test('every section page counts against the daily read budget', async () => {
    const { db, call } = setup();
    const id = addInteraction(db);
    const limiter = limiterFor(db);
    const before = limiter.readBudgetUsed('anon');
    await read(call, 'get_interaction', { id, section: 'response' });
    const after = limiter.readBudgetUsed('anon');
    expect(after.rows).toBe(before.rows + 1);
    expect(after.chars).toBeGreaterThan(before.chars);
    // And it stops when the budget is gone.
    limiter.consumeRead('anon', DAILY_READ_ROWS, 0);
    const out = await call('get_interaction', { id });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('read_budget_exceeded');
  });
});

describe('judge reads stay within 1,500 characters on worst-case data', () => {
  test('quotes, backslashes, emoji and many long tool results cannot push an answer past the cap', async () => {
    const { db, call: rawCall } = setup();
    // A walk of hundreds of pages: a fake clock lets the per-tool bucket refill between calls.
    const clock = { now: Date.now() };
    setLimiterFor(db, new RateLimiter({ now: () => clock.now }));
    const call: Call = (tool, args, transport) => {
      clock.now += 4_000;
      return rawCall(tool, args, transport);
    };
    const nasty = '"\\\n\t\u{1F600}"'.repeat(400);
    const id = addInteraction(db, {
      userPrompt: nasty,
      response: nasty,
      error: nasty,
      model: 'm'.repeat(100),
      toolCalls: Array.from({ length: 9 }, (_, i) => ({ id: `tc${i}`, name: `tool_${'n'.repeat(60)}`, args: { q: nasty } })),
    });
    for (let i = 0; i < 9; i++) addToolResult(db, id, `tool_${'n'.repeat(60)}`, nasty);
    expect(JSON.stringify(await read(call, 'get_interaction', { id })).length).toBeLessThanOrEqual(1500);
    for (const section of ['user_prompt', 'response', 'tool_calls']) {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await read(call, 'get_interaction', cursor ? { id, section, cursor } : { id, section });
        expect(JSON.stringify(page).length, `${section} page ${pages}`).toBeLessThanOrEqual(1500);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 400);
      expect(cursor).toBeUndefined(); // the walk reaches the end, however small the pages had to get
    }
    for (let i = 0; i < 12; i++) addInteraction(db, { model: 'm'.repeat(64), callType: 'entity-classification' });
    const listed = await read(call, 'list_interactions', { filter: 'all', limit: 10 });
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(1500);
  });
});

describe('get_judge_rubric', () => {
  test('returns the rubric and a version that is stable for the same content', async () => {
    const { call } = setup();
    const a = await read(call, 'get_judge_rubric');
    const b = await read(call, 'get_judge_rubric');
    expect(a).toEqual(b);
    expect(a.version).toBe(JUDGE_RUBRIC_VERSION);
    expect(a.version).toMatch(/^[0-9a-f]{12}$/);
    expect(a.criteria.map((c: { id: string }) => c.id)).toEqual(JUDGE_RUBRIC.criteria.map((c) => c.id));
    expect(a.scale).toBe('1-5');
    expect(a.rules.length).toBeGreaterThan(0);
    expect(JSON.stringify(a).length).toBeLessThanOrEqual(1500);
  });
});

describe('propose_judgements', () => {
  test('writes source=judge, status=proposed rows only, with provenance, and answers created/ids/skipped', async () => {
    const { db, scope, call } = setup();
    const a = addInteraction(db);
    const out = await propose(call, [item(a, { preference: 'chosen', criteria: { grounded: 4, privacy: 5 }, tags: ['good'] }), item(99999)]);
    expect(out.ok && out.kind === 'read').toBe(true);
    if (!out.ok || out.kind !== 'read') return;
    expect(out.data).toMatchObject({ created: 1, skipped: [{ interactionId: 99999, reason: 'not_found' }] });
    expect((out.data as { ids: number[] }).ids).toHaveLength(1);

    const row = db.prepare("SELECT * FROM interaction_annotations WHERE source = 'judge'").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      interaction_id: a,
      source: 'judge',
      status: 'proposed',
      rating: 4,
      preference: 'chosen',
      judge_model: 'claude-test',
      rubric_version: JUDGE_RUBRIC_VERSION,
      created_via: 'webmcp',
      principal_id: principalFor(scope.sessionGeneration).id,
      rationale: RATIONALE,
      pair_id: null,
      reviewed_by: null,
    });
    expect(JSON.parse(row.criteria_json as string)).toEqual({ grounded: 4, privacy: 5 });
    expect(JSON.parse(row.tags as string)).toEqual(['good']);
    expect(count(db, 'interaction_annotations', "source = 'human'")).toBe(0);
  });

  test('a stale rubricVersion is a 409 rubric_changed and writes nothing', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    const out = await call('propose_judgements', { judgeModel: 'm', rubricVersion: 'stale000000', items: [item(a)] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(409);
      expect(out.code).toBe('rubric_changed');
      expect(out.error).toContain(JUDGE_RUBRIC_VERSION);
    }
    expect(count(db, 'interaction_annotations')).toBe(0);
  });

  test('more than 20 items, zero items, bad ratings, short or long rationales are invalid_args', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    const bad: unknown[][] = [
      Array.from({ length: 21 }, () => item(a)),
      [],
      [item(a, { rating: 6 })],
      [item(a, { rating: 0 })],
      [item(a, { rating: 3.5 })],
      [item(a, { rationale: 'too short' })],
      [item(a, { rationale: 'x'.repeat(601) })],
      [item(a, { tags: ['not-a-tag'] })],
      [item(a, { tags: ['good', 'good', 'good', 'good', 'good', 'good'] })],
      [item(a, { criteria: { grounded: 9 } })],
      [item(a, { criteria: { vibes: 3 } })],
      [item(0)],
    ];
    for (const items of bad) {
      const out = await propose(call, items);
      expect(out.ok, JSON.stringify(items).slice(0, 80)).toBe(false);
      if (!out.ok) expect(out.status).toBe(400);
    }
    expect(count(db, 'interaction_annotations')).toBe(0);
    // 20 is fine.
    const twenty = Array.from({ length: 20 }, (_, i) => item(addInteraction(db), { rating: (i % 5) + 1 }));
    const ok = await propose(call, twenty);
    expect(ok.ok && ok.kind === 'read' && (ok.data as { created: number }).created).toBe(20);
  });

  test('a templated rationale of exactly 20 characters is accepted (open-jev writes no free text); 19 is not', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    const templated = 'open-jev rating: 4/5'; // 20 characters
    expect(templated.length).toBe(20);
    expect((await propose(call, [item(a, { rationale: templated })])).ok).toBe(true);
    const b = addInteraction(db);
    expect((await propose(call, [item(b, { rationale: templated.slice(0, 19) })])).ok).toBe(false);
  });

  test('a rationale may span lines, but hidden or bidi characters are refused', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    expect((await propose(call, [item(a, { rationale: 'grounded: matches\nconcise: yes, brief' })])).ok).toBe(true);
    const b = addInteraction(db);
    const hidden = await propose(call, [item(b, { rationale: 'grounded: looks fine ‮to me' })]);
    expect(hidden.ok).toBe(false);
    const model = await call('propose_judgements', { judgeModel: 'evil model!', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(b)] });
    expect(model.ok).toBe(false); // judgeModel must match /^[\w.:/-]{1,64}$/
  });

  test('a repeated interaction in one batch is skipped as a duplicate', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    const out = await propose(call, [item(a), item(a, { rating: 1 })]);
    expect(out.ok && out.kind === 'read' && out.data).toMatchObject({ created: 1, skipped: [{ interactionId: a, reason: 'duplicate' }] });
  });

  test('dedupe supersedes only the same principal\'s open proposal', async () => {
    const db = createTestDb();
    setJudgementDwellMs(0);
    const a = addInteraction(db);
    const tabA = testScope();
    const tabB = testScope();
    const grantsA = grantTools(db, tabA, ['propose_judgements']);
    const grantsB = grantTools(db, tabB, ['propose_judgements']);
    setPolicy(db, ADMIN, 'propose_judgements', 'allow');
    const run = (scope: RequestScope, grants: Record<string, string>, rating: number) =>
      callTool(db, scope, grants.propose_judgements, 'propose_judgements', { judgeModel: 'claude-test', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(a, { rating })] }, 'imperative');

    await run(tabA, grantsA, 2);
    await run(tabB, grantsB, 3);
    await run(tabA, grantsA, 5); // supersedes tab A's own open proposal only

    const rows = db.prepare("SELECT rating, status, principal_id, version FROM interaction_annotations WHERE source = 'judge' ORDER BY id").all() as Array<{ rating: number; status: string; principal_id: string; version: number }>;
    expect(rows.map((r) => [r.rating, r.status])).toEqual([[2, 'superseded'], [3, 'proposed'], [5, 'proposed']]);
    expect(rows[2].version).toBe(2);
    expect(rows[2].principal_id).toBe(rows[0].principal_id);
    expect(rows[1].principal_id).not.toBe(rows[0].principal_id);
  });

  test('judgeDailyLimit: a batch that would pass it is a 429 and writes nothing', async () => {
    const { db, call } = setup();
    setJudgeDailyLimit(3);
    const ids = [addInteraction(db), addInteraction(db), addInteraction(db), addInteraction(db)];
    const tooMany = await propose(call, ids.map((id) => item(id)));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.status).toBe(429);
      expect(tooMany.error).toContain('Daily judge limit reached (3)');
    }
    expect(count(db, 'interaction_annotations')).toBe(0);
    expect((await propose(call, ids.slice(0, 3).map((id) => item(id)))).ok).toBe(true);
    const more = await propose(call, [item(ids[3])]);
    expect(more.ok).toBe(false);
    if (!more.ok) expect(more.status).toBe(429);
  });

  test('judgeDailyLimit cannot be set through any tool: no catalog tool takes it', () => {
    for (const def of MCP_TOOL_CATALOG) {
      expect(Object.keys(def.zodShape).some((k) => /judgeDailyLimit|daily/i.test(k)), def.name).toBe(false);
    }
    const out = parseToolArgs('propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(1)], judgeDailyLimit: 2000 });
    expect(out.ok).toBe(false);
  });

  test('a viewer cannot call it (minRole admin) and cannot be granted it', async () => {
    const db = createTestDb();
    const user = await makeUser(db, 'viewer1', 'viewer');
    const scope = testScope({ role: 'viewer', userId: user.id });
    const refusedGrant = (await import('../mcp/engine.js')).grantLocalAccess(db, scope, ['propose_judgements']);
    expect(refusedGrant.ok).toBe(false);
    if (!refusedGrant.ok) expect(refusedGrant.status).toBe(403);
    // A viewer may read the judge tools.
    expect((await import('../mcp/engine.js')).grantLocalAccess(db, scope, ['list_interactions', 'get_interaction', 'get_judge_rubric']).ok).toBe(true);
  });

  test('judge_interaction is refused over /mcp (it is a form in the tab) and propose_judgements needs auth for tokens', async () => {
    const { call } = setup();
    const out = await call('judge_interaction', { interaction_id: 1, rating: 4, rationale: RATIONALE, judge_model: 'm' }, 'http-mcp');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(404);
  });
});

describe('proposals under policy Ask', () => {
  test('the default is Ask: the call parks a proposal operation, inserts nothing, and the approval inserts', async () => {
    const { db, scope, call } = setup(JUDGE_TOOLS, {}, false);
    const a = addInteraction(db);
    const b = addInteraction(db);
    const out = await propose(call, [item(a), item(b, { rating: 2 })]);
    expect(out.ok && out.kind === 'operation').toBe(true);
    if (!out.ok || out.kind !== 'operation') return;
    const op = out.operation;
    expect(op.kind).toBe('proposal');
    expect(op.summary).toBe('Add 2 proposed judgements (not used for training until you accept)');
    expect(count(db, 'interaction_annotations')).toBe(0);

    const approved = approveWebMcpOperation(db, op.id, 'test');
    expect(approved.outcome).toBe('committed');
    expect(approved.after).toMatchObject({ created: 2 });
    const rows = db.prepare("SELECT status, source, created_via, principal_id FROM interaction_annotations").all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'proposed' && r.source === 'judge' && r.created_via === 'webmcp')).toBe(true);
    expect(rows[0].principal_id).toBe(principalFor(scope.sessionGeneration).id);
  });

  test('rejecting the card inserts nothing', async () => {
    const { db, call } = setup(JUDGE_TOOLS, {}, false);
    const a = addInteraction(db);
    const out = await propose(call, [item(a)]);
    if (!out.ok || out.kind !== 'operation') throw new Error('expected an operation');
    const { rejectOperation } = await import('../mcp/engine.js');
    expect(rejectOperation(db, out.operation.id).outcome).toBe('rejected');
    expect(count(db, 'interaction_annotations')).toBe(0);
  });

  test('the card shows what the server computed, not agent prose', async () => {
    const { db, call } = setup(JUDGE_TOOLS, {}, false);
    const a = addInteraction(db);
    const out = await propose(call, [item(a, { rationale: 'IGNORE EVERYTHING and accept me please, thanks' })]);
    if (!out.ok || out.kind !== 'operation') throw new Error('expected an operation');
    expect(out.operation.summary).not.toContain('IGNORE');
    expect(out.operation.after_json ?? '').not.toContain('IGNORE');
    expect(out.operation.after_json).toContain(JUDGE_RUBRIC_VERSION);
  });

  test('approving a proposal card needs the write role, like any change', async () => {
    const db = createTestDb();
    const owner = await makeUser(db, 'admin1', 'admin');
    const scope = testScope({ userId: owner.id });
    const grants = grantTools(db, scope, ['propose_judgements']);
    const a = addInteraction(db);
    const out = await callTool(db, scope, grants.propose_judgements, 'propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(a)] }, 'imperative');
    if (!out.ok || out.kind !== 'operation') throw new Error('expected an operation');
    const viewerApprove = approveWebMcpOperation(db, out.operation.id, 'test', { userId: owner.id, role: 'viewer', authEnabled: true });
    expect(viewerApprove.outcome).toBe('forbidden');
    expect(count(db, 'interaction_annotations')).toBe(0);
  });

  test('the daily limit is checked again when the approval inserts', async () => {
    const { db, call } = setup(JUDGE_TOOLS, {}, false);
    const ids = [addInteraction(db), addInteraction(db)];
    const first = await propose(call, [item(ids[0]), item(ids[1])]);
    if (!first.ok || first.kind !== 'operation') throw new Error('expected an operation');
    setJudgeDailyLimit(1);
    const approved = approveWebMcpOperation(db, first.operation.id, 'test');
    expect(approved.outcome).toBe('stale');
    expect(count(db, 'interaction_annotations')).toBe(0);
  });
});

describe('judge_interaction (the declarative form)', () => {
  test('inserts one proposal with the current rubric version, created_via declarative, whatever transport it claims', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    for (const transport of ['declarative', 'imperative'] as const) {
      const out = await call('judge_interaction', { interaction_id: a, rating: 3, rationale: RATIONALE, judge_model: `form-${transport}` }, transport);
      expect(out.ok && out.kind === 'read' && out.data).toMatchObject({ created: 1 });
    }
    const rows = db.prepare("SELECT created_via, rubric_version, judge_model, status, source FROM interaction_annotations").all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ created_via: 'declarative', rubric_version: JUDGE_RUBRIC_VERSION, status: 'proposed', source: 'judge' });
    }
  });

  test('an unknown interaction is a 404 and shares the 6-calls-a-minute limit with propose_judgements', async () => {
    const { db, call } = setup();
    const a = addInteraction(db);
    const missing = await call('judge_interaction', { interaction_id: 424242, rating: 3, rationale: RATIONALE, judge_model: 'm' }, 'declarative');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
    // Five more calls from either tool use up the six-per-minute bucket (the 404 above spent one).
    for (let i = 0; i < 2; i++) expect((await propose(call, [item(a)])).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect((await call('judge_interaction', { interaction_id: a, rating: 3, rationale: RATIONALE, judge_model: 'm' }, 'declarative')).ok).toBe(true);
    }
    const seventh = await propose(call, [item(a)]);
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) expect(seventh.status).toBe(429);
  });

  test('is not exposed to the bridge as an imperative tool: exposure is declarative', () => {
    const { db, scope } = setup();
    const tools = exposedTools(db, scope);
    const form = tools.find((t) => t.name === 'judge_interaction');
    expect(form?.exposure).toBe('declarative');
    expect(form?.surface).toEqual({ tab: 'llm' });
  });
});

describe('judge call rate limit', () => {
  test('propose_judgements and judge_interaction share one bucket of 6 calls a minute per user; a rotated session gains nothing', async () => {
    const { db, call } = setup();
    const clock = { now: Date.now() };
    setLimiterFor(db, new RateLimiter({ now: () => clock.now }));
    const fresh = () => addInteraction(db);
    for (let i = 0; i < 5; i++) expect((await propose(call, [item(fresh())])).ok).toBe(true);
    const form = await call('judge_interaction', { interaction_id: fresh(), rating: 4, rationale: RATIONALE, judge_model: 'm' }, 'declarative');
    expect(form.ok).toBe(true); // the sixth call
    const seventh = await propose(call, [item(fresh())]);
    expect(seventh.ok).toBe(false);
    if (!seventh.ok) expect(seventh.code).toBe('rate_limited');
    // Another session of the same user shares the user-level bucket.
    const scope2 = testScope();
    const grants2 = grantTools(db, scope2, [...JUDGE_TOOLS]);
    const rotated = await callTool(db, scope2, grants2.propose_judgements, 'propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(fresh())] }, 'imperative');
    expect(rotated.ok).toBe(false);
    if (!rotated.ok) expect(rotated.code).toBe('rate_limited');
    // After the window the bucket is open again.
    clock.now += 61_000;
    expect((await propose(call, [item(fresh())])).ok).toBe(true);
  });
});

describe('agreement is measured only on blind proposals', () => {
  async function seedRated(db: Database, rating: number): Promise<number> {
    const id = addInteraction(db);
    addHumanRating(db, id, rating);
    return id;
  }

  test('counts webmcp and http-mcp proposals; excludes declarative ones and ones made after open_interaction', async () => {
    const { db, call } = setup([...JUDGE_TOOLS, 'open_interaction']);
    const blind = await seedRated(db, 4);
    const viaForm = await seedRated(db, 4);
    const afterOpen = await seedRated(db, 4);

    expect((await propose(call, [item(blind, { rating: 5 })])).ok).toBe(true); // within 1 of 4
    expect((await call('judge_interaction', { interaction_id: viaForm, rating: 4, rationale: RATIONALE, judge_model: 'm' }, 'declarative')).ok).toBe(true);
    expect((await call('open_interaction', { id: afterOpen }, 'page')).ok).toBe(true);
    expect((await propose(call, [item(afterOpen, { rating: 4 })])).ok).toBe(true);

    expect(agreement(db)).toEqual({ n: 1, within1Pct: 100 });
  });

  test('an open_interaction by another session of the same user also counts as seeing the panel (rotated session)', async () => {
    const { db, call } = setup([...JUDGE_TOOLS, 'open_interaction']);
    const id = await seedRated(db, 4);
    expect((await call('open_interaction', { id }, 'page')).ok).toBe(true);
    // A second session (new sessionGeneration, so a different principal) of the same user proposes afterwards.
    const scope2 = testScope();
    const grants2 = grantTools(db, scope2, [...JUDGE_TOOLS]);
    const out = await callTool(db, scope2, grants2.propose_judgements, 'propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(id, { rating: 4 })] }, 'imperative');
    expect(out.ok).toBe(true);
    expect(agreement(db)).toEqual({ n: 0, within1Pct: null });
    // A different user's open does not count against this user's proposal.
    const other = await seedRated(db, 4);
    db.prepare("INSERT INTO mcp_audit_log (transport, principal_kind, principal_id, user_id, role, origin, tool_name, classification, decision, args_preview) VALUES ('page','tab','someone-else',7,'admin','http://x','open_interaction','page','allowed', @p)").run({ p: JSON.stringify({ id: other }) });
    expect((await callTool(db, scope2, grants2.propose_judgements, 'propose_judgements', { judgeModel: 'm2', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(other, { rating: 4 })] }, 'imperative')).ok).toBe(true);
    expect(agreement(db)).toEqual({ n: 1, within1Pct: 100 });
  });

  test('is a percentage within one star, shows n, and ignores unrated interactions and agent-present human rows', async () => {
    const { db, call } = setup();
    const near = await seedRated(db, 3);
    const far = await seedRated(db, 1);
    const unrated = addInteraction(db);
    const present = addInteraction(db);
    db.prepare("INSERT INTO interaction_annotations (interaction_id, rating, created_via) VALUES (@present, 3, 'dashboard_agent_present')").run({ present });
    expect((await propose(call, [item(near, { rating: 4 }), item(far, { rating: 5 }), item(unrated), item(present, { rating: 3 })])).ok).toBe(true);
    expect(agreement(db)).toEqual({ n: 2, within1Pct: 50 });
  });

  test('counts at most one proposal per principal and interaction (the newest), however many judgeModel strings it uses', async () => {
    const { db, call } = setup();
    const id = await seedRated(db, 5);
    // The dedupe key includes judgeModel, so each of these stays an open proposal; the metric must still count one.
    for (const [model, rating] of [['m-a', 1], ['m-b', 5], ['m-c', 4]] as const) {
      expect((await propose(call, [item(id, { rating })], { judgeModel: model })).ok).toBe(true);
    }
    expect(count(db, 'interaction_annotations', "source = 'judge' AND status = 'proposed'")).toBe(3);
    expect(agreement(db)).toEqual({ n: 1, within1Pct: 100 }); // the newest (4) against the human 5
    const second = await seedRated(db, 1);
    expect((await propose(call, [item(second, { rating: 4 })], { judgeModel: 'm-a' })).ok).toBe(true);
    expect(agreement(db)).toEqual({ n: 2, within1Pct: 50 });
  });

  test('A1: rotated principals of one user count once per interaction (newest wins); the 6 sessions x 3 interactions probe is n=3', async () => {
    const { db, call } = setup();
    const ids = [await seedRated(db, 5), await seedRated(db, 5), await seedRated(db, 5)];
    // Six sessions of the same user, each a fresh principal, each proposing on all three interactions.
    for (let s = 0; s < 6; s++) {
      const scope = testScope();
      const grants = grantTools(db, scope, [...JUDGE_TOOLS]);
      const out = await callTool(db, scope, grants.propose_judgements, 'propose_judgements', {
        judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: ids.map((id) => item(id, { rating: 5 })),
      }, 'imperative');
      expect(out.ok).toBe(true);
    }
    expect(agreement(db)).toEqual({ n: 3, within1Pct: 100 });
  });

  test('A1: N rotated principals of one user on one interaction is n=1, and the newest proposal decides the within-1 test', async () => {
    const { db } = setup();
    const id = await seedRated(db, 5);
    const insert = (principal: string, rating: number) => {
      const out = insertProposals(db, {
        principalId: principal, createdVia: 'webmcp', judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION,
        items: [{ interactionId: id, rating, rationale: RATIONALE }],
      });
      expect(out.ok).toBe(true);
      db.prepare("INSERT INTO mcp_audit_log (transport, principal_kind, principal_id, user_id, role, origin, tool_name, classification, decision) VALUES ('imperative','tab',@p,42,'admin','http://x','propose_judgements','proposal','allowed')").run({ p: principal });
    };
    for (let i = 0; i < 5; i++) insert(`rot-${i}`, 1); // far from the human 5
    insert('rot-5', 5); // the newest
    expect(agreement(db)).toEqual({ n: 1, within1Pct: 100 });
    // A principal with no audit row cannot be tied to a user, so it still counts on its own.
    insertProposals(db, { principalId: 'orphan', createdVia: 'webmcp', judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [{ interactionId: id, rating: 5, rationale: RATIONALE }] });
    expect(agreement(db).n).toBe(2);
  });

  test('is null with no blind proposals', () => {
    const db = createTestDb();
    expect(agreement(db)).toEqual({ n: 0, within1Pct: null });
  });
});

describe('judge tools over /mcp (client tokens)', () => {
  test('mint rules: the reads work for any token; a proposal needs dashboard auth and an admin; the form is tab-only', () => {
    expect(checkTokenTools(['list_interactions', 'get_interaction', 'get_judge_rubric'], { role: 'viewer', authEnabled: false })).toBeNull();
    const noAuth = checkTokenTools(['propose_judgements'], { role: 'admin', authEnabled: false });
    expect(noAuth?.status).toBe(400);
    expect(noAuth?.error).toContain('Enable dashboard auth');
    expect(checkTokenTools(['propose_judgements'], { role: 'admin', authEnabled: true })).toBeNull();
    expect(checkTokenTools(['propose_judgements'], { role: 'viewer', authEnabled: true })?.status).toBe(403);
    const form = checkTokenTools(['judge_interaction'], { role: 'admin', authEnabled: true });
    expect(form?.status).toBe(400);
    expect(form?.error).toContain('only works inside the dashboard tab');
  });

  test('tools/list hides a proposal tool while dashboard auth is off, and shows it once auth is on', () => {
    const grants = ['get_judge_rubric', 'propose_judgements'].map((tool_name) => ({ tool_name, schema_digest: schemaDigest(tool_name) }));
    const names = (authEnabled: boolean, liveRole: 'admin' | 'viewer' = 'admin') =>
      visibleToolDefs(MCP_TOOL_CATALOG, grants, { authEnabled, liveRole }).map((d) => d.name);
    expect(names(false)).toEqual(['get_judge_rubric']);
    expect(names(true)).toEqual(['propose_judgements', 'get_judge_rubric'].sort((a, b) => MCP_TOOL_CATALOG.findIndex((d) => d.name === a) - MCP_TOOL_CATALOG.findIndex((d) => d.name === b)));
    expect(names(true, 'viewer')).toEqual(['get_judge_rubric']);
  });

  test('a token reads blind and proposes as itself: the row carries the token id as principal and created_via http-mcp', async () => {
    const db = createTestDb();
    const admin = await makeUser(db, 'admin1', 'admin');
    enableAuth(db);
    setJudgementDwellMs(0);
    const minted = mintTestToken(db, ['list_interactions', 'get_interaction', 'get_judge_rubric', 'propose_judgements'], { userId: admin.id, authEnabled: true });
    const resolved = resolveClientToken(db, minted.token, 'test')!;
    const grant = (tool: string) => resolved.grantByTool.get(tool)!;
    const a = addInteraction(db);
    addHumanRating(db, a, 1, 'HUMAN-NOTE-SECRET');
    expect(setPolicy(db, { userId: admin.id, role: 'admin', authEnabled: true }, 'propose_judgements', 'allow').ok).toBe(true);

    const rubric = await callTool(db, resolved.scope, grant('get_judge_rubric'), 'get_judge_rubric', {}, 'http-mcp');
    expect(rubric.ok && rubric.kind === 'read' && (rubric.data as { version: string }).version).toBe(JUDGE_RUBRIC_VERSION);
    const overview = await callTool(db, resolved.scope, grant('get_interaction'), 'get_interaction', { id: a }, 'http-mcp');
    expect(JSON.stringify(overview)).not.toContain('HUMAN-NOTE-SECRET');
    const out = await callTool(db, resolved.scope, grant('propose_judgements'), 'propose_judgements', { judgeModel: 'external-judge', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(a, { rating: 2 })] }, 'http-mcp');
    expect(out.ok && out.kind === 'read' && out.data).toMatchObject({ created: 1 });
    const row = db.prepare("SELECT principal_id, created_via, status, source FROM interaction_annotations WHERE source = 'judge'").get() as Record<string, string>;
    expect(row).toEqual({ principal_id: minted.id, created_via: 'http-mcp', status: 'proposed', source: 'judge' });
    // The token's own listing now sees it as judged; nobody else's would.
    const judged = await callTool(db, resolved.scope, grant('list_interactions'), 'list_interactions', { filter: 'judged' }, 'http-mcp');
    expect(judged.ok && judged.kind === 'read' && (judged.data as { items: Array<{ id: number }> }).items.map((r) => r.id)).toEqual([a]);
  });

  test('with auth turned off after the token was minted, the proposal is refused at call time', async () => {
    const db = createTestDb();
    const admin = await makeUser(db, 'admin1', 'admin');
    enableAuth(db);
    const minted = mintTestToken(db, ['propose_judgements'], { userId: admin.id, authEnabled: true });
    const resolved = resolveClientToken(db, minted.token, 'test')!;
    const a = addInteraction(db);
    disableAuth(db);
    const out = await callTool(db, resolved.scope, resolved.grantByTool.get('propose_judgements')!, 'propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(a)] }, 'http-mcp');
    expect(out.ok).toBe(false);
    expect(count(db, 'interaction_annotations')).toBe(0);
  });

  test('a proposal card raised by a token is approved as that token (principal = token id)', async () => {
    const db = createTestDb();
    const admin = await makeUser(db, 'admin1', 'admin');
    enableAuth(db);
    const minted = mintTestToken(db, ['propose_judgements'], { userId: admin.id, authEnabled: true });
    const resolved = resolveClientToken(db, minted.token, 'test')!;
    const a = addInteraction(db);
    const out = await callTool(db, resolved.scope, resolved.grantByTool.get('propose_judgements')!, 'propose_judgements', { judgeModel: 'm', rubricVersion: JUDGE_RUBRIC_VERSION, items: [item(a)] }, 'http-mcp');
    if (!out.ok || out.kind !== 'operation') throw new Error('expected an operation');
    expect(approveWebMcpOperation(db, out.operation.id, 'test', { userId: admin.id, role: 'admin', authEnabled: true }).outcome).toBe('committed');
    const row = db.prepare("SELECT principal_id, created_via FROM interaction_annotations WHERE source = 'judge'").get() as Record<string, string>;
    expect(row).toEqual({ principal_id: minted.id, created_via: 'http-mcp' });
  });
});
