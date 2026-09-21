import { resolveProvider } from '../providers.js';
import { getModelDisplayName } from '../utils/model.js';
import { getConfiguredModel } from '../utils/config.js';

/**
 * Which model handles which AI task the product runs, and whether it runs on
 * this device or a cloud server. Backs the dashboard Settings "Models" panel
 * (GET /api/models) — one row per task, demo-legible at a glance.
 */

export type TaskKey = 'chat' | 'categorization' | 'entity-classification' | 'embeddings';

export type TaskExecution = 'local' | 'server';

// Shared with the tool call sites so history tags and panel task keys stay
// aligned: these are the `callType` values passed to callLlm, which land in
// llm_interactions and drive the Training tab's per-task filter.
export const CALL_TYPE_CATEGORIZATION = 'categorization';
export const CALL_TYPE_ENTITY_CLASSIFICATION = 'entity-classification';

export interface ModelTaskRow {
  /** Stable task key — consumers must branch on `inUse`, not on this. */
  task: TaskKey;
  /** Human label: 'Chat' | 'Categorization' | 'Entity classification' | 'Embeddings'. */
  label: string;
  /** False only for tasks with no product consumer in this build (embeddings). */
  inUse: boolean;
  /** Model id in effect (e.g. 'ollama:qwen3:8b'); null when !inUse. */
  model: string | null;
  /** Friendly display name (e.g. 'Qwen3 8B'); null when !inUse. */
  modelName: string | null;
  /** Provider id from resolveProvider; null when !inUse. */
  provider: string | null;
  /** Provider display name; null when !inUse. */
  providerName: string | null;
  /** Derived from ProviderDef.isLocal (local = Ollama/Transformers/OpenAI-compatible); null when !inUse. */
  execution: TaskExecution | null;
  /** Machine capability from the cached server-side probe — same value on every row. */
  webgpu: boolean;
  /** 'default' = follows the chat model; 'override' = task-specific assignment. */
  assignment: 'default' | 'override';
  /** Plain-language note (e.g. why the row is not in use); null otherwise. */
  note: string | null;
}

/**
 * Pure builder: four task rows for the given model id.
 *
 * Chat, categorization, and entity classification all follow the chat model
 * today (they all read the same getConfiguredModel() call) — that honesty is
 * carried in the `assignment: 'default'` field, and the override slice will
 * pass per-task models into this builder instead of special-casing here.
 *
 * Embeddings is the not-in-use row in this build: the local embedding engine
 * exists as a CLI maintenance command (`wilson --index`), but no product AI
 * task consumes embeddings yet. A future embeddings task flips `inUse`
 * server-side and lights this row up without redesign.
 */
export function buildModelTaskRows(configuredModel: string, webgpu: boolean): ModelTaskRow[] {
  const provider = resolveProvider(configuredModel);
  const modelName = getModelDisplayName(configuredModel);
  const execution: TaskExecution = provider.isLocal ? 'local' : 'server';

  const inUseRow = (task: Exclude<TaskKey, 'embeddings'>, label: string): ModelTaskRow => ({
    task,
    label,
    inUse: true,
    model: configuredModel,
    modelName,
    provider: provider.id,
    providerName: provider.displayName,
    execution,
    webgpu,
    assignment: 'default',
    note: null,
  });

  const notInUseRow = (task: TaskKey, label: string, note: string): ModelTaskRow => ({
    task,
    label,
    inUse: false,
    model: null,
    modelName: null,
    provider: null,
    providerName: null,
    execution: null,
    webgpu,
    assignment: 'default',
    note,
  });

  return [
    inUseRow('chat', 'Chat'),
    inUseRow('categorization', 'Categorization'),
    inUseRow('entity-classification', 'Entity classification'),
    notInUseRow('embeddings', 'Embeddings', 'No embeddings task in this build'),
  ];
}

/**
 * Async entry point for the endpoint: reads the configured chat model and
 * probes WebGPU server-side.
 *
 * The transformers module is reached by DYNAMIC import on purpose — it pulls
 * onnxruntime-node + @huggingface/transformers, which must stay out of the
 * dashboard server's startup graph until the first /api/models hit. The probe
 * is process-cached (and never throws), so repeated calls are free.
 */
export async function getModelTaskRows(webgpuOverride?: boolean): Promise<ModelTaskRow[]> {
  const webgpu =
    webgpuOverride ?? (await (await import('./providers/transformers.js')).checkWebGpuAvailable());
  return buildModelTaskRows(getConfiguredModel().model, webgpu);
}