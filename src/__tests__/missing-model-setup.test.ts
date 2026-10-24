import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  classifyError,
  formatUserFacingError,
  isNonRetryableError,
  modelNameFromError,
} from '../utils/errors.js';
import { isOllamaModelInstalled, listOllamaModels } from '../utils/ollama.js';
import { buildModelTaskRows, buildModelCatalog } from '../model/task-models.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import * as llmModule from '../model/llm.js';
import { Agent } from '../agent/agent.js';
import type { AgentEvent } from '../agent/types.js';
import { AgentRunnerController } from '../controllers/index.js';
import { createTestDb, ensureTestProfile } from './helpers.js';
import { handleChatMessage, initChatSession } from '../dashboard/chat.js';
import { saveConfig, setSetting } from '../utils/config.js';
import { availabilityHint, pointsToModelSettings, MODELS_SETTINGS_LABEL } from '../dashboard/ui/src/lib/modelSetup.js';

/**
 * Fresh install, configured local model not pulled in Ollama (#182, #189):
 * - chat says what to do (pull it, or pick one in Settings → Models), not the raw provider error;
 * - the failed call is tried once and counted once (no retries, no summary call of the error);
 * - Settings → Models says "Not installed" next to "Runs on this device".
 */

const OLLAMA_RAW = "[Ollama API] model 'qwen3:8b' not found";
const OLLAMA_OPENAI_COMPAT = JSON.stringify({
  error: { message: "model 'qwen3:8b' not found", type: 'not_found_error', param: null, code: null },
});

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies.length = 0;
});

describe('classifyError: a missing model', () => {
  test('Ollama native, older Ollama, and OpenAI-style messages classify as model_not_found', () => {
    expect(classifyError(OLLAMA_RAW)).toBe('model_not_found');
    expect(classifyError(OLLAMA_OPENAI_COMPAT)).toBe('model_not_found');
    expect(classifyError('model "llama3" not found, try pulling it first')).toBe('model_not_found');
    expect(classifyError('The model `gpt-9` does not exist or you do not have access to it.')).toBe('model_not_found');
    expect(classifyError('{"error":{"code":"model_not_found"}}')).toBe('model_not_found');
  });

  test('a quoted model name with another class\'s words still classifies as missing', () => {
    expect(classifyError("[Ollama API] model 'timeout-tuned:3b' not found")).toBe('model_not_found');
  });

  test('is not retryable', () => {
    expect(isNonRetryableError(OLLAMA_RAW)).toBe(true);
  });

  test('unrelated "not found" errors are left alone', () => {
    expect(classifyError('file not found')).toBe('unknown');
    expect(classifyError('404 page not found')).toBe('unknown');
  });
});

describe('modelNameFromError', () => {
  test('pulls the quoted model id', () => {
    expect(modelNameFromError(OLLAMA_RAW)).toBe('qwen3:8b');
    expect(modelNameFromError('model "hf.co/org/Model-GGUF:Q4_K_M" not found')).toBe('hf.co/org/Model-GGUF:Q4_K_M');
  });

  test('a name with non-model-id characters is dropped, never echoed', () => {
    expect(modelNameFromError("model 'x; rm -rf ~' not found")).toBeNull();
    expect(modelNameFromError("model '<img src=x>' not found")).toBeNull();
  });
});

