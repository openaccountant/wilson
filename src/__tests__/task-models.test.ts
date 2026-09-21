import { describe, expect, test, afterEach } from 'bun:test';
import { PROVIDERS as PROVIDER_DEFS } from '../providers.js';
import {
  PROVIDERS as PROVIDER_REGISTRY,
} from '../utils/model.js';
import {
  buildModelTaskRows,
  buildModelCatalog,
  getTaskModel,
  getTaskOverride,
  setTaskOverride,
  validateTaskModel,
  CALL_TYPE_CATEGORIZATION,
  CALL_TYPE_ENTITY_CLASSIFICATION,
} from '../model/task-models.js';
import { setSetting, saveConfig } from '../utils/config.js';
import { isTransformersModelCached } from '../utils/model.js';
import { ensureTestProfile } from './helpers.js';

/**
 * The Settings "Models" panel data: provider local/server classification and
 * the per-task row shape. Pure tests — no profile, no WebGPU probe, no LLM.
 */

describe('provider registry isLocal classification', () => {
  test('every entry declares a boolean isLocal', () => {
    for (const p of PROVIDER_DEFS) {
      expect(typeof p.isLocal).toBe('boolean');
    }
  });

  test('local providers are exactly ollama and transformers', () => {
    const local = PROVIDER_DEFS.filter((p) => p.isLocal).map((p) => p.id).sort();
    expect(local).toEqual(['ollama', 'transformers']);
  });

  test('cloud providers are classified as server', () => {
    const cloudIds = ['openai', 'anthropic', 'google', 'xai', 'moonshot', 'deepseek', 'openrouter', 'litellm'];
    for (const id of cloudIds) {
      const p = PROVIDER_DEFS.find((entry) => entry.id === id);
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

describe('buildModelTaskRows with per-task overrides', () => {
  test('a pinned categorization row resolves from the pin; the other rows still follow the chat model', () => {
    const rows = buildModelTaskRows('gpt-5.2', false, { categorization: 'ollama:qwen3:0.6b' });
    const [chat, categorization, entity] = rows;

    expect(chat.task).toBe('chat');
    expect(chat.model).toBe('gpt-5.2');
    expect(chat.assignment).toBe('default');

    expect(categorization.task).toBe('categorization');
    expect(categorization.model).toBe('ollama:qwen3:0.6b');
    expect(categorization.modelName).toContain('Qwen3 0.6B'); // friendly name from the pin
    expect(categorization.provider).toBe('ollama');
    expect(categorization.providerName).toBe('Ollama');
    expect(categorization.execution).toBe('local');
    expect(categorization.assignment).toBe('override');

    expect(entity.task).toBe('entity-classification');
    expect(entity.model).toBe('gpt-5.2');
    expect(entity.assignment).toBe('default');
  });

  test('both overrides set → both rows report override', () => {
    const rows = buildModelTaskRows('gpt-5.2', false, {
      categorization: 'ollama:qwen3:0.6b',
      'entity-classification': 'claude-sonnet-4-6',
    });
    const categorization = rows.find((r) => r.task === 'categorization')!;
    const entity = rows.find((r) => r.task === 'entity-classification')!;
    expect(categorization.assignment).toBe('override');
    expect(categorization.model).toBe('ollama:qwen3:0.6b');
    expect(categorization.execution).toBe('local');
    expect(entity.assignment).toBe('override');
    expect(entity.model).toBe('claude-sonnet-4-6');
    expect(entity.provider).toBe('anthropic');
    expect(entity.execution).toBe('server');
  });

  test('null overrides mean "follows the chat model" (reset semantics in the builder)', () => {
    const rows = buildModelTaskRows('ollama:qwen3:8b', true, { categorization: null });
    const categorization = rows.find((r) => r.task === 'categorization')!;
    expect(categorization.model).toBe('ollama:qwen3:8b');
    expect(categorization.assignment).toBe('default');
  });

  test('omitting overrides entirely keeps every row on the chat model (pre-#89 shape)', () => {
    const rows = buildModelTaskRows('ollama:qwen3:8b', true);
    for (const row of rows.slice(0, 3)) {
      expect(row.assignment).toBe('default');
      expect(row.model).toBe('ollama:qwen3:8b');
    }
  });
});

describe('getTaskModel / getTaskOverride / setTaskOverride (live per-call resolution)', () => {
  afterEach(() => {
    // Reset so later tests in this file (and other files in this run) see
    // config defaults.
    saveConfig({});
  });

  test('with no override, every task follows the chat model', () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');

    expect(getTaskModel('chat')).toBe('gpt-5.2');
    expect(getTaskModel('categorization')).toBe('gpt-5.2');
    expect(getTaskModel('entity-classification')).toBe('gpt-5.2');
    expect(getTaskOverride('categorization')).toBeNull();
    expect(getTaskOverride('entity-classification')).toBeNull();
  });

  test('a pin changes only its own task and reads back live', () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');

    expect(setTaskOverride('categorization', 'ollama:qwen3:0.6b')).toBe(true);
    expect(getTaskOverride('categorization')).toBe('ollama:qwen3:0.6b');
    expect(getTaskModel('categorization')).toBe('ollama:qwen3:0.6b');
    // The chat task and the other task still follow the chat model.
    expect(getTaskModel('chat')).toBe('gpt-5.2');
    expect(getTaskModel('entity-classification')).toBe('gpt-5.2');

    expect(setTaskOverride('entity-classification', 'transformers:HuggingFaceTB/SmolLM3-3B-ONNX')).toBe(true);
    expect(getTaskModel('entity-classification')).toBe('transformers:HuggingFaceTB/SmolLM3-3B-ONNX');
    expect(getTaskModel('categorization')).toBe('ollama:qwen3:0.6b');
  });

  test('resetting a pin restores chat-model following', () => {
    ensureTestProfile();
    saveConfig({});
    setSetting('modelId', 'gpt-5.2');
    setSetting('provider', 'openai');
    setTaskOverride('categorization', 'ollama:qwen3:0.6b');
    expect(getTaskModel('categorization')).toBe('ollama:qwen3:0.6b');

    expect(setTaskOverride('categorization', null)).toBe(true);
    expect(getTaskOverride('categorization')).toBeNull();
    expect(getTaskModel('categorization')).toBe('gpt-5.2');
  });
});

describe('validateTaskModel', () => {
  test('catalog ids are accepted', () => {
    expect(validateTaskModel('gpt-5.2')).toBe(true);
    expect(validateTaskModel('ollama:qwen3:8b')).toBe(true);
    expect(validateTaskModel('transformers:HuggingFaceTB/SmolLM3-3B-ONNX')).toBe(true);
  });

  test('prefixed-but-uncatalogued ids are accepted (installed-but-uncatalogued models)', () => {
    expect(validateTaskModel('ollama:some-installed-model')).toBe(true);
    expect(validateTaskModel('transformers:org/some-repo')).toBe(true);
    expect(validateTaskModel('openrouter:vendor/model')).toBe(true);
  });

  test('garbage is rejected', () => {
    expect(validateTaskModel('garbage-id')).toBe(false);
    expect(validateTaskModel('')).toBe(false);
    expect(validateTaskModel('   ')).toBe(false);
    expect(validateTaskModel(null)).toBe(false);
    expect(validateTaskModel(undefined)).toBe(false);
    expect(validateTaskModel(42)).toBe(false);
    expect(validateTaskModel({ id: 'gpt-5.2' })).toBe(false);
  });
});

describe('buildModelCatalog', () => {
  const rawById = new Map(
    PROVIDER_REGISTRY.flatMap((p) => p.models.map((m) => [m.id, { raw: m, providerId: p.providerId }])),
  );

  function webgpuFilterViolations(catalog: Awaited<ReturnType<typeof buildModelCatalog>>): string[] {
    const violations: string[] = [];
    for (const entry of catalog) {
      const raw = rawById.get(entry.id);
      if (!raw) continue;
      if (raw.providerId === 'transformers' && raw.raw.tags?.includes('webgpu')) {
        violations.push(entry.id);
      }
    }
    return violations;
  }

  test('webgpu=false drops every WebGPU-tagged transformers entry', async () => {
    const catalog = await buildModelCatalog(false);
    expect(catalog.length).toBeGreaterThan(0);
    expect(webgpuFilterViolations(catalog)).toEqual([]);
    // The CPU/WASM transformers entries are always offered.
    const cpu = catalog.find((m) => m.id === 'transformers:HuggingFaceTB/SmolLM3-3B-ONNX');
    expect(cpu).toBeDefined();
    expect(cpu!.downloadSize).toBe('~2.0GB');
    expect(cpu!.isLocal).toBe(true);
  });

  test('webgpu=true keeps every WebGPU-tagged transformers entry', async () => {
    const catalog = await buildModelCatalog(true);
    for (const [id, { raw, providerId }] of rawById) {
      if (providerId === 'transformers' && raw.tags?.includes('webgpu')) {
        expect(catalog.some((m) => m.id === id)).toBe(true);
      }
    }
    const webgpuEntry = catalog.find((m) => m.id === 'transformers:onnx-community/Qwen3-0.6B-ONNX');
    expect(webgpuEntry).toBeDefined();
    expect(webgpuEntry!.downloadSize).toBe('~600MB');
  });

  test('every entry carries the full shape, with provider-registry-backed isLocal and cached/downloadSize truth', async () => {
    const catalog = await buildModelCatalog(false);
    const defById = new Map(PROVIDER_DEFS.map((p) => [p.id, p]));
    for (const entry of catalog) {
      const raw = rawById.get(entry.id)!;
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.displayName).toBe('string');
      expect(entry.provider).toBe(raw.providerId);
      expect(typeof entry.providerName).toBe('string');
      expect(entry.isLocal).toBe(defById.get(raw.providerId)!.isLocal);
      expect(typeof entry.cached).toBe('boolean');
      expect(entry.downloadSize).toBe(raw.raw.downloadSize ?? null);
      // Cloud entries have nothing to download.
      if (!entry.isLocal) {
        expect(entry.cached).toBe(true);
        expect(entry.downloadSize).toBeNull();
      }
      // transformers cached mirrors the on-disk check (machine-dependent value,
      // but the wiring is pinned); ollama cached is not asserted at all — it
      // depends on a running ollama server.
      if (raw.providerId === 'transformers') {
        expect(entry.cached).toBe(isTransformersModelCached(entry.id.replace(/^transformers:/, '')));
      }
    }
  });
});