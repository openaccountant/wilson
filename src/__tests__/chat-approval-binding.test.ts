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
  getPendingChatApproval,
  isChatRunActive,
  respondToChatOperation,
  setChatDeadlineMs,
} from '../dashboard/chat.js';
import { getOperation } from '../mcp/store.js';
import { getPendingOperations } from '../mcp/engine.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';

/**
 * Stale approval cards (security review of #152). A dashboard chat approval
 * card must only ever approve the exact pending request it was created for.
 *
 * The reviewer's probe: a chat run asks to edit a transaction, the chat
 * deadline cancels it, the next message asks to delete a transaction, and
 * approving the OLD edit card ran the delete. These tests drive the REAL Agent
 * loop (only callLlm is scripted) against a throwaway DB, like
 * approval-surfaces.test.ts.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

/** Tool calls handed out, in order, to the first LLM call of each run. */
let script: LlmResponse['toolCalls'][number][] = [];
let firstCalls = 0;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType !== 'agent') throw new Error('no background LLM calls in this test');
  let response: LlmResponse = { content: 'All done.', toolCalls: [] };
  if (options.sequenceNum === 1) {
    firstCalls++;
    const call = script.shift();
    if (call) response = { content: '', toolCalls: [call] };
  }
  return { response, interactionId: null, traceId: 't', durationMs: 0 };
});

