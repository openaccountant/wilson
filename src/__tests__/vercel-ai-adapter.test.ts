import { describe, test, expect } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { VercelAiAdapter } from '../model/providers/vercel-ai.js';

describe('VercelAiAdapter', () => {
  test('sends the system prompt via instructions, not a system message (AI SDK 7 rejects those)', async () => {
    let seen: unknown;
    const model = new MockLanguageModelV3({
      doGenerate: async (opts: unknown) => {
        seen = opts;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        } as never;
      },
    });
    const adapter = new VercelAiAdapter(() => model);
    const res = await adapter.call({ model: 'm', systemPrompt: 'SYS-PROMPT', userPrompt: 'hello' } as never);
    expect(res.content).toBe('ok');
    expect(JSON.stringify(seen)).toContain('SYS-PROMPT');
  });
});
