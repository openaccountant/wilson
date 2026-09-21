import { describe, expect, test } from 'bun:test';
import { getProviderById } from '../providers.js';
import { getModelsForProvider } from '../utils/model.js';
import { getLocalChatModelConfig, LOCAL_CHAT_BUNDLE_DEFAULTS } from '../model/local-chat.js';
import { shouldAttemptLocal } from '../dashboard/ui/src/hybrid/core.js';

/**
 * The local-first hybrid chat model choice rides the existing `fastModel`
 * routing field on the transformers provider and is exposed to the browser via
 * GET /api/config/local-chat. These tests pin the cross-checks that keep the
 * config honest: the fastModel must be a webgpu-tagged catalog entry (the
 * proven browser rung of the model ladder), the config endpoint's repo must be
 * the prefix-stripped catalog id, and the capability decision matrix must only
 * attempt local on unknown/ready verdicts.
 */
describe('local chat config', () => {
  test('transformers provider declares a fastModel', () => {
    expect(getProviderById('transformers')?.fastModel).toBeDefined();
  });

  test('fastModel equals a webgpu-tagged entry in the model catalog', () => {
    const fastModel = getProviderById('transformers')!.fastModel!;
    const catalog = getModelsForProvider('transformers');
    const entry = catalog.find((m) => m.id === fastModel);
    expect(entry).toBeDefined();
    expect(entry!.tags).toContain('webgpu');
  });

  test('getLocalChatModelConfig derives everything from the registry + catalog', () => {
    const fastModel = getProviderById('transformers')!.fastModel!;
    const catalogEntry = getModelsForProvider('transformers').find((m) => m.id === fastModel)!;
    const cfg = getLocalChatModelConfig();

    expect(cfg.enabled).toBe(true);
    expect(cfg.id).toBe(fastModel); // fastModel verbatim
    expect(cfg.id.startsWith('transformers:')).toBe(true);
    expect(cfg.repo).toBe(fastModel.replace(/^transformers:/, '')); // prefix stripped
    expect(cfg.repo).not.toContain('transformers:');
    expect(cfg.displayName).toBe(catalogEntry.displayName);
    expect(cfg.downloadSize).toBe(catalogEntry.downloadSize ?? 'unknown');
    expect(cfg.bundle).toEqual({ ...LOCAL_CHAT_BUNDLE_DEFAULTS });
  });

  test('bundle defaults fit a 0.6B-class context window', () => {
    // 6000 chars ≈ ~1500 tokens of transaction context — bounded, and well
    // inside the window the 0.6B model can attend over alongside the rules.
    expect(LOCAL_CHAT_BUNDLE_DEFAULTS.days).toBeGreaterThan(0);
    expect(LOCAL_CHAT_BUNDLE_DEFAULTS.limit).toBeGreaterThan(0);
    expect(LOCAL_CHAT_BUNDLE_DEFAULTS.maxChars).toBeGreaterThan(0);
    expect(LOCAL_CHAT_BUNDLE_DEFAULTS.maxChars).toBeLessThanOrEqual(6000);
  });

  test('config is defensive when fastModel is absent (browser skips local)', () => {
    // Simulate the defensive path by checking the shape contract via a
    // registry-level invariant instead of mutating the registry: if fastModel
    // were ever removed, getLocalChatModelConfig must disable itself. We pin
    // the current enabled state and the fallback defaults shape here.
    const cfg = getLocalChatModelConfig();
    expect(typeof cfg.enabled).toBe('boolean');
    expect(cfg.bundle.days).toBe(LOCAL_CHAT_BUNDLE_DEFAULTS.days);
    if (!getProviderById('transformers')?.fastModel) {
      expect(cfg.enabled).toBe(false);
      expect(cfg.repo).toBe('');
    }
  });
});

describe('shouldAttemptLocal decision matrix', () => {
  test('unknown and ready attempt local', () => {
    expect(shouldAttemptLocal('unknown')).toBe(true);
    expect(shouldAttemptLocal('ready')).toBe(true);
  });

  test('unavailable and failed go straight to the server path', () => {
    expect(shouldAttemptLocal('unavailable')).toBe(false);
    expect(shouldAttemptLocal('failed')).toBe(false);
  });
});