afterAll(() => {
  // scopedSpy: never wipe another file's mock of the same export (plain `bun test`).
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitFor<T>(probe: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Resolves 'hung' if `p` has not settled within `ms` — a failing test must not hang the suite. */
function within<T>(p: Promise<T>, ms = 500): Promise<T | 'hung'> {
  return Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);
}

function txn(db: Database, description: string): { id: number; category: string } | null {
  return (db.prepare('SELECT id, category FROM transactions WHERE description = @d ORDER BY id LIMIT 1').get({ d: description }) ?? null) as
    | { id: number; category: string }
    | null;
}

function exists(db: Database, id: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
}

async function waitForAsync<T>(probe: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const scope = { profile: 'test', userId: null, role: 'admin' as const };

describe('dashboard chat approval cards are bound to their exact request', () => {
  let db: Database;

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    script = [];
    firstCalls = 0;
    // Short enough that a regression fails instead of hanging the suite.
    setChatDeadlineMs(3000);
  });

  afterEach(() => {
    setChatDeadlineMs(null);
    saveConfig({});
  });

  test('(a) deadline cancels an edit card; approving it later must not run the next request (delete)', async () => {
    const restaurant = txn(db, 'Restaurant')!;
    const grocery = txn(db, 'Grocery Store')!;
    script = [
      { id: 'tc1', name: 'edit_transaction', args: { id: restaurant.id, category: 'Groceries' } },
      { id: 'tc2', name: 'delete_transaction', args: { id: grocery.id } },
    ];
    initChatSession(db);
    setChatDeadlineMs(150);

    const first = handleChatMessage('recategorize the restaurant charge as groceries');
    const editCard = await waitFor(() => getPendingChatOperation(db, scope));
    expect(editCard.tool_name).toBe('edit_transaction');
    expect((await first).answer).toContain('did not finish');
    await waitFor(() => !isChatRunActive());

    // Next message: the agent now waits on delete_transaction. Nothing has
    // polled the queue yet, so no card for it exists — only the stale one.
    setChatDeadlineMs(3000);
    const second = handleChatMessage('delete the grocery charge');
    const pending = await waitFor(() => getPendingChatApproval());
    expect(pending.tool).toBe('delete_transaction');

    const res = respondToChatOperation(db, editCard.id, 'allow-once');
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/no longer/i);
    // The delete is still waiting and nothing was written.
    expect(getPendingChatApproval()).toBe(pending);
    expect(exists(db, grocery.id)).toBe(true);
    expect(txn(db, 'Restaurant')?.category).toBe('Dining');

    // Its own card still works (deny it to finish the run cleanly).
    const deleteCard = await waitFor(() => getPendingChatOperation(db, scope));
    expect(deleteCard.id).not.toBe(editCard.id);
    expect(deleteCard.tool_name).toBe('delete_transaction');
    expect(respondToChatOperation(db, deleteCard.id, 'deny')).toMatchObject({ ok: true });
    expect((await second).answer).toBe('Cancelled — you denied delete_transaction.');
    expect(exists(db, grocery.id)).toBe(true);
  });

  test('(b) a cancelled request\'s card is expired and no longer listed', async () => {
    const restaurant = txn(db, 'Restaurant')!;
    script = [{ id: 'tc1', name: 'edit_transaction', args: { id: restaurant.id, category: 'Groceries' } }];
    initChatSession(db);
    setChatDeadlineMs(150);

    const reply = handleChatMessage('recategorize the restaurant charge as groceries');
    const card = await waitFor(() => getPendingChatOperation(db, scope));
    expect((await reply).answer).toContain('did not finish');

    const row = getOperation(db, card.id)!;
    expect(['rejected', 'expired']).toContain(row.status);
    expect(getPendingOperations(db).some((op) => op.id === card.id)).toBe(false);
    expect(getPendingChatOperation(db, scope)).toBeNull();
    // Approving it now is refused and changes nothing.
    expect(respondToChatOperation(db, card.id, 'allow-once')).toMatchObject({ ok: false });
    expect(getOperation(db, card.id)!.status).toBe(row.status);
    expect(txn(db, 'Restaurant')?.category).toBe('Dining');
  });

  test('(b) a card left over from a previous chat session is expired when the session restarts', async () => {
    const restaurant = txn(db, 'Restaurant')!;
    script = [{ id: 'tc1', name: 'edit_transaction', args: { id: restaurant.id, category: 'Groceries' } }];
    initChatSession(db);
    const reply = handleChatMessage('recategorize the restaurant charge as groceries');
    const card = await waitFor(() => getPendingChatOperation(db, scope));

    initChatSession(db); // profile switch / restart: the old runner is gone
    expect(['rejected', 'expired']).toContain(getOperation(db, card.id)!.status);
    expect(getPendingOperations(db).some((op) => op.id === card.id)).toBe(false);
    expect(await within(reply, 1000)).not.toBe('hung');
    expect(respondToChatOperation(db, card.id, 'allow-once')).toMatchObject({ ok: false });
    expect(txn(db, 'Restaurant')?.category).toBe('Dining');
  });

  test('(c) a second concurrent chat is refused (busy) and cannot cross-approve', async () => {
    const restaurant = txn(db, 'Restaurant')!;
    const grocery = txn(db, 'Grocery Store')!;
    script = [
      { id: 'tc1', name: 'edit_transaction', args: { id: restaurant.id, category: 'Groceries' } },
      { id: 'tc2', name: 'delete_transaction', args: { id: grocery.id } },
    ];
    initChatSession(db);

    const first = handleChatMessage('recategorize the restaurant charge as groceries');
    const editCard = await waitFor(() => getPendingChatOperation(db, scope));

    const second = await within(handleChatMessage('delete the grocery charge'));
    expect(second).not.toBe('hung');
    if (second === 'hung') return;
    expect(second.busy).toBe(true);
    expect(second.answer).toMatch(/still running/i);
    // The second run never started: no LLM call, and the edit is still the pending request.
    expect(firstCalls).toBe(1);
    expect(getPendingChatApproval()?.tool).toBe('edit_transaction');

    expect(respondToChatOperation(db, editCard.id, 'allow-once')).toMatchObject({ ok: true });
    expect((await first).answer).toBe('All done.');
    expect(txn(db, 'Restaurant')?.category).toBe('Groceries');
    expect(exists(db, grocery.id)).toBe(true);
    expect(isChatRunActive()).toBe(false);
  });
});

