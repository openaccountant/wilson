import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createTestDb, ensureTestProfile } from './helpers.js';
import { Agent } from '../agent/agent.js';
import type { AgentEvent } from '../agent/types.js';
import { AgentRunnerController } from '../controllers/index.js';
import { handleChatMessage, initChatSession, setChatDeadlineMs } from '../dashboard/chat.js';
import { provenanceBadge, replyProvenance } from '../dashboard/chat-provenance.js';
import type { ChatProvenance, ServerModelInfo } from '../dashboard/chat-provenance.js';
import { getDashboardHtml } from '../dashboard/html.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { saveConfig, setSetting } from '../utils/config.js';
import { categorizeTool } from '../tools/categorize/categorize.js';

/**
 * #177: a chat turn that failed (the server's model unreachable, a deadline, a
 * thrown run) came back as a 200 whose answer reads "Error: …", and the browser
 * stamped it with a provenance badge such as "answered on your laptop". Nothing
 * answered. The server now marks such a reply `failed: true`, and both
 * dashboards drop the badge for it, whatever the variant. Live turns only:
 * history rows never carry provenance, so a reloaded error has no badge either.
 */

const CONNECT_ERROR = 'Error: [Ollama API] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9';

function done(answer: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type: 'done', answer, toolCalls: [], iterations: 1, totalTime: 0, ...extra } as AgentEvent;
}

/** Agent.create stand-in whose run yields exactly the given events. */
function agentYielding(events: AgentEvent[]) {
  return spyOn(Agent, 'create').mockImplementation((async () => ({
    async *run() {
      for (const e of events) yield e;
    },
  })) as unknown as typeof Agent.create);
}

const spies: Array<{ mockRestore: () => void }> = [];
// A successful turn's saveAnswer awaits generateSummary(), a real callLlm to the default local model.
// On a machine with Ollama running that takes seconds and races the 5s test timeout; stub it.
beforeEach(() => {
  spies.push(
    spyOn(InMemoryChatHistory.prototype as unknown as { generateSummary: () => Promise<string> }, 'generateSummary')
      .mockImplementation(async () => 'summary'),
  );
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies.length = 0;
  setChatDeadlineMs(null);
  saveConfig({});
});

describe('AgentRunnerController.runQuery carries the failed mark of the done event', () => {
  test('a failed done event resolves { answer, failed: true }', async () => {
    spies.push(agentYielding([done(CONNECT_ERROR, { failed: true })]));
    const runner = new AgentRunnerController({}, new InMemoryChatHistory());
    expect(await runner.runQuery('hello')).toEqual({ answer: CONNECT_ERROR, failed: true });
  });

  test('a real answer resolves without the mark', async () => {
    spies.push(agentYielding([done('You spent $500.')]));
    const runner = new AgentRunnerController({}, new InMemoryChatHistory());
    expect(await runner.runQuery('hello')).toEqual({ answer: 'You spent $500.' });
  });
});

describe('handleChatMessage marks every failed turn, and only those', () => {
  ensureTestProfile();

  function init() {
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    initChatSession(createTestDb());
  }

  function runQueryReturns(impl: (this: AgentRunnerController) => Promise<unknown>) {
    spies.push(spyOn(AgentRunnerController.prototype, 'runQuery').mockImplementation(impl as never));
  }

  test('the agent reported a model failure (server Ollama unreachable)', async () => {
    runQueryReturns(async () => ({ answer: CONNECT_ERROR, failed: true }));
    init();
    const res = await handleChatMessage('how much did I spend?');
    expect(res.answer).toBe(CONNECT_ERROR);
    expect(res.failed).toBe(true);
  });

  test('a failure the runner swallowed', async () => {
    runQueryReturns(async function (this: AgentRunnerController) {
      this.setError('[Ollama API] Cannot connect to API');
      return undefined;
    });
    init();
    const res = await handleChatMessage('hello');
    expect(res.answer).toBe('Error: [Ollama API] Cannot connect to API');
    expect(res.failed).toBe(true);
  });

  test('a run that threw', async () => {
    runQueryReturns(async () => {
      throw new Error('boom');
    });
    init();
    const res = await handleChatMessage('hello');
    expect(res.answer).toBe('Error: boom');
    expect(res.failed).toBe(true);
  });

  test('a run that never settles (deadline)', async () => {
    runQueryReturns(() => new Promise(() => {}));
    init();
    setChatDeadlineMs(1);
    const res = await handleChatMessage('hello');
    expect(res.answer).toContain('did not finish');
    expect(res.failed).toBe(true);
  });

  test('a run that produced nothing at all', async () => {
    runQueryReturns(async () => undefined);
    init();
    const res = await handleChatMessage('hello');
    expect(res.answer).toBe('No response generated.');
    expect(res.failed).toBe(true);
  });

  test('a real answer is not marked', async () => {
    runQueryReturns(async () => ({ answer: 'You spent $500.' }));
    init();
    const res = await handleChatMessage('how much did I spend?');
    expect(res.answer).toBe('You spent $500.');
    expect(res.failed).toBeUndefined();
  });
});

