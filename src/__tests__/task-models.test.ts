import { describe, expect, test } from 'bun:test';
import { PROVIDERS } from '../providers.js';
import {
  buildModelTaskRows,
  CALL_TYPE_CATEGORIZATION,
  CALL_TYPE_ENTITY_CLASSIFICATION,
} from '../model/task-models.js';

/**
 * The Settings "Models" panel data: provider local/server classification and
 * the per-task row shape. Pure tests — no profile, no WebGPU probe, no LLM.
 */

describe('provider registry isLocal classification', () => {
  test('every entry declares a boolean isLocal', () => {
    for (const p of PROVIDERS) {
      expect(typeof p.isLocal).toBe('boolean');
    }
  });

  test('local providers are exactly ollama, openai-compatible, and transformers', () => {
    const local = PROVIDERS.filter((p) => p.isLocal).map((p) => p.id).sort();
    expect(local).toEqual(['ollama', 'openai-compatible', 'transformers']);
  });

  test('cloud providers are classified as server', () => {
    const cloudIds = ['openai', 'anthropic', 'google', 'xai', 'moonshot', 'deepseek', 'openrouter', 'litellm'];
    for (const id of cloudIds) {
      const p = PROVIDERS.find((entry) => entry.id === id);
      expect(p).toBeDefined();
      expect(p!.isLocal).toBe(false);
    }
  });
});

describe('buildModelTaskRows', () => {
  test('emits four rows in order: chat, categorization, entity-classification, embeddings', () => {
    const rows = buildModelTaskRows('ollama:qwen3:8b', true);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.task)).toEqual(['chat', 'categorization', 'entity-classification', 'embeddings']);
    expect(rows.map((r) => r.label)).toEqual(['Chat', 'Categorization', 'Entity classification', 'Embeddings']);
  });

  test('local model: in-use rows carry the model, friendly name, local execution, webgpu passthrough', () => {
    const rows = buildModelTaskRows('ollama:qwen3:8b', true);
    for (const row of rows.slice(0, 3)) {
      expect(row.inUse).toBe(true);
      expect(row.model).toBe('ollama:qwen3:8b');
      expect(row.modelName).toContain('Qwen3 8B'); // friendly name, not the raw id
      expect(row.provider).toBe('ollama');
      expect(row.providerName).toBe('Ollama');
      expect(row.execution).toBe('local');
      expect(row.webgpu).toBe(true);
      expect(row.assignment).toBe('default');
      expect(row.note).toBeNull();
    }
  });

  test('embeddings row is not-in-use with no model, provider, or execution', () => {
    const [embeddings] = buildModelTaskRows('ollama:qwen3:8b', true).slice(-1);
    expect(embeddings.task).toBe('embeddings');
    expect(embeddings.inUse).toBe(false);
    expect(embeddings.model).toBeNull();
    expect(embeddings.modelName).toBeNull();
    expect(embeddings.provider).toBeNull();
    expect(embeddings.providerName).toBeNull();
    expect(embeddings.execution).toBeNull();
    expect(embeddings.note).toContain('No embeddings task');
    expect(embeddings.assignment).toBe('default');
    expect(embeddings.webgpu).toBe(true);
  });

  test('cloud model: server execution and webgpu passthrough', () => {
    const rows = buildModelTaskRows('gpt-5.2', false);
    for (const row of rows.slice(0, 3)) {
      expect(row.execution).toBe('server');
      expect(row.provider).toBe('openai');
      expect(row.providerName).toBe('OpenAI');
      expect(row.webgpu).toBe(false);
    }
    expect(rows[0].modelName).toBe('GPT 5.2');
  });

  test('unknown model id: friendly-name and provider fallbacks stay truthful', () => {
    const rows = buildModelTaskRows('totally-unknown-model-xyz', true);
    const chat = rows[0];
    // getModelDisplayName falls back to the prefix-stripped id…
    expect(chat.modelName).toBe('totally-unknown-model-xyz');
    // …and resolveProvider falls back to OpenAI (server) for unprefixed ids.
    expect(chat.provider).toBe('openai');
    expect(chat.execution).toBe('server');
  });

  test('every row carries the machine-level webgpu flag', () => {
    for (const row of buildModelTaskRows('ollama:qwen3:8b', false)) {
      expect(row.webgpu).toBe(false);
    }
    for (const row of buildModelTaskRows('gpt-5.2', true)) {
      expect(row.webgpu).toBe(true);
    }
  });
});

describe('call-type constants (drift guard)', () => {
  test('tool call sites and Training filter share these values', () => {
    expect(CALL_TYPE_CATEGORIZATION).toBe('categorization');
    expect(CALL_TYPE_ENTITY_CLASSIFICATION).toBe('entity-classification');
  });
});