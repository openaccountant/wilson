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
import { getPendingChatApproval, isChatRunActive, setChatDeadlineMs } from '../dashboard/chat.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth } from '../dashboard/auth.js';

/**
 * #159 — deactivating a user cancels the dashboard chat run they own: the run
 * is aborted, its pending approval card is expired and nothing is written.
 * Drives the real server and agent loop; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
/** When set, the first agent LLM call waits for it (a run that is "mid-flight", before any card). */
let hold: Promise<void> | null = null;
let llmEntered: (() => void) | null = null;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType !== 'agent') throw new Error('no background LLM calls in this test');
  let response: LlmResponse = { content: 'All done.', toolCalls: [] };
  if (options.sequenceNum === 1) {
    llmEntered?.();
    if (hold) await hold;
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

type Op = { id: string; source: string; status: string };

describe('#159: deactivating a user cancels their in-flight chat run', () => {
  let db: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let bossToken: string;
  let workerToken: string;
  let otherToken: string;
  let workerId: number;
  let restaurantId: number;

  const call = (path: string, token: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const chatOps = async (token: string): Promise<Op[]> => {
    const res = await call('/api/mcp/operations', token);
    return ((await res.json()) as { operations: Op[] }).operations.filter((op) => op.source === 'chat');
  };
  const exists = (id: number) => Boolean(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id }));
  const chatRows = () =>
    db.prepare("SELECT id, status FROM mcp_operations WHERE source = 'chat'").all() as { id: string; status: string }[];
  const login = async (username: string, password: string) =>
    ((await (await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ username, password }),
    })).json()) as { token: string }).token;
  const deactivate = (token: string, id: number) => call(`/api/auth/users/${id}`, token, 'DELETE');

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    db = createTestDb();
    seedTestData(db);
    script = [];
    hold = null;
    llmEntered = null;
    setChatDeadlineMs(10_000);
    setInitialProfile('test', db);
    ({ server } = await startDashboardServer(db, 0));
    base = `http://localhost:${server.port}`;
    await createUser(db, 'boss', 'bosspass1', 'admin');
    workerId = (await createUser(db, 'worker', 'workerpass', 'admin')).id;
    await createUser(db, 'other', 'otherpass', 'admin');
    enableAuth(db);
    bossToken = await login('boss', 'bosspass1');
    workerToken = await login('worker', 'workerpass');
    otherToken = await login('other', 'otherpass');
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  });

  afterEach(async () => {
    await waitForAsync(async () => !isChatRunActive()).catch(() => {});
    stopDashboardServer(server);
    setChatDeadlineMs(null);
    saveConfig({});
    closeAll();
  });

  test('deactivated while a write awaits approval: run aborted, card expired, nothing written', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', workerToken, 'POST', { query: 'delete the restaurant charge' });
    await waitForAsync(async () => getPendingChatApproval());
    const card = await waitForAsync(async () => (await chatOps(workerToken))[0]);

    expect((await deactivate(bossToken, workerId)).status).toBe(200);

    // The run ends at once (it does not wait for its deadline) and nothing was written.
    const { answer } = (await run.then((r) => r.json())) as { answer: string };
    expect(answer).not.toBe('All done.');
    expect(isChatRunActive()).toBe(false);
    expect(getPendingChatApproval()).toBeNull();
    expect(exists(restaurantId)).toBe(true);
    expect(chatRows()).toEqual([{ id: card.id, status: 'expired' }]);
    // The card is off every queue, and approving it is refused.
    expect(await chatOps(bossToken)).toEqual([]);
    expect((await call(`/api/mcp/operations/${card.id}/approve`, bossToken, 'POST')).status).not.toBe(200);
    expect(exists(restaurantId)).toBe(true);
  });

  test('deactivated mid-run, before any card: the run is aborted and a write it was about to ask for never happens', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (llmEntered = r));
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', workerToken, 'POST', { query: 'delete the restaurant charge' });
    await entered;

    expect((await deactivate(bossToken, workerId)).status).toBe(200);
    release(); // the in-flight model call now returns a mutating tool call

    const { answer } = (await run.then((r) => r.json())) as { answer: string };
    expect(answer).not.toBe('All done.');
    await waitForAsync(async () => !isChatRunActive());
    expect(exists(restaurantId)).toBe(true);
    expect(getPendingChatApproval()).toBeNull();
    expect(chatRows().filter((r) => r.status === 'pending')).toEqual([]);
    expect(await chatOps(bossToken)).toEqual([]);
  });

  test("deactivating someone else leaves the owner's run and card alone", async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = call('/api/chat', workerToken, 'POST', { query: 'delete the restaurant charge' });
    await waitForAsync(async () => getPendingChatApproval());
    const card = await waitForAsync(async () => (await chatOps(workerToken))[0]);

    const otherId = (db.prepare("SELECT id FROM dashboard_users WHERE username = 'other'").get() as { id: number }).id;
    expect((await deactivate(bossToken, otherId)).status).toBe(200);
    expect(otherToken).toBeTruthy();

    expect(isChatRunActive()).toBe(true);
    expect((await chatOps(workerToken)).map((op) => op.id)).toEqual([card.id]);
    expect((await call(`/api/mcp/operations/${card.id}/approve`, workerToken, 'POST')).status).toBe(200);
    expect(((await (await run).json()) as { answer: string }).answer).toBe('All done.');
    expect(exists(restaurantId)).toBe(false);
  });
});
