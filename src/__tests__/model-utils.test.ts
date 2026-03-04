import { describe, test, expect } from 'bun:test';
import {
  getModelsForProvider,
  getModelIdsForProvider,
  getDefaultModelForProvider,
  getModelDisplayName,
  PROVIDERS,
} from '../utils/model.js';

describe('model utils', () => {
  describe('getModelsForProvider', () => {
    test('returns models for known provider (openai)', () => {
      const models = getModelsForProvider('openai');
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('displayName');
    });

    test('returns models for known provider (anthropic)', () => {
      const models = getModelsForProvider('anthropic');
      expect(models.length).toBeGreaterThan(0);
      const ids = models.map((m) => m.id);
      expect(ids.some((id) => id.startsWith('claude-'))).toBe(true);
    });

    test('returns empty array for unknown provider', () => {
      const models = getModelsForProvider('nonexistent-provider');
      expect(models).toEqual([]);
    });
  });

  describe('getModelIdsForProvider', () => {
    test('returns model IDs as strings for known provider', () => {
      const ids = getModelIdsForProvider('openai');
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(typeof id).toBe('string');
      }
    });

    test('returns empty array for unknown provider', () => {
      expect(getModelIdsForProvider('unknown')).toEqual([]);
    });
  });

  describe('getDefaultModelForProvider', () => {
    test('returns first model ID for known provider', () => {
      const defaultModel = getDefaultModelForProvider('openai');
      expect(typeof defaultModel).toBe('string');
      const allIds = getModelIdsForProvider('openai');
      expect(defaultModel).toBe(allIds[0]);
    });

    test('returns undefined for unknown provider', () => {
      expect(getDefaultModelForProvider('unknown')).toBeUndefined();
    });

    test('returns undefined for provider with no models', () => {
      // Ollama has no hardcoded models in PROVIDER_MODELS
      const result = getDefaultModelForProvider('ollama');
      expect(result).toBeUndefined();
    });
  });

  describe('getModelDisplayName', () => {
    test('returns display name for known model', () => {
      const name = getModelDisplayName('claude-sonnet-4-6');
      expect(name).toBe('Sonnet 4.6');
    });

    test('strips ollama: prefix and falls back to normalized ID', () => {
      const name = getModelDisplayName('ollama:llama3');
      expect(name).toBe('llama3');
    });

    test('strips openrouter: prefix and falls back to normalized ID', () => {
      const name = getModelDisplayName('openrouter:custom/model');
      expect(name).toBe('custom/model');
    });

    test('returns the model ID for completely unknown model', () => {
      const name = getModelDisplayName('totally-unknown-model');
      expect(name).toBe('totally-unknown-model');
    });
  });

  describe('PROVIDERS', () => {
    test('includes entries for known providers', () => {
      const ids = PROVIDERS.map((p) => p.providerId);
      expect(ids).toContain('openai');
      expect(ids).toContain('anthropic');
      expect(ids).toContain('google');
    });

    test('each provider has displayName and providerId', () => {
      for (const provider of PROVIDERS) {
        expect(typeof provider.displayName).toBe('string');
        expect(typeof provider.providerId).toBe('string');
        expect(Array.isArray(provider.models)).toBe(true);
      }
    });
  });
});
