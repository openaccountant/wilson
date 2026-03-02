import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import {
  createChatSession,
  getChatSessions,
  updateSessionTitle,
  getChatHistoryBySession,
  insertChatMessage,
} from '../db/queries.js';

describe('chat sessions', () => {
  test('createChatSession returns a UUID', () => {
    const db = createTestDb();
    const id = createChatSession(db);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('getChatSessions returns sessions', () => {
    const db = createTestDb();
    createChatSession(db);
    createChatSession(db);
    createChatSession(db);
    const sessions = getChatSessions(db);
    expect(sessions).toHaveLength(3);
    // All should have started_at timestamps
    for (const s of sessions) {
      expect(s.started_at).toBeTruthy();
    }
  });

  test('updateSessionTitle updates the title', () => {
    const db = createTestDb();
    const id = createChatSession(db);
    updateSessionTitle(db, id, 'My Budget Chat');
    const sessions = getChatSessions(db);
    const session = sessions.find(s => s.id === id);
    expect(session?.title).toBe('My Budget Chat');
  });

  test('getChatHistoryBySession returns only messages for that session', () => {
    const db = createTestDb();
    const s1 = createChatSession(db);
    const s2 = createChatSession(db);
    insertChatMessage(db, 'query in s1', 'answer in s1', null, s1);
    insertChatMessage(db, 'query in s2', 'answer in s2', null, s2);
    insertChatMessage(db, 'another in s1', null, null, s1);

    const history1 = getChatHistoryBySession(db, s1);
    expect(history1).toHaveLength(2);
    expect(history1[0].query).toBe('query in s1');
    expect(history1[1].query).toBe('another in s1');

    const history2 = getChatHistoryBySession(db, s2);
    expect(history2).toHaveLength(1);
    expect(history2[0].query).toBe('query in s2');
  });

  test('insertChatMessage stores session_id', () => {
    const db = createTestDb();
    const sessionId = createChatSession(db);
    const msgId = insertChatMessage(db, 'hello', 'world', 'summary', sessionId);
    expect(msgId).toBeGreaterThan(0);
    const history = getChatHistoryBySession(db, sessionId);
    expect(history).toHaveLength(1);
    expect(history[0].query).toBe('hello');
    expect(history[0].answer).toBe('world');
    expect(history[0].summary).toBe('summary');
    expect(history[0].session_id).toBe(sessionId);
  });

  test('insertChatMessage works with null session_id', () => {
    const db = createTestDb();
    const msgId = insertChatMessage(db, 'orphan query', null, null, null);
    expect(msgId).toBeGreaterThan(0);
  });
});
