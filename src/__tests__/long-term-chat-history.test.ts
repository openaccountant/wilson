import { describe, test, expect, beforeEach } from 'bun:test';
import { LongTermChatHistory } from '../utils/long-term-chat-history.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

function makeTmpDir(): string {
  const dir = join(os.tmpdir(), `oa-lth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('LongTermChatHistory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  test('constructor sets file path based on baseDir', () => {
    const history = new LongTermChatHistory(tmpDir);
    // We can't directly access filePath, but load should create the file
    expect(history).toBeDefined();
  });

  test('load creates file when missing', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    const filePath = join(tmpDir, '.openaccountant', 'messages', 'chat_history.json');
    expect(existsSync(filePath)).toBe(true);
  });

  test('load reads existing file', async () => {
    const dir = join(tmpDir, '.openaccountant', 'messages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'chat_history.json'),
      JSON.stringify({
        messages: [
          { id: '1', timestamp: '2026-01-01T00:00:00Z', userMessage: 'hello', agentResponse: 'hi' },
        ],
      }),
    );

    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    expect(history.getMessages()).toHaveLength(1);
    expect(history.getMessages()[0].userMessage).toBe('hello');
  });

  test('load handles malformed JSON gracefully', async () => {
    const dir = join(tmpDir, '.openaccountant', 'messages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chat_history.json'), 'not-json{{{');

    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    expect(history.getMessages()).toHaveLength(0);
  });

  test('load is idempotent (only loads once)', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    await history.addUserMessage('first');
    // Second load should be a no-op
    await history.load();
    expect(history.getMessages()).toHaveLength(1);
  });

  test('addUserMessage prepends to stack', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    await history.addUserMessage('first');
    await history.addUserMessage('second');
    const msgs = history.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].userMessage).toBe('second');
    expect(msgs[1].userMessage).toBe('first');
  });

  test('addUserMessage sets agentResponse to null', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    await history.addUserMessage('test');
    expect(history.getMessages()[0].agentResponse).toBeNull();
  });

  test('addUserMessage auto-loads if not loaded', async () => {
    const history = new LongTermChatHistory(tmpDir);
    // Don't call load() explicitly
    await history.addUserMessage('auto-load');
    expect(history.getMessages()).toHaveLength(1);
  });

  test('updateAgentResponse updates most recent entry', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    await history.addUserMessage('question');
    await history.updateAgentResponse('answer');
    expect(history.getMessages()[0].agentResponse).toBe('answer');
  });

  test('updateAgentResponse does nothing if no messages', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    // Should not throw
    await history.updateAgentResponse('orphan answer');
    expect(history.getMessages()).toHaveLength(0);
  });

  test('updateAgentResponse auto-loads if not loaded', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.addUserMessage('q');
    // Create a fresh instance to test auto-load on updateAgentResponse
    const history2 = new LongTermChatHistory(tmpDir);
    await history2.updateAgentResponse('a');
    expect(history2.getMessages()[0].agentResponse).toBe('a');
  });

  test('getMessages returns a copy', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    await history.addUserMessage('test');
    const a = history.getMessages();
    const b = history.getMessages();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  test('getMessageStrings returns user messages newest first', async () => {
    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    await history.addUserMessage('first');
    await history.addUserMessage('second');
    await history.addUserMessage('third');
    expect(history.getMessageStrings()).toEqual(['third', 'second', 'first']);
  });

  test('getMessageStrings deduplicates consecutive duplicates', async () => {
    const dir = join(tmpDir, '.openaccountant', 'messages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'chat_history.json'),
      JSON.stringify({
        messages: [
          { id: '3', timestamp: '2026-01-03', userMessage: 'hello', agentResponse: null },
          { id: '2', timestamp: '2026-01-02', userMessage: 'hello', agentResponse: null },
          { id: '1', timestamp: '2026-01-01', userMessage: 'world', agentResponse: null },
        ],
      }),
    );

    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    // 'hello' appears twice consecutively, should be deduped to one
    expect(history.getMessageStrings()).toEqual(['hello', 'world']);
  });

  test('getMessageStrings does not dedup non-consecutive duplicates', async () => {
    const dir = join(tmpDir, '.openaccountant', 'messages');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'chat_history.json'),
      JSON.stringify({
        messages: [
          { id: '3', timestamp: '2026-01-03', userMessage: 'hello', agentResponse: null },
          { id: '2', timestamp: '2026-01-02', userMessage: 'world', agentResponse: null },
          { id: '1', timestamp: '2026-01-01', userMessage: 'hello', agentResponse: null },
        ],
      }),
    );

    const history = new LongTermChatHistory(tmpDir);
    await history.load();
    expect(history.getMessageStrings()).toEqual(['hello', 'world', 'hello']);
  });

  test('persistence across instances', async () => {
    const h1 = new LongTermChatHistory(tmpDir);
    await h1.load();
    await h1.addUserMessage('persisted');
    await h1.updateAgentResponse('yes');

    // New instance, same dir
    const h2 = new LongTermChatHistory(tmpDir);
    await h2.load();
    expect(h2.getMessages()).toHaveLength(1);
    expect(h2.getMessages()[0].userMessage).toBe('persisted');
    expect(h2.getMessages()[0].agentResponse).toBe('yes');
  });
});
