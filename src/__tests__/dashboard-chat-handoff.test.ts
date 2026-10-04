import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { initAgentTools } from '../agent/init-tools.js';
import type { Database } from '../db/compat-sqlite.js';
import * as chatModule from '../dashboard/chat.js';

// ── Chat stub (spies on the real module) ────────────────────────────────────
//
// Capture exactly what POST /api/chat hands to handleChatMessage, instead of
// running the agent. initChatSession still wires the agent's tools to the DB,
// because the server re-executes handoff steps through the same tool
// singletons the agent uses (DECISIONS Q11).
//
// Spies, not mock.module: a module mock is process-wide and never undone, so
// without --isolate it replaced chat.js for every later test file.
const captured: Array<{ query: string; sessionId: string | undefined; contextBlock: string | undefined; argc: number }> = [];
const chatSpies = [
  spyOn(chatModule, 'initChatSession').mockImplementation((db: Database) => initAgentTools(db)),
  spyOn(chatModule, 'handleChatMessage').mockImplementation((async (...args: [string, string | undefined, string | undefined]) => {
    captured.push({ query: args[0], sessionId: args[1], contextBlock: args[2], argc: args.length });
    return { answer: 'stub answer', sessionId: 'stub-session' };
  }) as unknown as typeof chatModule.handleChatMessage),
  spyOn(chatModule, 'getPendingChatOperation').mockImplementation(() => null),
  spyOn(chatModule, 'respondToChatOperation').mockImplementation(() => ({ ok: false, error: 'stub' }) as never),
  spyOn(chatModule, 'refreshChatModel').mockImplementation(() => {}),
  spyOn(chatModule, 'getAppliedChatModel').mockImplementation(() => null),
  spyOn(chatModule, 'getActiveChatHistory').mockImplementation(() => null),
];
afterAll(() => {
  for (const s of chatSpies) s.mockRestore();
});

import { createTestDb, seedTestData } from './helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { CONTEXT_BLOCK_HEADER } from '../dashboard/mentions.js';
import { HANDOFF_BLOCK_END, HANDOFF_BLOCK_HEADER, type LocalHandoffV1 } from '../dashboard/local-handoff-format.js';
import { getSetting, setSetting } from '../utils/config.js';

/**
 * POST /api/chat with an optional `localHandoff` (specs/browser-subagent.md
 * 8.2). The handoff is advisory: a valid one becomes a framed block after the
 * mention block, an invalid one is dropped and the chat still answers 200, and
 * no handoff at all is byte-identical to the pre-handoff behaviour.
 *
 * Round 2: the server honours a handoff only while subagent.enabled is on. The
 * main describe forces the flag on (WILSON_LOCAL_SUBAGENT=1); the second one
 * pins the flag-off behaviour, which must be indistinguishable from "no handoff".
 */

const FORGED = '424242.42';

function handoff(over: Partial<LocalHandoffV1> = {}): LocalHandoffV1 {
  return {
    v: 1,
    reason: 'empty-result',
    mirror: { syncedAt: '2026-07-15T12:00:00.000Z' },
    steps: [{ tool: 'transaction_search', args: { query: 'Grocery Store' }, ok: true, summary: `No rows. Total $${FORGED}` }],
    priorLocalTurns: [{ q: 'what was my dining total?', a: 'About $45.00.' }],
    ...over,
  };
}

