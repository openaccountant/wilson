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
import {
  cancelChatRunForUser, getPendingChatApproval, getPendingChatOperation, handleChatMessage, initChatSession,
  isChatRunActive, setChatDeadlineMs,
} from '../dashboard/chat.js';
import { createUser, enableAuth } from '../dashboard/auth.js';

/**
 * Two ways a dashboard chat run outlives the authority it started with (#157, #159):
 *  - A run started with auth OFF is ownerless. When auth comes on it must end: nobody owns its approval cards
 *    and it must not keep reading or writing under the new login rules. That covers an agent run AND a
 *    "/categorize", which writes without any card.
 *  - A "/categorize" is a tracked, owned run like any chat message, so deactivating its owner stops it too.
 * Drives the real chat module; only callLlm is scripted.
 */

const orchSpy = scopedSpy(orchRegistry, 'getOrchestrationTools', async () => []);
const skillsSpy = scopedSpy(skillsIndex, 'discoverSkills', () => [] as never);
const systemPromptSpy = scopedSpy(prompts, 'buildSystemPrompt', async () => 'You are a test agent.');
const soulSpy = scopedSpy(prompts, 'loadSoulDocument', async () => '');

let script: LlmResponse['toolCalls'][number][] = [];
/** When set, an agent call (first step) or a categorizer call waits for it. */
let hold: Promise<void> | null = null;
let llmEntered: (() => void) | null = null;
let categorizeTargetId = -1;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType === 'agent') {
    let response: LlmResponse = { content: 'All done.', toolCalls: [] };
    if (options.sequenceNum === 1) {
      llmEntered?.();
      if (hold) await hold;
      const call = script.shift();
      if (call) response = { content: '', toolCalls: [call] };
    }
    return { response, interactionId: null, traceId: 't', durationMs: 0 };
  }
  // The categorizer: a confident answer for the one uncategorized row, delivered after `hold` is released.
  llmEntered?.();
  if (hold) await hold;
  return {
    response: {
      content: '',
      toolCalls: [],
      structured: { transactions: [{ id: categorizeTargetId, category: 'Other', confidence: 0.99 }] },
    },
    interactionId: null,
    traceId: 't',
    durationMs: 0,
  };
});

afterAll(() => {
  for (const s of [orchSpy, skillsSpy, systemPromptSpy, soulSpy, llmSpy]) s.restore();
});

async function waitFor<T>(probe: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ownerless runs end when auth is enabled; /categorize is a tracked, owned, cancellable run', () => {
  let db: Database;
  let otherDb: Database;
  let restaurantId: number;
  let release: () => void;
  let entered: Promise<void>;

  const category = () => (db.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: categorizeTargetId }) as { category: string | null }).category;
  const chatRows = () => db.prepare("SELECT status FROM mcp_operations WHERE source = 'chat'").all() as { status: string }[];

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    setChatDeadlineMs(10_000);
    db = createTestDb();
    seedTestData(db);
    otherDb = createTestDb();
    seedTestData(otherDb);
    initChatSession(db);
    restaurantId = (db.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
    categorizeTargetId = (db.prepare("SELECT id FROM transactions WHERE description = 'Unknown Purchase'").get() as { id: number }).id;
    script = [];
    hold = new Promise<void>((r) => (release = r));
    entered = new Promise<void>((r) => (llmEntered = r));
  });

  afterEach(async () => {
    release();
    await waitFor(() => !isChatRunActive()).catch(() => {});
    setChatDeadlineMs(null);
    llmEntered = null;
    hold = null;
    saveConfig({});
  });

  test('ownerless run awaiting approval: enabling auth aborts it, expires the card, writes nothing', async () => {
    hold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: null, db });
    await waitFor(() => getPendingChatApproval());
    const card = getPendingChatOperation(db, { profile: 'test', userId: null, role: 'admin' });
    expect(card).toBeTruthy();

    await createUser(db, 'admin', 'adminpass1', 'admin');
    enableAuth(db);

    expect((await run).answer).not.toBe('All done.');
    expect(isChatRunActive()).toBe(false);
    expect(getPendingChatApproval()).toBeNull();
    expect(chatRows()).toEqual([{ status: 'expired' }]);
    expect(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id: restaurantId })).toBeTruthy();
  });

  test('ownerless run mid model call, before any card: enabling auth ends it and the write it was about to ask for never happens', async () => {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: null, db });
    await entered;
    await createUser(db, 'admin', 'adminpass1', 'admin');
    enableAuth(db);
    release();
    expect((await run).answer).not.toBe('All done.');
    await waitFor(() => !isChatRunActive());
    expect(getPendingChatApproval()).toBeNull();
    expect(chatRows().filter((r) => r.status === 'pending')).toEqual([]);
    expect(db.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id: restaurantId })).toBeTruthy();
  });

  test('an in-flight anonymous /categorize: enabling auth stops it before it writes', async () => {
    const run = handleChatMessage('/categorize', undefined, undefined, { user: null, db });
    await entered;
    expect(isChatRunActive()).toBe(true);

    await createUser(db, 'admin', 'adminpass1', 'admin');
    enableAuth(db);
    release();

    const { answer } = await run;
    expect(answer.toLowerCase()).toContain('cancel');
    expect(category()).toBeNull();
    await waitFor(() => !isChatRunActive());
  });

  test('control: an anonymous /categorize that nothing interrupts does write', async () => {
    const run = handleChatMessage('/categorize', undefined, undefined, { user: null, db });
    await entered;
    release();
    await run;
    expect(category()).toBe('Other');
  });

  test("an owned /categorize: deactivating its owner stops it; another user's cancel does not", async () => {
    const run = handleChatMessage('/categorize', undefined, undefined, { user: { id: 7, role: 'admin' }, db });
    await entered;

    expect(cancelChatRunForUser(db, 8)).toBe(false);
    expect(cancelChatRunForUser(otherDb, 7)).toBe(false);
    expect(isChatRunActive()).toBe(true);

    expect(cancelChatRunForUser(db, 7)).toBe(true);
    release();
    expect((await run).answer.toLowerCase()).toContain('cancel');
    expect(category()).toBeNull();
    await waitFor(() => !isChatRunActive());
  });

  test('a /categorize holds the chat: a message sent meanwhile is refused as busy, and so is a second /categorize', async () => {
    const run = handleChatMessage('/categorize', undefined, undefined, { user: null, db });
    await entered;
    expect((await handleChatMessage('how much did I spend?', undefined, undefined, { user: null, db })).busy).toBe(true);
    expect((await handleChatMessage('/categorize', undefined, undefined, { user: null, db })).busy).toBe(true);
    release();
    await run;
    await waitFor(() => !isChatRunActive());
  });

  test("enabling auth on another profile's database leaves this chat session's run alone", async () => {
    hold = null;
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: null, db });
    await waitFor(() => getPendingChatApproval());
    await createUser(otherDb, 'admin', 'adminpass1', 'admin');
    enableAuth(otherDb);
    expect(isChatRunActive()).toBe(true);
    expect(getPendingChatApproval()).not.toBeNull();
    cancelChatRunForUser(db, -1);
    // Clean up: end the run without writing.
    initChatSession(db);
    await run;
  });
});
