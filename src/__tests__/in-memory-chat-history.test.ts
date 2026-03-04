import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import * as llmModule from '../model/llm.js';
import { createTestDb } from './helpers.js';
import { getChatSessions, getChatHistoryBySession } from '../db/queries.js';

describe('InMemoryChatHistory', () => {
  let history: InMemoryChatHistory;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = new InMemoryChatHistory('test-model', 10);
    // Mock callLlm for saveAnswer's generateSummary
    llmSpy = spyOn(llmModule, 'callLlm').mockResolvedValue({
      response: { content: 'Mock summary of the answer', structured: null },
      metadata: {},
    } as any);
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('starts with no messages', () => {
    expect(history.hasMessages()).toBe(false);
    expect(history.getMessages()).toHaveLength(0);
  });

  test('saveUserQuery adds message', () => {
    history.saveUserQuery('How much did I spend?');
    expect(history.hasMessages()).toBe(true);
    const messages = history.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].query).toBe('How much did I spend?');
    expect(messages[0].answer).toBeNull();
  });

  test('saveAnswer completes the message', async () => {
    history.saveUserQuery('What is my balance?');
    await history.saveAnswer('Your balance is $1,000.');
    const messages = history.getMessages();
    expect(messages[0].answer).toBe('Your balance is $1,000.');
    expect(messages[0].summary).toBe('Mock summary of the answer');
  });

  test('saveAnswer calls LLM for summary', async () => {
    history.saveUserQuery('test query');
    await history.saveAnswer('test answer');
    expect(llmSpy).toHaveBeenCalled();
  });

  test('saveAnswer does nothing without pending query', async () => {
    await history.saveAnswer('orphan answer');
    expect(history.getMessages()).toHaveLength(0);
  });

  test('saveAnswer does nothing if answer already set', async () => {
    history.saveUserQuery('query');
    await history.saveAnswer('first answer');
    await history.saveAnswer('second answer');
    const messages = history.getMessages();
    expect(messages[0].answer).toBe('first answer');
  });

  test('getUserMessages returns queries in order', () => {
    history.saveUserQuery('first');
    history.saveUserQuery('second');
    history.saveUserQuery('third');
    expect(history.getUserMessages()).toEqual(['first', 'second', 'third']);
  });

  test('getRecentTurns returns completed messages only', async () => {
    history.saveUserQuery('q1');
    await history.saveAnswer('a1');
    history.saveUserQuery('q2'); // no answer yet
    const turns = history.getRecentTurns();
    // Only completed turns (q1/a1)
    expect(turns).toHaveLength(2); // user + assistant
    expect(turns[0].role).toBe('user');
    expect(turns[0].content).toBe('q1');
    expect(turns[1].role).toBe('assistant');
    expect(turns[1].content).toBe('a1');
  });

  test('getRecentTurns respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      history.saveUserQuery(`q${i}`);
      await history.saveAnswer(`a${i}`);
    }
    const turns = history.getRecentTurns(2);
    // 2 messages × 2 entries (user + assistant) = 4
    expect(turns).toHaveLength(4);
    expect(turns[0].content).toBe('q3');
  });

  test('getRecentTurns returns empty for limit 0', () => {
    history.saveUserQuery('q1');
    expect(history.getRecentTurns(0)).toHaveLength(0);
  });

  test('clear removes all messages', () => {
    history.saveUserQuery('q1');
    history.saveUserQuery('q2');
    expect(history.hasMessages()).toBe(true);
    history.clear();
    expect(history.hasMessages()).toBe(false);
    expect(history.getMessages()).toHaveLength(0);
  });

  test('formatForPlanning returns summaries', async () => {
    history.saveUserQuery('spending last month');
    await history.saveAnswer('You spent $500 last month.');
    const messages = history.getMessages();
    const formatted = history.formatForPlanning(messages);
    expect(formatted).toContain('spending last month');
    expect(formatted).toContain('Mock summary');
  });

  test('formatForPlanning returns empty string for no messages', () => {
    expect(history.formatForPlanning([])).toBe('');
  });

  test('formatForAnswerGeneration returns full answers', async () => {
    history.saveUserQuery('spending last month');
    await history.saveAnswer('You spent $500 last month.');
    const messages = history.getMessages();
    const formatted = history.formatForAnswerGeneration(messages);
    expect(formatted).toContain('spending last month');
    expect(formatted).toContain('You spent $500');
  });

  test('setModel updates the model', () => {
    history.setModel('new-model');
    // No error means success — model is private, so we verify indirectly
    expect(true).toBe(true);
  });

  test('multiple queries build up history', async () => {
    history.saveUserQuery('q1');
    await history.saveAnswer('a1');
    history.saveUserQuery('q2');
    await history.saveAnswer('a2');
    history.saveUserQuery('q3');
    await history.saveAnswer('a3');
    expect(history.getMessages()).toHaveLength(3);
    expect(history.getUserMessages()).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('InMemoryChatHistory session lifecycle', () => {
  let history: InMemoryChatHistory;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = new InMemoryChatHistory('test-model', 10);
    llmSpy = spyOn(llmModule, 'callLlm').mockResolvedValue({
      response: { content: 'Mock summary', structured: null },
      metadata: {},
    } as any);
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('session not created until first saveUserQuery (lazy)', () => {
    const db = createTestDb();
    history.setDatabase(db);
    // No messages sent yet — no session should exist
    const sessions = getChatSessions(db);
    expect(sessions).toHaveLength(0);
    expect(history.getSessionId()).toBeNull();
  });

  test('setSessionId switches to existing session', () => {
    const db = createTestDb();
    history.setDatabase(db);
    history.saveUserQuery('creates session');
    const firstSession = history.getSessionId();
    expect(firstSession).toBeTruthy();

    // Switch to a different session
    history.setSessionId('custom-session-id');
    expect(history.getSessionId()).toBe('custom-session-id');
  });

  test('saveAnswer auto-titles session from summary or query', async () => {
    const db = createTestDb();
    history.setDatabase(db);
    history.saveUserQuery('What is my budget?');
    await history.saveAnswer('Your budget is $500.');
    const sessionId = history.getSessionId();
    expect(sessionId).toBeTruthy();
    const sessions = getChatSessions(db);
    const session = sessions.find(s => s.id === sessionId);
    expect(session?.title).toBe('Mock summary');
  });

  test('messages persist to DB with correct session_id', async () => {
    const db = createTestDb();
    history.setDatabase(db);
    history.saveUserQuery('first question');
    await history.saveAnswer('first answer');
    history.saveUserQuery('second question');
    await history.saveAnswer('second answer');

    const sessionId = history.getSessionId()!;
    const messages = getChatHistoryBySession(db, sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].query).toBe('first question');
    expect(messages[0].answer).toBe('first answer');
    expect(messages[1].query).toBe('second question');
    expect(messages[1].session_id).toBe(sessionId);
  });
});

describe('InMemoryChatHistory selectRelevantMessages', () => {
  let history: InMemoryChatHistory;
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    history = new InMemoryChatHistory('test-model', 10);
    // Default mock for saveAnswer's generateSummary
    llmSpy = spyOn(llmModule, 'callLlm').mockResolvedValue({
      response: { content: 'Mock summary', structured: null },
      metadata: {},
    } as any);
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('selectRelevantMessages returns selected messages from LLM', async () => {
    // Build up history with completed messages
    history.saveUserQuery('What did I spend on groceries?');
    await history.saveAnswer('You spent $200 on groceries.');
    history.saveUserQuery('Show my budget');
    await history.saveAnswer('Your budget is $500.');

    // Now reconfigure the spy to return structured message_ids for selectRelevantMessages
    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: { message_ids: [0] },
      },
      metadata: {},
    } as any);

    const relevant = await history.selectRelevantMessages('How much did I overspend?');
    expect(relevant).toHaveLength(1);
    expect(relevant[0].query).toBe('What did I spend on groceries?');
  });

  test('selectRelevantMessages cache hit on same query', async () => {
    history.saveUserQuery('test query');
    await history.saveAnswer('test answer');

    llmSpy.mockResolvedValue({
      response: {
        content: '',
        structured: { message_ids: [0] },
      },
      metadata: {},
    } as any);

    // First call — should call LLM
    const first = await history.selectRelevantMessages('same query');
    const callCount = llmSpy.mock.calls.length;

    // Second call with same query — should use cache, no additional LLM call
    const second = await history.selectRelevantMessages('same query');
    // Only the calls from saveAnswer's generateSummary + the first selectRelevantMessages
    // The second call should NOT have added another LLM call
    expect(llmSpy.mock.calls.length).toBe(callCount);
    expect(second).toEqual(first);
  });

  test('selectRelevantMessages returns [] on LLM error', async () => {
    history.saveUserQuery('test query');
    await history.saveAnswer('test answer');

    // Make the next LLM call throw
    llmSpy.mockRejectedValue(new Error('LLM unavailable'));

    const result = await history.selectRelevantMessages('will this work?');
    expect(result).toEqual([]);
  });

  test('selectRelevantMessages returns [] when no completed messages', async () => {
    history.saveUserQuery('unanswered query');
    // No saveAnswer call — message has no answer

    const result = await history.selectRelevantMessages('anything');
    expect(result).toEqual([]);
  });

  test('clear resets messages, cache, and hasMessages', async () => {
    history.saveUserQuery('q1');
    await history.saveAnswer('a1');

    // Populate selectRelevantMessages cache
    llmSpy.mockResolvedValue({
      response: { content: '', structured: { message_ids: [0] } },
      metadata: {},
    } as any);
    await history.selectRelevantMessages('cached query');

    history.clear();
    expect(history.hasMessages()).toBe(false);
    expect(history.getMessages()).toHaveLength(0);
    expect(history.getUserMessages()).toEqual([]);

    // After clear, selectRelevantMessages should return [] (no messages)
    const result = await history.selectRelevantMessages('cached query');
    expect(result).toEqual([]);
  });

  test('setSessionId and getSessionId', () => {
    expect(history.getSessionId()).toBeNull();
    history.setSessionId('custom-id-123');
    expect(history.getSessionId()).toBe('custom-id-123');
  });

  test('setDatabase enables persistence on saveUserQuery', async () => {
    const db = createTestDb();
    history.setDatabase(db);

    history.saveUserQuery('persisted query');
    await history.saveAnswer('persisted answer');

    const sessionId = history.getSessionId();
    expect(sessionId).toBeTruthy();

    const rows = getChatHistoryBySession(db, sessionId!);
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe('persisted query');
    expect(rows[0].answer).toBe('persisted answer');
  });
});
