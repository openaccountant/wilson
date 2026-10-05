import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import type { LlmResult } from '../model/llm.js';
import * as llm from '../model/llm.js';
import * as chatModule from '../dashboard/chat.js';
import * as localHandoff from '../dashboard/local-handoff.js';
import { createTestDb, ensureTestProfile, seedTestData } from './helpers.js';
import { scopedSpy } from './scoped-spy.js';
import { openHeldRequest } from './held-request-helpers.js';
import { saveConfig } from '../utils/config.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, switchProfile, getActiveDb, closeAll } from '../dashboard/db-manager.js';
import { createUser, enableAuth, verifyLogin, deactivateUser, getUserByUsername } from '../dashboard/auth.js';

/**
 * A request is validated against the profile that was active when its headers
 * arrived, but the chat runner and the agent tools follow the GLOBAL current
 * profile (db-manager switchProfile -> chat.ts initChatSession). A write that is
 * held on its body across a profile switch must therefore be refused (409), not
 * run: with an admin token of profile A it would otherwise run on profile B as
 * "user 1", and an anonymous request that arrived while A had auth off could
 * write into B, where auth is on.
 */

const realHandleChatMessage = chatModule.handleChatMessage;
const chatSpy = scopedSpy(chatModule, 'handleChatMessage', realHandleChatMessage);