describe('"/categorize" marks a run nothing answered, and only those', () => {
  ensureTestProfile();

  function init() {
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    initChatSession(createTestDb());
  }

  function categorizeReturns(impl: () => Promise<string>) {
    spies.push(spyOn(categorizeTool, 'func').mockImplementation(impl as never));
  }

  const result = (data: Record<string, unknown>) => JSON.stringify({ data });

  test('the categorize tool threw (model unreachable before any batch)', async () => {
    categorizeReturns(async () => {
      throw new Error('[Ollama API] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9');
    });
    init();
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toStartWith('**Categorization failed:**');
    expect(res.failed).toBe(true);
  });

  test('every batch failed: nothing categorized or routed, batch errors reported', async () => {
    categorizeReturns(async () => result({
      success: true, totalUncategorized: 20, categorized: 0, ruleMatched: 0, llmCategorized: 0, routedForReview: 0,
      errors: ['Batch 1: [Ollama API] Cannot connect to API', 'Batch 2: [Ollama API] Cannot connect to API'],
      message: 'Categorized 0 of 20 transactions.', stillUncategorized: 20,
    }));
    init();
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toContain('Cannot connect');
    expect(res.failed).toBe(true);
  });

  test('the tool reported an error', async () => {
    categorizeReturns(async () => result({ error: 'database not initialized', categorized: 0 }));
    init();
    const res = await handleChatMessage('/categorize');
    expect(res.failed).toBe(true);
  });

  test('a partly successful run (some rows applied despite batch errors) is not marked', async () => {
    categorizeReturns(async () => result({
      success: true, totalUncategorized: 20, categorized: 10, ruleMatched: 0, llmCategorized: 10, routedForReview: 0,
      categoriesApplied: { Dining: 10 }, errors: ['Batch 2: timeout'], stillUncategorized: 10,
    }));
    init();
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toContain('Categorized **10** of 20');
    expect(res.failed).toBeUndefined();
  });

  test('a run whose rows all went to review answered (the model replied), so it is not marked', async () => {
    categorizeReturns(async () => result({
      success: true, totalUncategorized: 5, categorized: 0, routedForReview: 5, stillUncategorized: 5,
      message: 'Categorized 0 of 5 transactions. 5 routed for human review.',
    }));
    init();
    const res = await handleChatMessage('/categorize');
    expect(res.failed).toBeUndefined();
  });

  test('nothing to categorize is not marked', async () => {
    categorizeReturns(async () => result({ message: 'All transactions are already categorized.', categorized: 0, stillUncategorized: 0 }));
    init();
    const res = await handleChatMessage('/categorize');
    expect(res.answer).toBe('All transactions are already categorized.');
    expect(res.failed).toBeUndefined();
  });
});

const ALL_PROVENANCES: ChatProvenance[] = ['local-with-context', 'local-tools', 'server-continued', 'server-fallback', 'unavailable'];
// Every badge variant the server states can render: laptop, LAN host, cloud, unknown.
const SERVER_INFOS: ServerModelInfo[] = [
  { serverModelLocal: true, serverProvider: null, serverHost: null },
  { serverModelLocal: false, serverProvider: 'Ollama', serverHost: '192.168.1.20:11434' },
  { serverModelLocal: false, serverProvider: 'Anthropic', serverHost: null },
  {},
];