describe('POST /api/chat localHandoff', () => {
  let db: Database;
  let base = '';
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;
  let savedProvider: unknown;
  let savedModel: unknown;
  let savedFlag: string | undefined;

  beforeEach(async () => {
    savedFlag = process.env.WILSON_LOCAL_SUBAGENT;
    process.env.WILSON_LOCAL_SUBAGENT = '1'; // handoffs are honoured only while the subagent is enabled
    captured.length = 0;
    db = createTestDb(); // temp profile (ensureTestProfile), never a real ~/.openaccountant profile
    seedTestData(db);
    setInitialProfile('handoff-test', db);
    savedProvider = getSetting('provider', null);
    savedModel = getSetting('modelId', null);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${result.server.port}`;
  });

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    setSetting('provider', savedProvider ?? undefined);
    setSetting('modelId', savedModel ?? undefined);
    if (savedFlag === undefined) delete process.env.WILSON_LOCAL_SUBAGENT;
    else process.env.WILSON_LOCAL_SUBAGENT = savedFlag;
    closeAll();
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('no handoff: handleChatMessage gets exactly what it got before (undefined context block)', async () => {
    const res = await post({ query: 'hi', sessionId: 's1' });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].query).toBe('hi');
    expect(captured[0].sessionId).toBe('s1');
    expect(captured[0].contextBlock).toBeUndefined();
  });

  test('mention, no handoff: the context block is the mention block, byte for byte', async () => {
    const res = await post({ query: 'how much at @Grocery Store?', mentions: [{ type: 'merchant', key: 'Grocery Store', label: 'Grocery Store' }] });
    expect(res.status).toBe(200);
    const block = captured[0].contextBlock!;
    expect(block.startsWith(CONTEXT_BLOCK_HEADER)).toBe(true);
    expect(block).not.toContain(HANDOFF_BLOCK_HEADER);
    expect(block).toBe(`${CONTEXT_BLOCK_HEADER}\n- merchant "Grocery Store" (match merchant_name or description)\n\n`);
  });

  test('a valid handoff: the block is present and carries the SERVER re-run, not the client numbers', async () => {
    const res = await post({ query: 'groceries this month?', localHandoff: handoff() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toBe('stub answer');
    const block = captured[0].contextBlock!;
    expect(block.startsWith(HANDOFF_BLOCK_HEADER)).toBe(true);
    expect(block.endsWith(`${HANDOFF_BLOCK_END}\n\n`)).toBe(true);
    // Re-run against the seeded DB: the Grocery Store rows are -85.50 and -92.00 (the catalog's compact,
    // sanitized transaction_search rows).
    expect(block).toContain('Grocery Store');
    expect(block).toContain('amount=-85.5');
    expect(block).not.toContain(FORGED);
    expect(captured[0].query).toBe('groceries this month?');
  });

  test('mention + handoff: mention block first, then the handoff block', async () => {
    const res = await post({
      query: 'how much at @Grocery Store?',
      mentions: [{ type: 'merchant', key: 'Grocery Store', label: 'Grocery Store' }],
      localHandoff: handoff(),
    });
    expect(res.status).toBe(200);
    const block = captured[0].contextBlock!;
    expect(block.startsWith(CONTEXT_BLOCK_HEADER)).toBe(true);
    expect(block.indexOf(HANDOFF_BLOCK_HEADER)).toBeGreaterThan(0);
    expect(block.endsWith(`${HANDOFF_BLOCK_END}\n\n`)).toBe(true);
  });

  test('an invalid handoff is dropped silently: no block, still 200', async () => {
    for (const bad of [
      { v: 2 },
      'nonsense',
      handoff({ steps: [{ tool: 'delete_transaction' as never, args: { id: 1 }, ok: true, summary: '' }] }),
      handoff({ steps: [{ tool: 'transaction_search', args: { query: 'x', sql: 'DROP TABLE transactions' }, ok: true, summary: '' }] }),
    ]) {
      captured.length = 0;
      const res = await post({ query: 'hi', localHandoff: bad });
      expect(res.status).toBe(200);
      expect(captured[0].contextBlock).toBeUndefined();
    }
  });

  test('a handoff over 16 KB is dropped: no block, still 200', async () => {
    const res = await post({
      query: 'hi',
      localHandoff: handoff({ steps: [{ tool: 'transaction_search', args: { query: 'g'.repeat(17_000) }, ok: true, summary: '' }] }),
    });
    expect(res.status).toBe(200);
    expect(captured[0].contextBlock).toBeUndefined();
  });

  test('Q10: priorLocalTurns are dropped for the default (cloud) chat provider', async () => {
    setSetting('provider', 'openai');
    setSetting('modelId', 'gpt-4.1');
    await post({ query: 'and groceries?', localHandoff: handoff() });
    const block = captured[0].contextBlock!;
    expect(block).toContain(HANDOFF_BLOCK_HEADER);
    expect(block).not.toContain('what was my dining total?');
    expect(block).not.toContain('About $45.00.');
  });

  test('Q10: priorLocalTurns are kept for a local chat provider', async () => {
    setSetting('provider', 'ollama');
    setSetting('modelId', 'ollama:llama3.1');
    await post({ query: 'and groceries?', localHandoff: handoff() });
    const block = captured[0].contextBlock!;
    expect(block).toContain('what was my dining total?');
  });
});

describe('POST /api/chat localHandoff while subagent.enabled is off (Round 2)', () => {
  let db: Database;
  let base = '';
  let server: Awaited<ReturnType<typeof startDashboardServer>>['server'] | null = null;
  let savedFlag: string | undefined;

  beforeEach(async () => {
    savedFlag = process.env.WILSON_LOCAL_SUBAGENT;
    delete process.env.WILSON_LOCAL_SUBAGENT; // the shipped default: off
    captured.length = 0;
    db = createTestDb();
    seedTestData(db);
    setInitialProfile('handoff-off-test', db);
    const result = await startDashboardServer(db, 0);
    server = result.server;
    base = `http://localhost:${result.server.port}`;
  });

  afterEach(() => {
    if (server) {
      try { stopDashboardServer(server); } catch { /* */ }
      server = null;
    }
    if (savedFlag === undefined) delete process.env.WILSON_LOCAL_SUBAGENT;
    else process.env.WILSON_LOCAL_SUBAGENT = savedFlag;
    closeAll();
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('a valid handoff is ignored entirely: no block, no re-execution, still answers 200', async () => {
    const res = await post({ query: 'groceries this month?', sessionId: 's1', localHandoff: handoff() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toBe('stub answer');
    expect(captured).toHaveLength(1);
    expect(captured[0].query).toBe('groceries this month?');
    expect(captured[0].contextBlock).toBeUndefined();
  });

  test('with a mention, the context block is the mention block alone, byte for byte', async () => {
    const res = await post({
      query: 'how much at @Grocery Store?',
      mentions: [{ type: 'merchant', key: 'Grocery Store', label: 'Grocery Store' }],
      localHandoff: handoff(),
    });
    expect(res.status).toBe(200);
    expect(captured[0].contextBlock).toBe(`${CONTEXT_BLOCK_HEADER}\n- merchant "Grocery Store" (match merchant_name or description)\n\n`);
    expect(captured[0].contextBlock).not.toContain(HANDOFF_BLOCK_HEADER);
  });

  test('only the literal "1" turns the server side on', async () => {
    process.env.WILSON_LOCAL_SUBAGENT = 'true';
    await post({ query: 'hi', localHandoff: handoff() });
    expect(captured[0].contextBlock).toBeUndefined();
    process.env.WILSON_LOCAL_SUBAGENT = '1';
    await post({ query: 'hi', localHandoff: handoff() });
    expect(captured[1].contextBlock!.startsWith(HANDOFF_BLOCK_HEADER)).toBe(true);
  });
});
