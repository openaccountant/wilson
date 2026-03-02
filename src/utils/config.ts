import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';
import { getDefaultModelForProvider } from './model.js';
import { getActiveProfile } from '../profile/active.js';

function getSettingsPath(): string {
  return getActiveProfile().settings;
}

// Map legacy model IDs to provider IDs for migration
const MODEL_TO_PROVIDER_MAP: Record<string, string> = {
  'gpt-5.2': 'openai',
  'claude-sonnet-4-5': 'anthropic',
  'gemini-3': 'google',
};

interface Config {
  provider?: string;
  modelId?: string;  // Selected model ID (e.g., "gpt-5.2", "ollama:llama3.1")
  model?: string;    // Legacy key, kept for migration
  [key: string]: unknown;
}

export function loadConfig(): Config {
  if (!existsSync(getSettingsPath())) {
    return {};
  }

  try {
    const content = readFileSync(getSettingsPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): boolean {
  try {
    const dir = dirname(getSettingsPath());
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(getSettingsPath(), JSON.stringify(config, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrates legacy `model` setting to `provider` setting.
 * Called once on config load to ensure backwards compatibility.
 */
function migrateModelToProvider(config: Config): Config {
  // If already has provider, no migration needed
  if (config.provider) {
    return config;
  }

  // If has legacy model setting, convert to provider
  if (config.model) {
    const providerId = MODEL_TO_PROVIDER_MAP[config.model];
    if (providerId) {
      config.provider = providerId;
      delete config.model;
      // Save the migrated config
      saveConfig(config);
    }
  }

  return config;
}

export function getSetting<T>(key: string, defaultValue: T): T {
  let config = loadConfig();

  // Run migration if accessing provider setting
  if (key === 'provider') {
    config = migrateModelToProvider(config);
  }

  return (config[key] as T) ?? defaultValue;
}

/**
 * Returns the user's configured model and provider from settings.
 * Falls back to defaults if nothing is configured.
 */
export function getConfiguredModel(): { model: string; provider: string } {
  const provider = getSetting('provider', DEFAULT_PROVIDER);
  const savedModel = getSetting('modelId', null) as string | null;
  const model = savedModel ?? getDefaultModelForProvider(provider) ?? DEFAULT_MODEL;
  return { model, provider };
}

export function setSetting(key: string, value: unknown): boolean {
  const config = loadConfig();
  config[key] = value;

  // If setting provider, remove legacy model key
  if (key === 'provider' && config.model) {
    delete config.model;
  }

  return saveConfig(config);
}
