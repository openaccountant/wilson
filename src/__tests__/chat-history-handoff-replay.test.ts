import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import * as llmModule from '../model/llm.js';
import { createTestDb } from './helpers.js';
import { getChatHistoryBySession, getChatSessions } from '../db/queries.js';
import { CONTEXT_BLOCK_HEADER } from '../dashboard/mentions.js';
import { HANDOFF_BLOCK_HEADER, type LocalHandoffV1 } from '../dashboard/local-handoff-format.js';
import { renderHandoffBlock } from '../dashboard/local-handoff.js';

/**
 * [C5] The handoff block rides in the current turn's query (chat.ts prepends
 * it), so `saveUserQuery` stores it. The DB row keeps the raw query (honest
 * record; the UI strips it), but every REPLAY of a stored query into a later
 * prompt must drop the handoff block, or up to 8,000 chars of stale on-device
 * notes would ride along for the next 10 turns. Mention blocks are kept:
 * their ids in history are existing, intended behaviour.
 */

const mention = `${CONTEXT_BLOCK_HEADER}\n- category id=3 slug=dining "Dining"\n\n`;
const value: LocalHandoffV1 = {
  v: 1,
  reason: 'ungrounded',
  mirror: { syncedAt: '2026-07-15T12:00:00.000Z' },
  steps: [{ tool: 'transaction_search', args: { query: 'Dining in June' }, ok: true, summary: '' }],
  localNote: 'About $120.',
};
const handoff = renderHandoffBlock(value, [
  { tool: 'transaction_search', args: { query: 'Dining in June' }, ok: true, summary: 'Found 1 transaction.\n#7 2026-06-03 -$120.00 Dining Bistro' },
]);
const q = 'how much on @Dining in June?';
const raw = mention + handoff + q;

describe('[C5] handoff block is never replayed from history', () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  function capture(): Array<{ prompt: string; callType: unknown }> {
    const prompts: Array<{ prompt: string; callType: unknown }> = [];
    spy = spyOn(llmModule, 'callLlm').mockImplementation((async (prompt: string, opts: { callType?: unknown }) => {
      prompts.push({ prompt, callType: opts?.callType });
      if (opts?.callType === 'relevance') {
        return { response: { content: '', structured: { message_ids: [0] } }, metadata: {} };
      }
      return { response: { content: 'Spent about $120 on dining.', structured: null }, metadata: {} };
    }) as never);
    return prompts;
  }

  test('sanity: the stored query really contains both blocks', () => {
    expect(raw.startsWith(CONTEXT_BLOCK_HEADER)).toBe(true);
    expect(raw).toContain(HANDOFF_BLOCK_HEADER);
  });

  test('getRecentTurns user content is mention block + words, without the handoff block', async () => {
    capture();
    const h = new InMemoryChatHistory('test-model', 10);
    h.saveUserQuery(raw);
    await h.saveAnswer('About $120.');
    const turns = h.getRecentTurns();
    expect(turns[0]).toEqual({ role: 'user', content: mention + q });
    expect(turns.map((t) => t.content).join('\n')).not.toContain(HANDOFF_BLOCK_HEADER);
  });

  test('the summary prompt and the relevance prompt carry no handoff block', async () => {
    const prompts = capture();
    const h = new InMemoryChatHistory('test-model', 10);
    h.saveUserQuery(raw);
    await h.saveAnswer('About $120.');
    await h.selectRelevantMessages('and in July?');
    const summary = prompts.find((p) => p.callType === 'summarize');
    const relevance = prompts.find((p) => p.callType === 'relevance');
    expect(summary).toBeDefined();
    expect(relevance).toBeDefined();
    expect(summary!.prompt).not.toContain(HANDOFF_BLOCK_HEADER);
    expect(relevance!.prompt).not.toContain(HANDOFF_BLOCK_HEADER);
    expect(relevance!.prompt).toContain('how much on @Dining in June?');
  });

  test('formatForPlanning / formatForAnswerGeneration carry no handoff block', async () => {
    capture();
    const h = new InMemoryChatHistory('test-model', 10);
    h.saveUserQuery(raw);
    await h.saveAnswer('About $120.');
    const msgs = h.getMessages();
    expect(h.formatForPlanning(msgs)).not.toContain(HANDOFF_BLOCK_HEADER);
    expect(h.formatForAnswerGeneration(msgs)).not.toContain(HANDOFF_BLOCK_HEADER);
    expect(h.formatForAnswerGeneration(msgs)).toContain(q);
  });

  test('the DB row keeps the raw query', async () => {
    capture();
    const db = createTestDb();
    const h = new InMemoryChatHistory('test-model', 10);
    h.setDatabase(db);
    h.saveUserQuery(raw);
    await h.saveAnswer('About $120.');
    const rows = getChatHistoryBySession(db, h.getSessionId()!);
    expect(rows[0].query).toBe(raw);
  });

  test('session title (LLM failing, fallback path) is the user words, never the block', async () => {
    spy = spyOn(llmModule, 'callLlm').mockRejectedValue(new Error('offline'));
    const db = createTestDb();
    const h = new InMemoryChatHistory('test-model', 10);
    h.setDatabase(db);
    h.saveUserQuery(raw);
    await h.saveAnswer('About $120.');
    const title = getChatSessions(db).find((s) => s.id === h.getSessionId())?.title ?? '';
    expect(title).toBe(`Answer to: ${q}`);
    expect(title).not.toContain('[On-device');
    expect(title).not.toContain('[Referenced');
  });

  test('session title (empty summary) is the user words, never the block', async () => {
    spy = spyOn(llmModule, 'callLlm').mockResolvedValue({ response: { content: '', structured: null }, metadata: {} } as never);
    const db = createTestDb();
    const h = new InMemoryChatHistory('test-model', 10);
    h.setDatabase(db);
    h.saveUserQuery(handoff + q);
    await h.saveAnswer('About $120.');
    const title = getChatSessions(db).find((s) => s.id === h.getSessionId())?.title ?? '';
    expect(title).toBe(q);
  });
});
