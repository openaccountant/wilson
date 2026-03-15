import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSetting, setSetting } from '../utils/config.js';
import {
  checkApiKeyExistsForProvider,
  getProviderDisplayName,
  saveApiKeyForProvider,
} from '../utils/env.js';
import {
  getDefaultModelForProvider,
  getModelsForProvider,
  type Model,
  type ModelTag,
} from '../utils/model.js';
import { getOllamaModels } from '../utils/ollama.js';
import { checkWebGpuAvailable } from '../model/providers/transformers.js';

/** Returns true if the model has already been downloaded to the local cache. */
function isTransformersModelCached(modelId: string): boolean {
  // modelId format: "HuggingFaceTB/SmolLM3-3B-ONNX"
  // transformers.js cache: ~/.openaccountant/models/models--{org}--{name}/
  const cacheName = `models--${modelId.replace('/', '--')}`;
  return existsSync(join(homedir(), '.openaccountant', 'models', cacheName));
}
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';

function tagOllamaModel(id: string): ModelTag[] {
  const tags: ModelTag[] = ['open', 'local'];
  const lower = id.toLowerCase();
  // Size heuristics from model naming conventions (covers 0.5b–4b, 350m, 270m, tiny, mini, nano)
  if (/\b(0\.5b|0\.6b|1b|1\.5b|1\.7b|2b|3b|3\.8b|4b|350m|270m|135m)\b/.test(lower)) tags.push('small');
  if (/\b(tiny|mini|nano|micro)\b/.test(lower)) tags.push('small');
  if (/\b(70b|72b|405b|235b|480b)\b/.test(lower)) tags.push('large');
  if (/reason|think|r1|qwq/.test(lower)) tags.push('reasoning');
  return tags;
}

const SELECTION_STATES = [
  'provider_select',
  'model_select',
  'model_input',
  'download_confirm',
  'api_key_confirm',
  'api_key_input',
] as const;

export type SelectionState = (typeof SELECTION_STATES)[number];
export type AppState = 'idle' | SelectionState;

export interface ModelSelectionState {
  appState: AppState;
  pendingProvider: string | null;
  pendingModels: Model[];
  pendingDownloadSize: string | null;
}

type ChangeListener = () => void;

export class ModelSelectionController {
  private providerValue: string;
  private modelValue: string;
  private appStateValue: AppState = 'idle';
  private pendingProviderValue: string | null = null;
  private pendingModelsValue: Model[] = [];
  private pendingSelectedModelId: string | null = null;
  private pendingDownloadSizeValue: string | null = null;
  private readonly onError: (message: string) => void;
  private readonly onChange?: ChangeListener;
  private readonly chatHistory = new InMemoryChatHistory(DEFAULT_MODEL);

  constructor(onError: (message: string) => void, onChange?: ChangeListener) {
    this.onError = onError;
    this.onChange = onChange;
    this.providerValue = getSetting('provider', DEFAULT_PROVIDER);
    const savedModel = getSetting('modelId', null) as string | null;
    this.modelValue =
      savedModel ?? getDefaultModelForProvider(this.providerValue) ?? DEFAULT_MODEL;
    this.chatHistory.setModel(this.modelValue);
  }

  get state(): ModelSelectionState {
    return {
      appState: this.appStateValue,
      pendingProvider: this.pendingProviderValue,
      pendingModels: this.pendingModelsValue,
      pendingDownloadSize: this.pendingDownloadSizeValue,
    };
  }

  get provider(): string {
    return this.providerValue;
  }

  get model(): string {
    return this.modelValue;
  }

  get inMemoryChatHistory(): InMemoryChatHistory {
    return this.chatHistory;
  }

  isInSelectionFlow(): boolean {
    return this.appStateValue !== 'idle';
  }

  startSelection() {
    this.appStateValue = 'provider_select';
    this.emitChange();
  }

  cancelSelection() {
    this.resetPendingState();
  }

  async handleProviderSelect(providerId: string | null) {
    if (!providerId) {
      this.appStateValue = 'idle';
      this.emitChange();
      return;
    }

    this.pendingProviderValue = providerId;
    if (providerId === 'openrouter') {
      this.pendingModelsValue = [];
      this.appStateValue = 'model_input';
      this.emitChange();
      return;
    }

    if (providerId === 'ollama') {
      const ollamaModelIds = await getOllamaModels();
      this.pendingModelsValue = ollamaModelIds.map((id) => ({ id, displayName: id, tags: tagOllamaModel(id) }));
      this.appStateValue = 'model_select';
      this.emitChange();
      return;
    }

    if (providerId === 'transformers') {
      const webGpuOk = await checkWebGpuAvailable();
      this.pendingModelsValue = getModelsForProvider('transformers').filter((m) =>
        webGpuOk ? true : !m.tags?.includes('webgpu'),
      );
      this.appStateValue = 'model_select';
      this.emitChange();
      return;
    }

    this.pendingModelsValue = getModelsForProvider(providerId);
    this.appStateValue = 'model_select';
    this.emitChange();
  }