describe('formatUserFacingError: missing model', () => {
  test('Ollama: plain-language steps with the exact pull command and Settings → Models', () => {
    const msg = formatUserFacingError(OLLAMA_RAW);
    expect(msg).toContain('"qwen3:8b" isn\'t installed in Ollama');
    expect(msg).toContain('`ollama pull qwen3:8b`');
    expect(msg).toContain('Settings → Models');
    expect(msg).not.toContain('[Ollama API]');
  });

  test('OpenAI-compatible Ollama payload gets the same steps when the provider is named', () => {
    const msg = formatUserFacingError(OLLAMA_OPENAI_COMPAT, 'Ollama');
    expect(msg).toContain('`ollama pull qwen3:8b`');
  });

  test('an unsafe name falls back to a placeholder instead of being echoed', () => {
    const msg = formatUserFacingError("[Ollama API] model '<b>x</b>' not found");
    expect(msg).toContain('`ollama pull <model>`');
    expect(msg).not.toContain('<b>');
  });

  test('a cloud provider gets the Settings step only (no ollama pull)', () => {
    const msg = formatUserFacingError('The model `gpt-9` does not exist', 'OpenAI');
    expect(msg).toContain('from OpenAI');
    expect(msg).toContain('Settings → Models');
    expect(msg).not.toContain('ollama pull');
  });

  test('the server text and the chat button agree on where the fix lives', () => {
    expect(formatUserFacingError(OLLAMA_RAW)).toContain(MODELS_SETTINGS_LABEL);
  });
});

describe('Ollama model listing', () => {
  test('listOllamaModels is null (not []) when Ollama cannot be asked', async () => {
    spies.push(spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED')));
    expect(await listOllamaModels()).toBeNull();
    spies.push(spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 500 })));
    expect(await listOllamaModels()).toBeNull();
  });

  test('listOllamaModels reads names with a single GET to /api/tags', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: 'granite4.1:3b' }] }), { status: 200 }),
    );
    spies.push(spy);
    expect(await listOllamaModels()).toEqual(['granite4.1:3b']);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toEndWith('/api/tags');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  test('isOllamaModelInstalled: exact tag, and a bare name means :latest', () => {
    expect(isOllamaModelInstalled('qwen3:8b', ['qwen3:8b'])).toBe(true);
    expect(isOllamaModelInstalled('qwen3:8b', ['qwen3:14b'])).toBe(false);
    expect(isOllamaModelInstalled('llama3', ['llama3:latest'])).toBe(true);
    expect(isOllamaModelInstalled('llama3', ['llama3:8b'])).toBe(false);
    expect(isOllamaModelInstalled('qwen3:8b', [])).toBe(false);
  });
});

describe('buildModelTaskRows availability (#189)', () => {
  test('not probed: availability is null on every row (pure callers unchanged)', () => {
    for (const row of buildModelTaskRows('ollama:qwen3:8b', false)) expect(row.availability).toBeNull();
  });

  test('model missing from Ollama: not-installed, while execution still says local', () => {
    const rows = buildModelTaskRows('ollama:qwen3:8b', false, {}, ['granite4.1:3b']);
    const chat = rows[0];
    expect(chat.execution).toBe('local');
    expect(chat.availability).toBe('not-installed');
    expect(rows[3].availability).toBeNull(); // embeddings: not in use
  });

  test('installed model: installed; a pinned row is judged on its own model', () => {
    const rows = buildModelTaskRows('ollama:granite4.1:3b', false, { categorization: 'ollama:qwen3:8b' }, ['granite4.1:3b']);
    expect(rows[0].availability).toBe('installed');
    expect(rows[1].availability).toBe('not-installed');
    expect(rows[2].availability).toBe('installed');
  });

  test('Ollama unreachable: unreachable, never "not installed"', () => {
    const rows = buildModelTaskRows('ollama:qwen3:8b', false, {}, null);
    expect(rows[0].availability).toBe('unreachable');
  });

  test('cloud model: not checked', () => {
    const rows = buildModelTaskRows('gpt-5.2', false, {}, []);
    expect(rows[0].availability).toBeNull();
  });

  test('buildModelCatalog uses the passed listing (no second request)', async () => {
    const spy = spyOn(globalThis, 'fetch');
    spies.push(spy);
    const catalog = await buildModelCatalog(false, ['qwen3:8b']);
    expect(spy).not.toHaveBeenCalled();
    const qwen = catalog.find((m) => m.id === 'ollama:qwen3:8b');
    if (qwen) expect(qwen.cached).toBe(true);
  });
});

