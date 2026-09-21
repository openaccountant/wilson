import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import { createTestDb, ensureTestProfile } from './helpers.js';
import {
  initChatSession,
  handleChatMessage,
  getAppliedChatModel,
  getActiveChatHistory,
} from '../dashboard/chat.js';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { setSetting, saveConfig, getConfiguredModel } from '../utils/config.js';

/**
 * The dashboard chat's live model path (the panel's Chat row / the TUI /model
 * switch / a hand-edited settings.json — all writers of the same setting):
 *
 * - initChatSession applies the configured chat model (the session must not
 *   ride InMemoryChatHistory's DEFAULT_MODEL baseline).
 * - handleChatMessage re-resolves the setting per message through the same
 *   live-update path the TUI's /model switch uses — agentRunner.updateModel +
 *   chatHistory.setModel — so a change lands on the next dashboard message
 *   with no restart, and the background summarize/relevance consumers (which
 *   read chatHistory's model) follow.
 *
 * Zero LLM machinery: runQuery is mocked; the spies on updateModel/setModel
 * are call-through so the real apply path is exercised and observed.
 */
describe('dashboard chat model applies live', () => {
  const spies: ReturnType<typeof spyOn>[] = [];

  // Settings are profile files — ensure the temp profile exists before the
  // first setSetting (createTestDb would do it, but tests set settings first).
  ensureTestProfile();

  afterEach(() => {
    for (const s of spies) {
      try { s.mockRestore(); } catch { /* */ }
    }
    spies.length = 0;
    saveConfig({});
  });

  test('init applies the configured chat model, not the InMemoryChatHistory default', () => {
    const updateModelSpy = spyOn(AgentRunnerController.prototype, 'updateModel');
    const setModelSpy = spyOn(InMemoryChatHistory.prototype, 'setModel');
    spies.push(updateModelSpy, setModelSpy);

    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    expect(getConfiguredModel()).toEqual({ model: 'gpt-5.2', provider: 'openai' });

    initChatSession(createTestDb());

    expect(getAppliedChatModel()).toEqual({ model: 'gpt-5.2', provider: 'openai' });
    expect(getActiveChatHistory()!.currentModel).toBe('gpt-5.2');
  });

  test('a chat-model change between messages applies to the next message with no restart', async () => {
    const runQuerySpy = spyOn(AgentRunnerController.prototype, 'runQuery')
      .mockResolvedValue({ answer: 'ok' });
    const updateModelSpy = spyOn(AgentRunnerController.prototype, 'updateModel');
    const setModelSpy = spyOn(InMemoryChatHistory.prototype, 'setModel');
    spies.push(runQuerySpy, updateModelSpy, setModelSpy);

    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    initChatSession(createTestDb());

    const first = await handleChatMessage('hi');
    expect(first.answer).toBe('ok');
    let last = updateModelSpy.mock.calls[updateModelSpy.mock.calls.length - 1];
    expect(last[0]).toBe('gpt-5.2');
    expect(last[1]).toBe('openai');
    expect(getActiveChatHistory()!.currentModel).toBe('gpt-5.2');

    // Switch the setting (exactly what the panel's chat write persists).
    setSetting('modelId', 'ollama:qwen3:0.6b');
    setSetting('provider', 'ollama');

    const second = await handleChatMessage('again');
    expect(second.answer).toBe('ok');
    last = updateModelSpy.mock.calls[updateModelSpy.mock.calls.length - 1];
    expect(last[0]).toBe('ollama:qwen3:0.6b');
    expect(last[1]).toBe('ollama');
    // The background summarize/relevance consumers read this model.
    expect(getActiveChatHistory()!.currentModel).toBe('ollama:qwen3:0.6b');
    expect(getAppliedChatModel()).toEqual({ model: 'ollama:qwen3:0.6b', provider: 'ollama' });
  });

  test('an unchanged model is not re-applied (no churn between messages)', async () => {
    const runQuerySpy = spyOn(AgentRunnerController.prototype, 'runQuery')
      .mockResolvedValue({ answer: 'ok' });
    const updateModelSpy = spyOn(AgentRunnerController.prototype, 'updateModel');
    spies.push(runQuerySpy, updateModelSpy);

    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    initChatSession(createTestDb());
    const appliedAfterInit = updateModelSpy.mock.calls.length;

    await handleChatMessage('hi');
    await handleChatMessage('still here');
    expect(updateModelSpy.mock.calls.length).toBe(appliedAfterInit);
  });
});