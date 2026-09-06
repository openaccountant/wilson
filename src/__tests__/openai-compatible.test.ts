import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  getOpenAiCompatibleApiKey,
  getOpenAiCompatibleBaseUrl,
  getOpenAiCompatibleModels,
  normalizeBaseUrl,
} from '../utils/openai-compatible.js';

const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;
const originalApiKey = process.env.OPENAI_COMPATIBLE_API_KEY;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv('OPENAI_COMPATIBLE_BASE_URL', originalBaseUrl);
  restoreEnv('OPENAI_COMPATIBLE_API_KEY', originalApiKey);
});

describe('normalizeBaseUrl', () => {
  test('appends /v1 when the URL has no path', () => {
    expect(normalizeBaseUrl('http://localhost:1234')).toBe('http://localhost:1234/v1');
  });

  test('appends /v1 when the path is only a slash', () => {
    expect(normalizeBaseUrl('http://localhost:1234/')).toBe('http://localhost:1234/v1');
  });

  test('leaves an existing path untouched', () => {
    expect(normalizeBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
    expect(normalizeBaseUrl('https://gw.example.com/openai/v1')).toBe(
      'https://gw.example.com/openai/v1',
    );
  });

  test('adds a scheme when missing', () => {
    expect(normalizeBaseUrl('localhost:8080')).toBe('http://localhost:8080/v1');
  });

  test('strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:8080/v1///')).toBe('http://localhost:8080/v1');
  });

  test('falls back to the default for empty input', () => {
    expect(normalizeBaseUrl('   ')).toBe(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
  });
});

describe('getOpenAiCompatibleBaseUrl', () => {
  test('defaults to the llama.cpp port when unset', () => {
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    expect(getOpenAiCompatibleBaseUrl()).toBe(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
  });

  test('normalizes the configured value', () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://my-server:1234';
    expect(getOpenAiCompatibleBaseUrl()).toBe('http://my-server:1234/v1');
  });
});

describe('getOpenAiCompatibleApiKey', () => {
  test('returns a placeholder when no key is configured', () => {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    expect(getOpenAiCompatibleApiKey()).toBe('not-needed');
  });

  test('returns the configured key', () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-local';
    expect(getOpenAiCompatibleApiKey()).toBe('sk-local');
  });
});

describe('getOpenAiCompatibleModels', () => {
  test('returns model ids from a valid response', async () => {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'qwen3-8b', object: 'model' },
            { id: 'gpt-oss-20b', object: 'model' },
          ],
        }),
        { status: 200 },
      ),
    );

    const models = await getOpenAiCompatibleModels();
    expect(models).toEqual(['qwen3-8b', 'gpt-oss-20b']);
    spy.mockRestore();
  });

  test('queries /models on the configured base URL', async () => {
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://my-server:1234';
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 }),
    );

    const models = await getOpenAiCompatibleModels();
    expect(models).toEqual(['local-model']);
    expect(spy.mock.calls[0][0]).toBe('http://my-server:1234/v1/models');
    spy.mockRestore();
  });

  test('sends an Authorization header when a key is configured', async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-local';
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    await getOpenAiCompatibleModels();
    expect(spy.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer sk-local' });
    spy.mockRestore();
  });

  test('returns empty array on non-ok status', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );

    expect(await getOpenAiCompatibleModels()).toEqual([]);
    spy.mockRestore();
  });

  test('returns empty array when fetch throws', async () => {
    const spy = spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    expect(await getOpenAiCompatibleModels()).toEqual([]);
    spy.mockRestore();
  });

  test('handles a response with no data key', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    expect(await getOpenAiCompatibleModels()).toEqual([]);
    spy.mockRestore();
  });
});
