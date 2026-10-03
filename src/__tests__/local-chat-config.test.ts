import { afterEach, describe, expect, test } from 'bun:test';
import { getProviderById } from '../providers.js';
import { getModelsForProvider } from '../utils/model.js';
import { getLocalChatModelConfig, LOCAL_CHAT_BUNDLE_DEFAULTS, LOCAL_SUBAGENT_DEFAULTS } from '../model/local-chat.js';
import { PRELABEL_MODEL } from '../prelabel/config.js';
import { parseToWorker } from '../dashboard/ui/src/prelabel/protocol.js';
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

  test('config carries the catalog-pinned dtype so the browser loads the right ONNX file', () => {
    const fastModel = getProviderById('transformers')!.fastModel!;
    const catalogEntry = getModelsForProvider('transformers').find((m) => m.id === fastModel)!;
    const cfg = getLocalChatModelConfig();

    // Never left to a hardcoded browser default: the reported failure was the
    // client forcing fp16 on a repo (granite-4.0-micro-ONNX-web) that only
    // publishes q4f16.
    expect(catalogEntry.device).toBe('webgpu');
    expect(catalogEntry.dtype).toBeDefined();
    expect(cfg.dtype).toBe(catalogEntry.dtype!);
    expect(cfg.dtype).toBe('q4f16');
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

describe('local chat config: browser subagent flag (spec section 11, slice 6)', () => {
  const saved = process.env.WILSON_LOCAL_SUBAGENT;
  const savedCompose = process.env.WILSON_LOCAL_SUBAGENT_COMPOSE;
  afterEach(() => {
    if (saved === undefined) delete process.env.WILSON_LOCAL_SUBAGENT;
    else process.env.WILSON_LOCAL_SUBAGENT = saved;
    if (savedCompose === undefined) delete process.env.WILSON_LOCAL_SUBAGENT_COMPOSE;
    else process.env.WILSON_LOCAL_SUBAGENT_COMPOSE = savedCompose;
  });

  test('defaults to off with maxSteps 3 and the template answer writer (Round 3)', () => {
    delete process.env.WILSON_LOCAL_SUBAGENT;
    delete process.env.WILSON_LOCAL_SUBAGENT_COMPOSE;
    expect(getLocalChatModelConfig().subagent).toEqual({ enabled: false, maxSteps: 3, compose: 'template', openJevRouter: false, openJevPins: null });
  });

  test('WILSON_LOCAL_SUBAGENT_COMPOSE=model switches to the model writer (comparison arm); only the literal "model" does', () => {
    process.env.WILSON_LOCAL_SUBAGENT_COMPOSE = 'model';
    expect(getLocalChatModelConfig().subagent.compose).toBe('model');
    for (const v of ['', 'Model', 'template', 'llm', ' model']) {
      process.env.WILSON_LOCAL_SUBAGENT_COMPOSE = v;
      expect(getLocalChatModelConfig().subagent.compose, JSON.stringify(v)).toBe('template');
    }
  });

  test('WILSON_LOCAL_SUBAGENT=1 forces it on, and only the literal "1" does', () => {
    process.env.WILSON_LOCAL_SUBAGENT = '1';
    delete process.env.WILSON_LOCAL_SUBAGENT_COMPOSE;
    expect(getLocalChatModelConfig().subagent).toEqual({ enabled: true, maxSteps: 3, compose: 'template', openJevRouter: false, openJevPins: null });
    for (const v of ['0', '', 'true', 'yes', ' 1']) {
      process.env.WILSON_LOCAL_SUBAGENT = v;
      expect(getLocalChatModelConfig().subagent.enabled, JSON.stringify(v)).toBe(false);
    }
  });

  test('the flag is independent of the model: a disabled local model stays disabled-shaped but carries the field', () => {
    delete process.env.WILSON_LOCAL_SUBAGENT;
    const cfg = getLocalChatModelConfig();
    expect(cfg.subagent).toBeDefined();
    expect(cfg.subagent.maxSteps).toBeLessThanOrEqual(4);
  });
});

describe('local chat config: open-jev router flag (Round 4, R4-6)', () => {
  const saved = process.env.WILSON_LOCAL_SUBAGENT_OPENJEV;
  afterEach(() => {
    if (saved === undefined) delete process.env.WILSON_LOCAL_SUBAGENT_OPENJEV;
    else process.env.WILSON_LOCAL_SUBAGENT_OPENJEV = saved;
  });

  test('subagent.openJevRouter defaults to false and ships no pins', () => {
    delete process.env.WILSON_LOCAL_SUBAGENT_OPENJEV;
    expect(LOCAL_SUBAGENT_DEFAULTS.openJevRouter).toBe(false);
    const sub = getLocalChatModelConfig().subagent;
    expect(sub.openJevRouter).toBe(false);
    expect(sub.openJevPins).toBeNull();
  });

  test('WILSON_LOCAL_SUBAGENT_OPENJEV=1 turns it on, and only the literal "1" does', () => {
    process.env.WILSON_LOCAL_SUBAGENT_OPENJEV = '1';
    expect(getLocalChatModelConfig().subagent.openJevRouter).toBe(true);
    for (const v of ['0', '', 'true', 'yes', ' 1']) {
      process.env.WILSON_LOCAL_SUBAGENT_OPENJEV = v;
      expect(getLocalChatModelConfig().subagent.openJevRouter, JSON.stringify(v)).toBe(false);
    }
  });

  test('the flag does not enable the subagent by itself', () => {
    process.env.WILSON_LOCAL_SUBAGENT_OPENJEV = '1';
    const savedSub = process.env.WILSON_LOCAL_SUBAGENT;
    delete process.env.WILSON_LOCAL_SUBAGENT;
    expect(getLocalChatModelConfig().subagent.enabled).toBe(false);
    if (savedSub !== undefined) process.env.WILSON_LOCAL_SUBAGENT = savedSub;
  });

  test('with the flag on the config carries the pre-labeler pins, minus the byte count, and the worker accepts them', () => {
    process.env.WILSON_LOCAL_SUBAGENT_OPENJEV = '1';
    const pins = getLocalChatModelConfig().subagent.openJevPins;
    expect(pins).not.toBeNull();
    const { approxDownloadBytes: _b, ...expected } = PRELABEL_MODEL;
    void _b;
    expect(pins).toEqual(expected as typeof pins);
    expect(Object.keys(pins as object)).not.toContain('approxDownloadBytes');
    expect(parseToWorker({ v: 1, type: 'init', pins, labelSetVersion: '', assetBase: '/assets/' })).not.toBeNull();
  });
});
