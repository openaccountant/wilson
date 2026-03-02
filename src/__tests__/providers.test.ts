import { describe, expect, test } from 'bun:test';
import { resolveProvider, getProviderById, PROVIDERS } from '../providers.js';
import { getModelsForProvider, getModelDisplayName } from '../utils/model.js';
import { estimateTokens } from '../utils/tokens.js';

describe('resolveProvider', () => {
  test('routes claude- prefix to Anthropic', () => {
    expect(resolveProvider('claude-sonnet-4-6').id).toBe('anthropic');
  });

  test('routes gemini- prefix to Google', () => {
    expect(resolveProvider('gemini-3-pro-preview').id).toBe('google');
  });

  test('routes grok- prefix to xAI', () => {
    expect(resolveProvider('grok-4-0709').id).toBe('xai');
  });

  test('routes ollama: prefix to Ollama', () => {
    expect(resolveProvider('ollama:llama3').id).toBe('ollama');
  });

  test('routes deepseek- prefix to DeepSeek', () => {
    expect(resolveProvider('deepseek-chat').id).toBe('deepseek');
  });

  test('falls back to OpenAI for unknown prefix', () => {
    expect(resolveProvider('gpt-5.2').id).toBe('openai');
  });

  test('falls back to OpenAI for empty string', () => {
    expect(resolveProvider('').id).toBe('openai');
  });
});

describe('getProviderById', () => {
  test('finds anthropic by id', () => {
    expect(getProviderById('anthropic')?.displayName).toBe('Anthropic');
  });

  test('returns undefined for unknown id', () => {
    expect(getProviderById('nonexistent')).toBeUndefined();
  });
});

describe('getModelsForProvider', () => {
  test('returns models for openai', () => {
    const models = getModelsForProvider('openai');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id.includes('gpt'))).toBe(true);
  });

  test('returns empty array for unknown provider', () => {
    expect(getModelsForProvider('nonexistent')).toEqual([]);
  });
});

describe('getModelDisplayName', () => {
  test('returns display name for known model', () => {
    expect(getModelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  test('strips ollama: prefix for lookup', () => {
    // Unknown model after stripping prefix — returns the normalized ID
    expect(getModelDisplayName('ollama:llama3')).toBe('llama3');
  });

  test('returns model ID for unknown model', () => {
    expect(getModelDisplayName('unknown-model-xyz')).toBe('unknown-model-xyz');
  });
});

describe('estimateTokens', () => {
  test('estimates based on character count / 3.5', () => {
    const text = 'a'.repeat(35);
    expect(estimateTokens(text)).toBe(10);
  });

  test('rounds up', () => {
    expect(estimateTokens('hi')).toBe(1);
  });

  test('empty string returns 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