describe('Settings → Models hint (UI helper)', () => {
  test('not installed: chip plus the pull command and where to pick another', () => {
    const hint = availabilityHint('not-installed', 'ollama:qwen3:8b', true)!;
    expect(hint.badge).toBe('Not installed');
    expect(hint.fix).toContain('`ollama pull qwen3:8b`');
    expect(hint.fix).toContain('pick an installed model below');
  });

  test('a viewer is told to ask an admin rather than pick', () => {
    expect(availabilityHint('not-installed', 'ollama:qwen3:8b', false)!.fix).toContain('ask an admin');
  });

  test('unreachable Ollama gets its own step; installed and unchecked rows get none', () => {
    expect(availabilityHint('unreachable', 'ollama:qwen3:8b', true)!.badge).toBe('Ollama not running');
    expect(availabilityHint('installed', 'ollama:qwen3:8b', true)).toBeNull();
    expect(availabilityHint(null, 'gpt-5.2', true)).toBeNull();
  });

  test('pointsToModelSettings: only failed turns that carry the Settings step', () => {
    expect(pointsToModelSettings(`Error: ${formatUserFacingError(OLLAMA_RAW)}`)).toBe(true);
    expect(pointsToModelSettings(`**Categorization failed:** ${formatUserFacingError(OLLAMA_RAW)}`)).toBe(true);
    expect(pointsToModelSettings('Error: [Ollama API] Cannot connect to API')).toBe(false);
    expect(pointsToModelSettings('You can change it in Settings → Models.')).toBe(false);
  });
});

describe('a failed turn is counted once (#182)', () => {
  test('saveAnswer on a failed turn makes no summary call', async () => {
    const spy = spyOn(llmModule, 'callLlm');
    spies.push(spy);
    const history = new InMemoryChatHistory('ollama:qwen3:8b', 10);
    history.saveUserQuery('how much did I spend?');
    await history.saveAnswer('Error: nope', { failed: true });
    expect(spy).not.toHaveBeenCalled();
    expect(history.getMessages()[0].summary).toBe('how much did I spend?');
  });

  test('the runner passes the failed mark through to the history', async () => {
    const llm = spyOn(llmModule, 'callLlm');
    spies.push(llm);
    const doneEvent = { type: 'done', answer: 'Error: x', failed: true, toolCalls: [], iterations: 1, totalTime: 0 } as AgentEvent;
    spies.push(spyOn(Agent, 'create').mockImplementation((async () => ({
      async *run() { yield doneEvent; },
    })) as unknown as typeof Agent.create));
    const runner = new AgentRunnerController({}, new InMemoryChatHistory());
    await runner.runQuery('hello');
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('dashboard chat: raw missing-model errors are formatted', () => {
  ensureTestProfile();

  function init() {
    saveConfig({});
    setSetting('modelId', 'ollama:qwen3:8b');
    setSetting('provider', 'ollama');
    initChatSession(createTestDb());
  }

  afterEach(() => saveConfig({}));

  test('an error the runner swallowed', async () => {
    spies.push(spyOn(AgentRunnerController.prototype, 'runQuery').mockImplementation((async function (this: AgentRunnerController) {
      this.setError(OLLAMA_RAW);
      return undefined;
    }) as never));
    init();
    const res = await handleChatMessage('hello');
    expect(res.failed).toBe(true);
    expect(res.answer).toStartWith('Error: ');
    expect(res.answer).toContain('`ollama pull qwen3:8b`');
    expect(res.answer).not.toContain('[Ollama API]');
  });

  test('a run that threw', async () => {
    spies.push(spyOn(AgentRunnerController.prototype, 'runQuery').mockImplementation((async () => {
      throw new Error(OLLAMA_RAW);
    }) as never));
    init();
    const res = await handleChatMessage('hello');
    expect(res.failed).toBe(true);
    expect(res.answer).toContain('Settings → Models');
  });
});