/** Where the categorizer would write if the guard failed: it answers every row with a confident category. */
let categorizeTargetId = -1;
const llmSpy = scopedSpy(llm, 'callLlm', async (_prompt, options): Promise<LlmResult> => {
  if (options?.callType === 'agent') {
    return { response: { content: 'All done.', toolCalls: [] }, interactionId: null, traceId: 't', durationMs: 0 };
  }
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

/** The handoff builder the server awaits before starting a chat run; tests pause inside it. */
let handoffGate: (() => Promise<void>) | null = null;
const realBuildHandoffContext = localHandoff.buildHandoffContext;
const handoffSpy = scopedSpy(localHandoff, 'buildHandoffContext', (async (...args: Parameters<typeof realBuildHandoffContext>) => {
  if (handoffGate) await handoffGate();
  return realBuildHandoffContext(...args);
}) as typeof realBuildHandoffContext);

afterAll(() => {
  for (const s of [chatSpy, llmSpy, handoffSpy]) s.restore();
});

/** A fresh profile per test: profile DBs live on disk (under the throwaway test home) and outlive a test. */
let profileCounter = 0;
let PROFILE_B = 'prof-b';
const chatCalls = () => (chatSpy.spy.mock.calls as unknown[][]).length;

describe('held write across a profile switch', () => {
  let dbA: Database;
  let dbB: Database;
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'];
  let base: string;
  let aTxnId: number;
  let bUncategorizedId: number;

  beforeEach(async () => {
    ensureTestProfile();
    saveConfig({});
    chatSpy.spy.mockClear();
    handoffGate = null;
    dbA = createTestDb();
    seedTestData(dbA);
    setInitialProfile('test', dbA);
    // Profile B has dashboard auth ON with its own admin and one uncategorized row.
    PROFILE_B = `prof-b-${process.pid}-${++profileCounter}`;
    dbB = switchProfile(PROFILE_B);
    seedTestData(dbB);
    await createUser(dbB, 'b-admin', 'badminpass1', 'admin');
    enableAuth(dbB);
    switchProfile('test');
    expect(getActiveDb()).toBe(dbA);
    aTxnId = (dbA.prepare("SELECT id FROM transactions WHERE description = 'Restaurant'").get() as { id: number }).id;
    bUncategorizedId = (dbB.prepare("SELECT id FROM transactions WHERE description = 'Unknown Purchase'").get() as { id: number }).id;
    categorizeTargetId = bUncategorizedId;
    ({ server } = await startDashboardServer(dbA, 0));
    base = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    stopDashboardServer(server);
    saveConfig({});
    delete process.env.WILSON_LOCAL_SUBAGENT;
    closeAll();
  });

  const switchTo = (name: string, token?: string) =>
    fetch(`${base}/api/profiles/switch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name }),
    });

  const bCategory = () => (dbB.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: bUncategorizedId }) as { category: string | null }).category;
  const aCategory = () => (dbA.prepare('SELECT category FROM transactions WHERE id = @id').get({ id: aTxnId }) as { category: string | null }).category;

  describe('variant 1: profile A has auth on, the held request carries an admin token', () => {
    let token: string;
    beforeEach(async () => {
      await createUser(dbA, 'a-admin', 'aadminpass1', 'admin');
      enableAuth(dbA);
      token = (await verifyLogin(dbA, 'a-admin', 'aadminpass1'))!.token;
    });

    test('POST /api/chat: 409, no chat run starts on profile B', async () => {
      const held = await openHeldRequest(server, dbA, {
        method: 'POST',
        path: '/api/chat',
        headers: { Authorization: `Bearer ${token}` },
        payload: JSON.stringify({ query: 'how much did I spend?' }),
      });
      await held.arrived;
      expect((await switchTo(PROFILE_B, token)).status).toBe(200);
      const res = await held.finish();
      expect(res.status).toBe(409);
      expect(res.body).toMatch(/profile/i);
      expect(chatCalls()).toBe(0);
      expect(chatModule.isChatRunActive()).toBe(false);
    });

    test('PATCH /api/transactions/:id: 409, nothing written', async () => {
      const before = aCategory();
      const held = await openHeldRequest(server, dbA, {
        method: 'PATCH',
        path: `/api/transactions/${aTxnId}`,
        headers: { Authorization: `Bearer ${token}` },
        payload: JSON.stringify({ category: 'Raced' }),
      });
      await held.arrived;
      expect((await switchTo(PROFILE_B, token)).status).toBe(200);
      const res = await held.finish();
      expect(res.status).toBe(409);
      expect(res.body).toMatch(/profile/i);
      expect(aCategory()).toBe(before);
    });

    test('control: the same held PATCH with no switch is applied', async () => {
      const held = await openHeldRequest(server, dbA, {
        method: 'PATCH',
        path: `/api/transactions/${aTxnId}`,
        headers: { Authorization: `Bearer ${token}` },
        payload: JSON.stringify({ category: 'Raced' }),
      });
      await held.arrived;
      expect((await held.finish()).status).toBe(200);
      expect(aCategory()).toBe('Raced');
    });

    test('after the handoff build: a profile switch while buildHandoffContext awaits refuses the run (409)', async () => {
      process.env.WILSON_LOCAL_SUBAGENT = '1';
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      handoffGate = async () => { entered(); await gate; };
      const pending = fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: 'how much did I spend?', localHandoff: { v: 1 } }),
      });
      await reached;
      expect((await switchTo(PROFILE_B, token)).status).toBe(200);
      release();
      const res = await pending;
      expect(res.status).toBe(409);
      expect(chatCalls()).toBe(0);
    });

    test('after the handoff build: a logout while buildHandoffContext awaits refuses the run (401)', async () => {
      process.env.WILSON_LOCAL_SUBAGENT = '1';
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      handoffGate = async () => { entered(); await gate; };
      const pending = fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: 'how much did I spend?', localHandoff: { v: 1 } }),
      });
      await reached;
      deactivateUser(dbA, getUserByUsername(dbA, 'a-admin')!.id);
      release();
      expect((await pending).status).toBe(401);
      expect(chatCalls()).toBe(0);
    });
  });

  describe('variant 2: profile A has auth off, the held request is anonymous', () => {
    test('POST /api/chat "/categorize": 409, the auth-on profile B is not written to', async () => {
      const held = await openHeldRequest(server, dbA, {
        method: 'POST',
        path: '/api/chat',
        payload: JSON.stringify({ query: '/categorize' }),
      });
      await held.arrived;
      expect((await switchTo(PROFILE_B)).status).toBe(200);
      const res = await held.finish();
      expect(res.status).toBe(409);
      expect(res.body).toMatch(/profile/i);
      expect(chatCalls()).toBe(0);
      expect(bCategory()).toBeNull();
    });

    test('PATCH /api/transactions/:id: 409, nothing written', async () => {
      const before = aCategory();
      const held = await openHeldRequest(server, dbA, {
        method: 'PATCH',
        path: `/api/transactions/${aTxnId}`,
        payload: JSON.stringify({ category: 'Raced' }),
      });
      await held.arrived;
      expect((await switchTo(PROFILE_B)).status).toBe(200);
      const res = await held.finish();
      expect(res.status).toBe(409);
      expect(res.body).toMatch(/profile/i);
      expect(aCategory()).toBe(before);
    });

    test('after the handoff build: a profile switch while buildHandoffContext awaits refuses the run (409)', async () => {
      process.env.WILSON_LOCAL_SUBAGENT = '1';
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      handoffGate = async () => { entered(); await gate; };
      const pending = fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'how much did I spend?', localHandoff: { v: 1 } }),
      });
      await reached;
      expect((await switchTo(PROFILE_B)).status).toBe(200);
      release();
      expect((await pending).status).toBe(409);
      expect(chatCalls()).toBe(0);
    });

    test('after the handoff build: auth turned on while buildHandoffContext awaits refuses the run (401)', async () => {
      process.env.WILSON_LOCAL_SUBAGENT = '1';
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      handoffGate = async () => { entered(); await gate; };
      const pending = fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'how much did I spend?', localHandoff: { v: 1 } }),
      });
      await reached;
      await createUser(dbA, 'late-admin', 'lateadmin1', 'admin');
      enableAuth(dbA);
      release();
      expect((await pending).status).toBe(401);
      expect(chatCalls()).toBe(0);
    });
  });

  test('handleChatMessage refuses a request db that is not the chat session db (defence in depth)', async () => {
    // The chat session follows the current profile (dbA here); a caller holding dbB must be refused.
    const result = await realHandleChatMessage('how much did I spend?', undefined, undefined, { user: null, db: dbB });
    expect(result.stale).toBe(true);
    expect(chatModule.isChatRunActive()).toBe(false);
    const categorize = await realHandleChatMessage('/categorize', undefined, undefined, { user: null, db: dbB });
    expect(categorize.stale).toBe(true);
    expect(bCategory()).toBeNull();
  });
});
