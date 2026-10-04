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
import { saveConfig, setSetting } from '../utils/config.js';
import { handleChatMessage, getPendingChatApproval, isChatRunActive, setChatDeadlineMs } from '../dashboard/chat.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';

/**
 * #156 — with dashboard auth on, a `viewer` must not be able to make the chat
 * agent write. The direct REST write routes refuse viewers with 403; the chat
 * approval card must too:
 *   - POST /api/mcp/operations/:id/approve on a chat card requires canWrite
 *     (403 for a viewer, nothing written);
 *   - a chat run started by a viewer denies every mutating tool call at once
 *     (no card is raised), and says why;
 *   - a chat card belongs to the user whose run raised it, so another user
 *     cannot see, approve or reject it;
 *   - "/categorize" (which writes without a card) is refused for viewers.
 * Drives the real server and agent loop; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType !== 'agent') throw new Error('no background LLM calls in this test');
  let response: LlmResponse = { content: 'All done.', toolCalls: [] };
  if (options.sequenceNum === 1) {
    const call = script.shift();
    if (call) response = { content: '', toolCalls: [call] };
  }
  return { response, interactionId: null, traceId: 't', durationMs: 0 };
});

afterAll(() => {
  // scopedSpy: never wipe another file's mock of the same export (plain `bun test`).
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitForAsync<T>(probe: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Op = { id: string; source: string; tool_name: string; status: string; user_id: number | null };

describe('#156: a viewer cannot approve chat operations', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let adminToken: string;
  let viewerToken: string;
  let restaurantId: number;

  const call = (path: string, token: string | null, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const chatOps = async (token: string): Promise<Op[]> => {
    const res = await call('/api/mcp/operations', token);
    const body = (await res.json()) as { operations: Op[] };
    return body.operations.filter((op) => op.source === 'chat');
  };
  const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
  const login = async (username: string, password: string) =>
    ((await (await call('/api/auth/login', null, 'POST', { username, password })).json()) as { token: string }).token;

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    script = [];
    setChatDeadlineMs(3000);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
    await createUser(db, 'admin', 'adminpass', 'admin');
    await createUser(db, 'viewer', 'viewerpass', 'viewer');
    enableAuth(db);
    adminToken = await login('admin', 'adminpass');
    viewerToken = await login('viewer', 'viewerpass');
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  });

  afterEach(async () => {
    // Let any run the test left behind wind down before the next one.
    await waitForAsync(async () => !isChatRunActive()).catch(() => {});
    stopDashboardServer(server);
    setChatDeadlineMs(null);
    saveConfig({});
    closeAll();
  });

  test('issue repro: a viewer cannot approve a chat card (403) and nothing is written', async () => {
    // A chat card whose run has no known owner (an in-process caller) is
    // stamped with whoever polls first — here the viewer, so it is visible to them.
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge');
    const card = await waitForAsync(async () => (await chatOps(viewerToken))[0]);
    expect(card.tool_name).toBe('delete_transaction');

    const res = await call(`/api/mcp/operations/${card.id}/approve`, viewerToken, 'POST');
    expect(res.status).toBe(403);
    expect(exists(restaurantId)).toBe(true);
    // The request is still waiting — the refused approve did not answer it.
    expect(getPendingChatApproval()?.tool).toBe('delete_transaction');

    // Rejecting is always safe; it ends the run with nothing written.
    expect((await call(`/api/mcp/operations/${card.id}/reject`, viewerToken, 'POST')).status).toBe(200);
    await run;
    expect(exists(restaurantId)).toBe(true);
  });

  test('a viewer\'s chat denies mutating tools at once — no card, a clear answer, nothing written', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const res = await call('/api/chat', viewerToken, 'POST', { query: 'delete the restaurant charge' });
    expect(res.status).toBe(200);
    const { answer } = (await res.json()) as { answer: string };
    expect(answer).toMatch(/viewer/i);
    expect(answer).toContain('delete_transaction');
    expect(answer).toMatch(/nothing was changed/i);
    expect(exists(restaurantId)).toBe(true);
    expect(await chatOps(viewerToken)).toEqual([]);
    expect(await chatOps(adminToken)).toEqual([]);
  });

  test('an admin\'s chat card belongs to the admin: a viewer polling first cannot see, approve or reject it', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', adminToken, 'POST', { query: 'delete the restaurant charge' });
    // The viewer polls (first) while the admin's request waits.
    await waitForAsync(async () => getPendingChatApproval());
    expect(await chatOps(viewerToken)).toEqual([]);

    const card = await waitForAsync(async () => (await chatOps(adminToken))[0]);
    expect((await call(`/api/mcp/operations/${card.id}/approve`, viewerToken, 'POST')).status).toBe(404);
    expect((await call(`/api/mcp/operations/${card.id}/reject`, viewerToken, 'POST')).status).toBe(404);
    expect(exists(restaurantId)).toBe(true);

    expect((await call(`/api/mcp/operations/${card.id}/approve`, adminToken, 'POST')).status).toBe(200);
    expect(((await (await run).json()) as { answer: string }).answer).toBe('All done.');
    expect(exists(restaurantId)).toBe(false);
  });

  test('"/categorize" is refused for a viewer and categorizes nothing', async () => {
    const uncategorized = () => (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL OR category = ''").get() as { n: number }).n;
    const before = uncategorized();
    const res = await call('/api/chat', viewerToken, 'POST', { query: '/categorize' });
    const { answer } = (await res.json()) as { answer: string };
    expect(answer).toMatch(/viewer/i);
    expect(uncategorized()).toBe(before);
  });

  test('read-only chat still works for a viewer', async () => {
    script = [{ id: 'tc1', name: 'transaction_search', args: { query: 'Restaurant' } }];
    const res = await call('/api/chat', viewerToken, 'POST', { query: 'find the restaurant charge' });
    expect(((await res.json()) as { answer: string }).answer).toBe('All done.');
  });
});
