import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import type { LlmResponse } from '../model/types.js';
import type { LlmResult } from '../model/llm.js';
import * as llm from '../model/llm.js';
import * as prompts from '../agent/prompts.js';
import * as skillsIndex from '../skills/index.js';
import * as orchRegistry from '../orchestration/registry.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { scopedSpy } from './scoped-spy.js';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { initAgentTools } from '../agent/init-tools.js';
import { saveConfig, setSetting } from '../utils/config.js';
import {
  initChatSession,
  handleChatMessage,
  getPendingChatOperation,
  respondToChatOperation,
  setChatDeadlineMs,
} from '../dashboard/chat.js';
import { getOperation } from '../mcp/store.js';
import { createHeadlessRunner, reportHeadlessResult } from '../headless.js';

/**
 * #152 — every surface that runs the agent goes through AgentRunnerController,
 * whose requestToolApproval is the only path into AgentToolExecutor's gate.
 * These tests drive the REAL Agent loop (only the LLM call is scripted) with
 * a real mutating tool against a throwaway DB, once per surface:
 *   - TUI: cli.ts renders runner.pendingApproval and calls respondToApproval
 *   - dashboard chat: the pending approval surfaces as a chat operation that
 *     /api/mcp/operations/:id/{approve,reject} resolves
 *   - headless --run: nobody can answer, so every approval is denied at once
 *     (fail closed) and the output names the denied tool
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let scriptedToolCall: LlmResponse['toolCalls'][number] | null = null;
let agentCalls = 0;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType !== 'agent') throw new Error('no background LLM calls in this test');
  agentCalls++;
  const response: LlmResponse =
    agentCalls === 1 && scriptedToolCall
      ? { content: '', toolCalls: [scriptedToolCall] }
      : { content: 'All done.', toolCalls: [] };
  return { response, interactionId: null, traceId: 't', durationMs: 0 };
});

afterAll(() => {
  // scopedSpy: never wipe another file's mock of the same export (plain `bun test`).
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitFor<T>(probe: () => T | null | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function restaurant(db: Database): { id: number; category: string } | null {
  return (db.prepare("SELECT id, category FROM transactions WHERE description = 'Restaurant'").get() ?? null) as
    | { id: number; category: string }
    | null;
}

describe('approval on every agent surface (#152)', () => {
  let db: Database;

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    agentCalls = 0;
  });

  afterEach(() => {
    scriptedToolCall = null;
    setChatDeadlineMs(null);
    saveConfig({});
  });

  function runner(): AgentRunnerController {
    initAgentTools(db);
    const history = new InMemoryChatHistory();
    history.setDatabase(db);
    return new AgentRunnerController({ model: 'gpt-5.2', modelProvider: 'openai', maxIterations: 3 }, history);
  }

  describe('TUI / interactive CLI (AgentRunnerController.respondToApproval)', () => {
    test('delete_transaction waits for approval; deny keeps the row', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id } };
      const r = runner();
      const done = r.runQuery('delete the restaurant charge');

      const pending = await waitFor(() => r.pendingApproval);
      expect(pending).toEqual({ tool: 'delete_transaction', args: { id }, session: { key: 'delete_transaction' } });
      expect(r.workingState).toEqual({ status: 'approval', toolName: 'delete_transaction' });
      expect(restaurant(db)).toBeTruthy();

      r.respondToApproval('deny');
      await done;
      expect(restaurant(db)).toBeTruthy();
      const types = r.history.at(-1)!.events.map((e) => e.event.type);
      expect(types).toContain('tool_approval');
      expect(types).toContain('tool_denied');
      expect(types).not.toContain('tool_start');
    });

    test('allow-once runs the write', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id } };
      const r = runner();
      const done = r.runQuery('delete the restaurant charge');
      await waitFor(() => r.pendingApproval);
      r.respondToApproval('allow-once');
      const result = await done;
      expect(result?.answer).toBe('All done.');
      expect(restaurant(db)).toBeFalsy();
    });

    test('read tools never raise an approval', async () => {
      scriptedToolCall = { id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } };
      const r = runner();
      const result = await r.runQuery('find the restaurant charge');
      expect(result?.answer).toBe('All done.');
      const types = r.history.at(-1)!.events.map((e) => e.event.type);
      expect(types).toContain('tool_start');
      expect(types).not.toContain('tool_approval');
    });
  });

  describe('dashboard chat (server agent + shared confirmation queue)', () => {
    const scope = { profile: 'test', userId: null, role: 'admin' as const };

    test('edit_transaction surfaces as a chat operation; reject keeps the row', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'edit_transaction', args: { id, category: 'Groceries' } };
      initChatSession(db);
      const reply = handleChatMessage('recategorize the restaurant charge as groceries');

      const op = await waitFor(() => getPendingChatOperation(db, scope));
      expect(op.source).toBe('chat');
      expect(op.tool_name).toBe('edit_transaction');
      expect(JSON.parse(op.args_json!)).toEqual({ id, category: 'Groceries' });

      expect(respondToChatOperation(db, op.id, 'deny')).toEqual({ ok: true, status: 'rejected' });
      // Says what happened instead of "No response generated."
      expect((await reply).answer).toBe('Cancelled — you denied edit_transaction.');
      expect(restaurant(db)?.category).toBe('Dining');
      expect(getOperation(db, op.id)?.status).toBe('rejected');
    });

    test('approve runs the write', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'edit_transaction', args: { id, category: 'Groceries' } };
      initChatSession(db);
      const reply = handleChatMessage('recategorize the restaurant charge as groceries');
      const op = await waitFor(() => getPendingChatOperation(db, scope));
      expect(respondToChatOperation(db, op.id, 'allow-once')).toEqual({ ok: true, status: 'committed' });
      expect((await reply).answer).toBe('All done.');
      expect(restaurant(db)?.category).toBe('Groceries');
      expect(getOperation(db, op.id)?.status).toBe('committed');
    });
  });

  describe('headless --run (src/headless.ts) — fails closed', () => {
    function headlessRunner(): AgentRunnerController {
      initAgentTools(db);
      const history = new InMemoryChatHistory();
      history.setDatabase(db);
      return createHeadlessRunner({ model: 'gpt-5.2', modelProvider: 'openai', maxIterations: 3 }, history);
    }

    test('a mutating tool is denied immediately (no hang), never writes, and the output names it', async () => {
      const id = restaurant(db)!.id;
      scriptedToolCall = { id: 'tc1', name: 'delete_transaction', args: { id } };
      const r = headlessRunner();

      // Resolves on its own — nothing ever calls respondToApproval here.
      const result = await r.runQuery('delete the restaurant charge');
      expect(r.pendingApproval).toBeNull();
      expect(restaurant(db)).toBeTruthy();

      const events = r.history.at(-1)!.events.map((e) => e.event);
      expect(events.map((e) => e.type)).not.toContain('tool_start');
      expect(events.find((e) => e.type === 'tool_approval')).toMatchObject({ tool: 'delete_transaction', approved: 'deny' });
      expect(events.map((e) => e.type)).toContain('tool_denied');
      expect(r.lastDeniedTools).toEqual(['delete_transaction']);

      const out: string[] = [];
      const err: string[] = [];
      const code = reportHeadlessResult(result, r, { log: (m) => out.push(m), error: (m) => err.push(m) });
      const text = [...out, ...err].join('\n');
      expect(text).toContain('delete_transaction');
      expect(text).toMatch(/headless/i);
      expect(text).toMatch(/can't approve/i);
      expect(text).toMatch(/interactive/i);
      expect(text).not.toContain('No response generated');
      expect(code).toBe(1);
    });

    test('read tools still run headless and print the answer', async () => {
      scriptedToolCall = { id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } };
      const r = headlessRunner();
      const result = await r.runQuery('find the restaurant charge');
      expect(r.lastDeniedTools).toEqual([]);
      const out: string[] = [];
      const err: string[] = [];
      const code = reportHeadlessResult(result, r, { log: (m) => out.push(m), error: (m) => err.push(m) });
      expect(out).toEqual(['All done.']);
      expect(err).toEqual([]);
      expect(code).toBe(0);
    });
  });
});
