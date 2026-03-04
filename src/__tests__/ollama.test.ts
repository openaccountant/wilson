import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { getOllamaModels } from '../utils/ollama.js';

describe('getOllamaModels', () => {
  const originalEnv = process.env.OLLAMA_BASE_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = originalEnv;
    }
  });

  test('returns model names from valid response', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            { name: 'llama3:latest', modified_at: '2024-01-01', size: 1000 },
            { name: 'mistral:7b', modified_at: '2024-01-01', size: 2000 },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await getOllamaModels();
    expect(models).toEqual(['llama3:latest', 'mistral:7b']);
    spy.mockRestore();
  });

  test('returns empty array on non-ok status', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    const models = await getOllamaModels();
    expect(models).toEqual([]);
    spy.mockRestore();
  });

  test('returns empty array when fetch throws', async () => {
    const spy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const models = await getOllamaModels();
    expect(models).toEqual([]);
    spy.mockRestore();
  });

  test('uses custom OLLAMA_BASE_URL env var', async () => {
    process.env.OLLAMA_BASE_URL = 'http://my-server:11434';

    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ name: 'phi3:latest', modified_at: '2024-01-01', size: 500 }],
        }),
        { status: 200 },
      ),
    );

    const models = await getOllamaModels();
    expect(models).toEqual(['phi3:latest']);
    expect(spy.mock.calls[0][0]).toBe('http://my-server:11434/api/tags');
    spy.mockRestore();
  });

  test('handles response with empty models array', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    );

    const models = await getOllamaModels();
    expect(models).toEqual([]);
    spy.mockRestore();
  });

  test('handles response with missing models key', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const models = await getOllamaModels();
    expect(models).toEqual([]);
    spy.mockRestore();
  });
});
