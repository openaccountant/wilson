import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { loadConfig, saveConfig, getSetting, setSetting, getConfiguredModel } from '../utils/config.js';
import { setActiveProfilePaths, resetActiveProfile, type ProfilePaths } from '../profile/index.js';

describe('utils/config', () => {
  const tmpDir = join(os.tmpdir(), `config-test-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    // Point the active profile at our temp dir
    setActiveProfilePaths({
      name: 'test',
      root: tmpDir,
      database: join(tmpDir, 'data.db'),
      settings: join(tmpDir, 'settings.json'),
      scratchpad: join(tmpDir, 'scratchpad'),
      cache: join(tmpDir, 'cache'),
    });
  });

  afterAll(() => {
    resetActiveProfile();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('loadConfig returns empty object when no file', () => {
    const config = loadConfig();
    expect(config).toEqual({});
  });

  test('saveConfig creates file and directories', () => {
    const result = saveConfig({ provider: 'openai' });
    expect(result).toBe(true);
    expect(existsSync(join(tmpDir, 'settings.json'))).toBe(true);
  });

  test('saveConfig + loadConfig roundtrip', () => {
    saveConfig({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
    const config = loadConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.modelId).toBe('claude-sonnet-4-5');
  });

  test('getSetting returns default when key missing', () => {
    // Clear any existing settings
    saveConfig({});
    expect(getSetting('nonexistent', 'fallback')).toBe('fallback');
  });

  test('setSetting persists value', () => {
    setSetting('theme', 'dark');
    expect(getSetting('theme', 'light')).toBe('dark');
  });

  test('getSetting/setSetting roundtrip', () => {
    setSetting('provider', 'openai');
    expect(getSetting('provider', '')).toBe('openai');
  });

  test('corrupt JSON returns empty config', () => {
    writeFileSync(join(tmpDir, 'settings.json'), 'not valid json{{{');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  test('model→provider migration on getSetting', () => {
    // Write config with legacy "model" key
    saveConfig({ model: 'claude-sonnet-4-5' });
    // Accessing 'provider' should trigger migration
    const provider = getSetting('provider', '');
    expect(provider).toBe('anthropic');
  });

  test('migration removes legacy model key', () => {
    saveConfig({ model: 'gpt-5.2' });
    getSetting('provider', ''); // triggers migration
    const config = loadConfig();
    expect(config.model).toBeUndefined();
    expect(config.provider).toBe('openai');
  });

  test('no migration when provider already set', () => {
    saveConfig({ provider: 'anthropic', model: 'old-model' });
    const provider = getSetting('provider', '');
    expect(provider).toBe('anthropic');
    // Legacy model key should still be there (no migration needed)
    const config = loadConfig();
    expect(config.model).toBe('old-model');
  });

  test('getConfiguredModel returns defaults when nothing configured', () => {
    saveConfig({});
    const { model, provider } = getConfiguredModel();
    expect(typeof model).toBe('string');
    expect(typeof provider).toBe('string');
  });

  test('setSetting provider removes legacy model key', () => {
    saveConfig({ model: 'old-model' });
    setSetting('provider', 'google');
    const config = loadConfig();
    expect(config.provider).toBe('google');
    expect(config.model).toBeUndefined();
  });
});