describe('AgentRunnerController approvals are per request', () => {
  let db: Database;

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    db = createTestDb();
    seedTestData(db);
    script = [];
    firstCalls = 0;
  });

  function runner(): AgentRunnerController {
    initAgentTools(db);
    const history = new InMemoryChatHistory();
    history.setDatabase(db);
    return new AgentRunnerController({ model: 'gpt-5.2', modelProvider: 'openai', maxIterations: 3 }, history);
  }

  test('each request gets a fresh id; answering with a stale id does nothing', async () => {
    const restaurant = txn(db, 'Restaurant')!;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurant.id } }];
    const r = runner();
    const done = r.runQuery('delete the restaurant charge');
    await waitFor(() => r.pendingApproval);
    const id = r.pendingApprovalId;
    expect(typeof id).toBe('string');

    expect(r.respondToApproval('allow-once', 'not-this-request')).toBe(false);
    expect(r.pendingApproval).not.toBeNull();
    expect(txn(db, 'Restaurant')).toBeTruthy();

    expect(r.respondToApproval('deny', id!)).toBe(true);
    await done;
    expect(r.pendingApprovalId).toBeNull();
    expect(txn(db, 'Restaurant')).toBeTruthy();
  });

  test('a run cancelled mid-flight cannot raise a new approval afterwards', async () => {
    const restaurant = txn(db, 'Restaurant')!;
    const r = runner();
    // The LLM call is in flight when the run is cancelled, then returns a mutating call.
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    llmSpy.spy.mockImplementationOnce(async (): Promise<LlmResult> => {
      await gate;
      return {
        response: { content: '', toolCalls: [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurant.id } }] },
        interactionId: null, traceId: 't', durationMs: 0,
      };
    });
    const done = r.runQuery('delete the restaurant charge');
    await new Promise((res) => setTimeout(res, 10));
    r.cancelExecution();
    release();
    expect(await within(done, 1000)).not.toBe('hung');
    expect(r.pendingApproval).toBeNull();
    expect(txn(db, 'Restaurant')).toBeTruthy();
  });
});

describe('POST /api/chat while another chat is running', () => {
  test('answers 409 and the card of the running chat is the only one that works', async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    const db = createTestDb();
    seedTestData(db);
    script = [];
    firstCalls = 0;
    setChatDeadlineMs(3000);
    setInitialProfile('test', db);
    const { server } = await startDashboardServer(db, 0);
    const base = `http://localhost:${server.port}`;
    const post = (path: string, body?: unknown) =>
      // Origin + Sec-Fetch-Site: what the dashboard page sends, and the browser proof approving needs.
      fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const restaurant = txn(db, 'Restaurant')!;
      script = [
        { id: 'tc1', name: 'edit_transaction', args: { id: restaurant.id, category: 'Groceries' } },
        { id: 'tc2', name: 'delete_transaction', args: { id: restaurant.id } },
      ];
      const first = post('/api/chat', { query: 'recategorize the restaurant charge as groceries' });
      const card = await waitForAsync(async () => {
        const res = await (await fetch(base + '/api/mcp/operations')).json() as { operations: Array<{ id: string; source: string; tool_name: string }> };
        return res.operations.find((op) => op.source === 'chat') ?? null;
      });
      expect(card.tool_name).toBe('edit_transaction');

      const busy = await post('/api/chat', { query: 'delete the restaurant charge' });
      expect(busy.status).toBe(409);
      const busyBody = await busy.json() as { error: string };
      expect(busyBody.error).toMatch(/still running/i);

      const bogus = await post(`/api/mcp/operations/${card.id}x/approve`);
      expect(bogus.status).toBe(404);

      const ok = await post(`/api/mcp/operations/${card.id}/approve`);
      expect(ok.status).toBe(200);
      expect(((await (await first).json()) as { answer: string }).answer).toBe('All done.');

      // The card is spent: approving it again is a clear 409, not a silent 200.
      const again = await post(`/api/mcp/operations/${card.id}/approve`);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toMatch(/no longer/i);
      expect(txn(db, 'Restaurant')?.category).toBe('Groceries');
    } finally {
      stopDashboardServer(server);
      setChatDeadlineMs(null);
      saveConfig({});
      closeAll();
    }
  });
});
