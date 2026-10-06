import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import { createTestDb, ensureTestProfile } from './helpers.js';
import { initChatSession, handleChatMessage, setChatDeadlineMs } from '../dashboard/chat.js';
import { AgentRunnerController } from '../controllers/index.js';
import { saveConfig, setSetting } from '../utils/config.js';

/**
 * POST /api/chat awaits handleChatMessage with no other timeout (and the
 * browser sets none), so it must always settle with an answer: a run that
 * never finishes, or one that fails inside the runner, still comes back as a
 * readable error bubble.
 */
describe('dashboard chat always answers', () => {
  const spies: ReturnType<typeof spyOn>[] = [];
  ensureTestProfile();

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies.length = 0;
    setChatDeadlineMs(null);
    saveConfig({});
  });

  function init() {
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    initChatSession(createTestDb());
  }

  test('a run that never settles answers with a deadline error and is cancelled', async () => {
    const runQuery = spyOn(AgentRunnerController.prototype, 'runQuery').mockImplementation(
      () => new Promise(() => {}),
    );
    const cancel = spyOn(AgentRunnerController.prototype, 'cancelExecution');
    spies.push(runQuery, cancel);
    init();
    setChatDeadlineMs(30);

    const res = await handleChatMessage('how much did I spend?');
    expect(res.answer).toStartWith('Error:');
    expect(res.answer).toContain('did not finish');
    expect(cancel).toHaveBeenCalled();
  });

  test('a failure the runner swallowed surfaces its message instead of "No response generated."', async () => {
    // What runQuery does on a non-abort failure: record it and resolve undefined.
    const runQuery = spyOn(AgentRunnerController.prototype, 'runQuery').mockImplementation(
      async function (this: AgentRunnerController) {
        this.setError('Local model x failed (webgpu): Unknown failure.');
        return undefined;
      },
    );
    spies.push(runQuery);
    init();

    const res = await handleChatMessage('hello');
    expect(res.answer).toBe('Error: Local model x failed (webgpu): Unknown failure.');
  });
});