describe('replyProvenance: the badge a server reply gets (React ChatTab)', () => {
  test('a failed reply gets no provenance, for every state', () => {
    for (const p of ALL_PROVENANCES) expect(replyProvenance(p, { failed: true })).toBeUndefined();
  });

  test('a real reply keeps its provenance and the badge wording is unchanged', () => {
    for (const p of ALL_PROVENANCES) {
      for (const reply of [{}, { failed: false }, { failed: undefined }]) {
        const kept = replyProvenance(p, reply);
        expect(kept).toBe(p);
        for (const info of SERVER_INFOS) expect(provenanceBadge(kept!, info)).toBe(provenanceBadge(p, info));
      }
    }
    expect(provenanceBadge(replyProvenance('server-fallback', {})!, SERVER_INFOS[0])).toBe('answered on your laptop');
  });

  test('only a literal true counts as failed (a malformed flag never hides a real answer)', () => {
    expect(replyProvenance('server-fallback', { failed: 'true' as unknown as boolean })).toBe('server-fallback');
  });
});

describe('React ChatTab wires the failed mark into the live server bubble', () => {
  test('the server reply bubble takes its provenance from replyProvenance, and drops serverModel when failed', async () => {
    const src = await Bun.file(new URL('../dashboard/ui/src/tabs/ChatTab.tsx', import.meta.url)).text();
    const reply = src.slice(src.indexOf("await api<ChatResponse>('/api/chat'"), src.indexOf('refetchSessions();', src.indexOf("await api<ChatResponse>('/api/chat'")));
    expect(reply).toContain('replyProvenance(provenance, res)');
    expect(reply).not.toMatch(/^\s*provenance,\s*$/m);
  });

  test('history rows carry no provenance, so a reloaded error turn has no badge', async () => {
    const src = await Bun.file(new URL('../dashboard/ui/src/tabs/ChatTab.tsx', import.meta.url)).text();
    const historyRow = src.match(/loaded\.push\(\{ id: newId\(\), role: 'assistant'[^}]*\}/);
    expect(historyRow).not.toBeNull();
    expect(historyRow![0]).not.toContain('provenance');
  });

  test('ChatResponse declares the failed mark', async () => {
    const types = await Bun.file(new URL('../dashboard/ui/src/types.ts', import.meta.url)).text();
    const chatResponse = types.slice(types.indexOf('export interface ChatResponse'), types.indexOf('}', types.indexOf('export interface ChatResponse')));
    expect(chatResponse).toMatch(/failed\?: boolean/);
  });
});

describe('legacy dashboard (html.ts): a failed reply gets no badge', () => {
  const html = getDashboardHtml(0);
  const start = html.indexOf('var PROV_LABELS = ');
  const end = html.indexOf('function stampProv');
  // eslint-disable-next-line no-new-func
  const legacy = new Function(`${html.slice(start, end)}; return { replyAnswered: replyAnswered };`)() as {
    replyAnswered: (ok: boolean, data: unknown) => boolean;
  };

  test('replyAnswered: only an ok reply with an answer and no failed mark is stamped', () => {
    expect(legacy.replyAnswered(true, { answer: 'You spent $500.' })).toBe(true);
    expect(legacy.replyAnswered(true, { answer: 'You spent $500.', failed: false })).toBe(true);
    expect(legacy.replyAnswered(true, { answer: CONNECT_ERROR, failed: true })).toBe(false);
    expect(legacy.replyAnswered(false, { answer: 'busy' })).toBe(false);
    expect(legacy.replyAnswered(true, { answer: '' })).toBe(false);
    expect(legacy.replyAnswered(true, null)).toBe(false);
  });

  test('sendChat stamps through replyAnswered; history replay never stamps', () => {
    const send = html.slice(html.indexOf('async function sendChat'), html.indexOf("chatSend.addEventListener('click'"));
    expect(send).toContain('if (replyAnswered(res.ok, data)) stampProv(pending, prov, data);');
    const replay = html.slice(html.indexOf('function renderSessionMessages'), html.indexOf('async function loadSessions'));
    expect(replay).not.toContain('stampProv');
  });
});