  handleModelSelect(modelId: string | null) {
    if (!modelId || !this.pendingProviderValue) {
      this.pendingProviderValue = null;
      this.pendingModelsValue = [];
      this.pendingSelectedModelId = null;
      this.appStateValue = 'provider_select';
      this.emitChange();
      return;
    }

    if (this.pendingProviderValue === 'ollama') {
      this.completeModelSwitch(this.pendingProviderValue, `ollama:${modelId}`);
      return;
    }

    if (this.pendingProviderValue === 'transformers') {
      const bareId = modelId.replace(/^transformers:/, '');
      if (!isTransformersModelCached(bareId)) {
        const model = this.pendingModelsValue.find((m) => m.id === modelId);
        this.pendingSelectedModelId = modelId;
        this.pendingDownloadSizeValue = model?.downloadSize ?? null;
        this.appStateValue = 'download_confirm';
        this.emitChange();
        return;
      }
      this.completeModelSwitch(this.pendingProviderValue, modelId);
      return;
    }

    if (checkApiKeyExistsForProvider(this.pendingProviderValue)) {
      this.completeModelSwitch(this.pendingProviderValue, modelId);
      return;
    }

    this.pendingSelectedModelId = modelId;
    this.appStateValue = 'api_key_confirm';
    this.emitChange();
  }

  handleModelInputSubmit(modelName: string | null) {
    if (!modelName || !this.pendingProviderValue) {
      this.pendingProviderValue = null;
      this.pendingModelsValue = [];
      this.pendingSelectedModelId = null;
      this.appStateValue = 'provider_select';
      this.emitChange();
      return;
    }

    const fullModelId = `${this.pendingProviderValue}:${modelName}`;
    if (checkApiKeyExistsForProvider(this.pendingProviderValue)) {
      this.completeModelSwitch(this.pendingProviderValue, fullModelId);
      return;
    }

    this.pendingSelectedModelId = fullModelId;
    this.appStateValue = 'api_key_confirm';
    this.emitChange();
  }

  handleDownloadConfirm(proceed: boolean) {
    if (proceed && this.pendingProviderValue && this.pendingSelectedModelId) {
      this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      return;
    }
    this.pendingSelectedModelId = null;
    this.pendingDownloadSizeValue = null;
    this.appStateValue = 'model_select';
    this.emitChange();
  }

  handleApiKeyConfirm(wantsToSet: boolean) {
    if (wantsToSet) {
      this.appStateValue = 'api_key_input';
      this.emitChange();
      return;
    }

    if (
      this.pendingProviderValue &&
      this.pendingSelectedModelId &&
      checkApiKeyExistsForProvider(this.pendingProviderValue)
    ) {
      this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      return;
    }

    this.onError(
      `Cannot use ${
        this.pendingProviderValue ? getProviderDisplayName(this.pendingProviderValue) : 'provider'
      } without an API key.`,
    );
    this.resetPendingState();
  }

  handleApiKeySubmit(apiKey: string | null) {
    if (!this.pendingSelectedModelId) {
      this.onError('No model selected.');
      this.resetPendingState();
      return;
    }

    if (apiKey && this.pendingProviderValue) {
      const saved = saveApiKeyForProvider(this.pendingProviderValue, apiKey);
      if (saved) {
        this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      } else {
        this.onError('Failed to save API key.');
        this.resetPendingState();
      }
      return;
    }

    if (
      !apiKey &&
      this.pendingProviderValue &&
      checkApiKeyExistsForProvider(this.pendingProviderValue)
    ) {
      this.completeModelSwitch(this.pendingProviderValue, this.pendingSelectedModelId);
      return;
    }

    this.onError('API key not set. Provider unchanged.');
    this.resetPendingState();
  }

  private completeModelSwitch(newProvider: string, newModelId: string) {
    this.providerValue = newProvider;
    this.modelValue = newModelId;
    setSetting('provider', newProvider);
    setSetting('modelId', newModelId);
    this.chatHistory.setModel(newModelId);
    this.pendingProviderValue = null;
    this.pendingModelsValue = [];
    this.pendingSelectedModelId = null;
    this.appStateValue = 'idle';
    this.emitChange();
  }

  private resetPendingState() {
    this.pendingProviderValue = null;
    this.pendingModelsValue = [];
    this.pendingSelectedModelId = null;
    this.pendingDownloadSizeValue = null;
    this.appStateValue = 'idle';
    this.emitChange();
  }

  private emitChange() {
    this.onChange?.();
  }
}
