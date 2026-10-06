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
  cancelChatRunForUser, getPendingChatApproval, handleChatMessage, initChatSession, isChatRunActive, setChatDeadlineMs,
} from '../dashboard/chat.js';
import { getPendingChatOperation } from '../dashboard/chat.js';

/**
 * Dashboard user ids are per profile database: user 7 of profile A is not user 7 of profile B. A
 * deactivation reaches cancelChatRunForUser with the db it happened in, and the chat run lives on the
 * chat session's db, so the cancel must act only when they are the same database (and retire the card
 * on that database), or deactivating "user 7" on one profile would kill another profile's user 7's run.
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

describe('cancelChatRunForUser only acts on the chat session database', () => {
  let dbA: Database;
  let dbB: Database;
  let restaurantId: number;

  beforeEach(() => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    setChatDeadlineMs(10_000);
    dbA = createTestDb();
    seedTestData(dbA);
    dbB = createTestDb();
    seedTestData(dbB);
    initChatSession(dbA);
    restaurantId = (dbA.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
  });

  afterEach(async () => {
    cancelChatRunForUser(dbA, 7);
    await waitFor(() => (isChatRunActive() ? null : true)).catch(() => {});
    setChatDeadlineMs(null);
    saveConfig({});
  });

  async function startRunAwaitingApproval() {
    script = [{ id: 'tc1', name: 'delete_transaction', args: { id: restaurantId } }];
    const run = handleChatMessage('delete the restaurant charge', undefined, undefined, { user: { id: 7, role: 'admin' }, db: dbA });
    await waitFor(() => getPendingChatApproval());
    const card = getPendingChatOperation(dbA, { profile: 'test', userId: 7, role: 'admin' })!;
    expect(card).toBeTruthy();
    return { run, card };
  }

  test("another profile's deactivation of the same user id leaves the run and its card alone", async () => {
    const { run, card } = await startRunAwaitingApproval();

    expect(cancelChatRunForUser(dbB, 7)).toBe(false);

    expect(isChatRunActive()).toBe(true);
    expect(getPendingChatApproval()).not.toBeNull();
    expect((dbA.prepare('SELECT status FROM mcp_operations WHERE id = @id').get({ id: card.id }) as { status: string }).status).toBe('pending');
    // Nothing was written to the other database either.
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM mcp_operations WHERE source = 'chat'").get()).toEqual({ n: 0 });

    // The owning database's deactivation still stops it.
    expect(cancelChatRunForUser(dbA, 7)).toBe(true);
    await run;
    expect(isChatRunActive()).toBe(false);
    expect((dbA.prepare('SELECT status FROM mcp_operations WHERE id = @id').get({ id: card.id }) as { status: string }).status).toBe('expired');
    expect(dbA.prepare('SELECT 1 FROM transactions WHERE id = @id').get({ id: restaurantId })).toBeTruthy();
  });
});
