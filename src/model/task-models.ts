import { resolveProvider, PROVIDERS as PROVIDER_DEFS } from '../providers.js';
import { getModelDisplayName, isTransformersModelCached, PROVIDERS as PROVIDER_REGISTRY } from '../utils/model.js';
import { getConfiguredModel, getSetting, setSetting } from '../utils/config.js';
import { getOllamaModels } from '../utils/ollama.js';

/**
 * Which model handles which AI task the product runs, and whether it runs on
 * this device or a cloud server. Backs the dashboard Settings "Models" panel
 * (GET /api/models, POST /api/models) — one row per task, demo-legible at a
 * glance, plus the model catalog the admin pins from.
 */

export type TaskKey = 'chat' | 'categorization' | 'entity-classification' | 'embeddings';

export type TaskExecution = 'local' | 'server';

// Shared with the tool call sites so history tags and panel task keys stay
// aligned: these are the `callType` values passed to callLlm, which land in
// llm_interactions and drive the Training tab's per-task filter.
export const CALL_TYPE_CATEGORIZATION = 'categorization';
export const CALL_TYPE_ENTITY_CLASSIFICATION = 'entity-classification';

/** Tasks an admin can pin a specific model to (the chat task is the global setting itself). */
export type OverridableTask = 'categorization' | 'entity-classification';

/**
 * Flat settings keys stored next to `modelId` in the profile's settings.json.
 * `getSetting` re-reads the file on every call, so resolution at the task call
 * sites (getTaskModel) is live by construction — a pin lands on the very next
 * run with no restart. Do not add a cache layer here.
 */
const OVERRIDE_SETTINGS_KEYS: Record<OverridableTask, string> = {
  categorization: 'modelOverride.categorization',
  'entity-classification': 'modelOverride.entity-classification',
};

/** Raw pinned id from settings, or null when the task follows the chat model. */
export function getTaskOverride(task: OverridableTask): string | null {
  const value = getSetting<string | null>(OVERRIDE_SETTINGS_KEYS[task], null);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Persist a pin (model id) or clear it (null = reset to follow chat model). */
export function setTaskOverride(task: OverridableTask, model: string | null): boolean {
  return setSetting(OVERRIDE_SETTINGS_KEYS[task], model);
}

/**
 * Effective model for a task: pinned override when set, else the chat model.
 * Reads settings from disk on every call → resolution at call time is live.
 */
export function getTaskModel(task: 'chat' | OverridableTask): string {
  if (task === 'chat') return getConfiguredModel().model;
  return getTaskOverride(task) ?? getConfiguredModel().model;
}

/**
 * Guard for the write route: non-empty string AND (present in the model
 * catalog OR prefixed with a known provider's modelPrefix). The prefix arm
 * lets an admin pin an installed-but-uncatalogued model (e.g. an ollama model
 * pulled after this catalog was written) — the same freedom the TUI's ollama
 * picker has. Rejects '' / garbage / non-strings.
 */
export function validateTaskModel(model: unknown): model is string {
  if (typeof model !== 'string' || model.trim() === '') return false;
  const inCatalog = PROVIDER_REGISTRY.some((provider) =>
    provider.models.some((entry) => entry.id === model),
  );
  if (inCatalog) return true;
  return PROVIDER_DEFS.some((p) => p.modelPrefix && model.startsWith(p.modelPrefix));
}

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
  /** Derived from ProviderDef.isLocal (local = Ollama/Transformers); null when !inUse. */
  execution: TaskExecution | null;
  /** Machine capability from the cached server-side probe — same value on every row. */
  webgpu: boolean;
  /** 'default' = follows the chat model; 'override' = task-specific pin. */
  assignment: 'default' | 'override';
  /** Plain-language note (e.g. why the row is not in use); null otherwise. */
  note: string | null;
}

/**
 * One task's model assignment, optionally pinned away from the chat model.
 * Null/absent entries mean "follows the chat model".
 */
export interface TaskOverrides {
  categorization?: string | null;
  'entity-classification'?: string | null;
}

interface ModelDescriptor {
  model: string;
  modelName: string;
  provider: string;
  providerName: string;
  execution: TaskExecution;
}

function describeModel(modelId: string): ModelDescriptor {
  const provider = resolveProvider(modelId);
  return {
    model: modelId,
    modelName: getModelDisplayName(modelId),
    provider: provider.id,
    providerName: provider.displayName,
    execution: provider.isLocal ? 'local' : 'server',
  };
}

/**
 * Pure builder: four task rows for the given chat model.
 *
 * The chat row always carries the chat model with `assignment: 'default'` —
 * its control IS the global model setting, so there is no override concept
 * for it. Tool rows follow the chat model unless a pinned override is passed
 * in (null/absent = follows chat model); the row then resolves its model,
 * friendly name, provider, and execution from the pinned id and reports
 * `assignment: 'override'`.
 *
 * Embeddings is the not-in-use row in this build: the local embedding engine
 * exists as a CLI maintenance command (`wilson --index`), but no product AI
 * task consumes embeddings yet. A future embeddings task flips `inUse`
 * server-side and lights this row up without redesign.
 */
export function buildModelTaskRows(
  configuredModel: string,
  webgpu: boolean,
  overrides?: TaskOverrides,
): ModelTaskRow[] {
  const chat = describeModel(configuredModel);

  const inUseRow = (
    task: Exclude<TaskKey, 'embeddings'>,
    label: string,
    pinned?: string | null,
  ): ModelTaskRow => {
    const resolved =
      typeof pinned === 'string' && pinned.length > 0 ? describeModel(pinned) : chat;
    return {
      task,
      label,
      inUse: true,
      model: resolved.model,
      modelName: resolved.modelName,
      provider: resolved.provider,
      providerName: resolved.providerName,
      execution: resolved.execution,
      webgpu,
      assignment: resolved === chat ? 'default' : 'override',
      note: null,
    };
  };

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
    inUseRow('categorization', 'Categorization', overrides?.categorization),
    inUseRow('entity-classification', 'Entity classification', overrides?.['entity-classification']),
    notInUseRow('embeddings', 'Embeddings', 'No embeddings task in this build'),
  ];
}

// ── Model catalog (what an admin can pin from) ──────────────────────────────

export interface CatalogModel {
  id: string;
  displayName: string;
  provider: string;
  providerName: string;
  isLocal: boolean;
  /** Local only: already downloaded. Cloud entries are always true (nothing to download). */
  cached: boolean;
  /** Approximate first-run download size from the catalog; null when unknown. */
  downloadSize: string | null;
}

/**
 * The model catalog an admin pins from, with per-model truth attached:
 *
 * - WebGPU-filtered: transformers entries tagged 'webgpu' are dropped when the
 *   probe says this machine can't drive them (same filter the TUI's provider
 *   picker applies). CPU/WASM transformers entries are always offered.
 * - `cached`: transformers entries check the on-disk cache; ollama entries
 *   check the running ollama server (unreachable → uncached, truthful — those
 *   entries carry no downloadSize so nothing misleading is shown); cloud
 *   entries are always cached.
 */
export async function buildModelCatalog(webgpu: boolean): Promise<CatalogModel[]> {
  const providerDefById = new Map(PROVIDER_DEFS.map((p) => [p.id, p]));
  const installedOllama = new Set(await getOllamaModels());

  const catalog: CatalogModel[] = [];
  for (const provider of PROVIDER_REGISTRY) {
    const def = providerDefById.get(provider.providerId);
    for (const model of provider.models) {
      if (provider.providerId === 'transformers' && model.tags?.includes('webgpu') && !webgpu) {
        continue;
      }

      let cached: boolean;
      if (provider.providerId === 'transformers') {
        cached = isTransformersModelCached(model.id.replace(/^transformers:/, ''));
      } else if (provider.providerId === 'ollama') {
        cached = installedOllama.has(model.id.replace(/^ollama:/, ''));
      } else {
        cached = true;
      }

      catalog.push({
        id: model.id,
        displayName: model.displayName,
        provider: provider.providerId,
        providerName: provider.displayName,
        isLocal: def?.isLocal ?? false,
        cached,
        downloadSize: model.downloadSize ?? null,
      });
    }
  }
  return catalog;
}

export interface ModelsPanel {
  tasks: ModelTaskRow[];
  catalog: CatalogModel[];
}

/**
 * Async entry point for the endpoint: the task rows (with live per-task
 * overrides) plus the model catalog to pin from.
 *
 * The transformers module is reached by DYNAMIC import on purpose — it pulls
 * onnxruntime-node + @huggingface/transformers, which must stay out of the
 * dashboard server's startup graph until the first /api/models hit. The probe
 * is process-cached (and never throws), so repeated calls are free.
 */
export async function getModelPanel(webgpuOverride?: boolean): Promise<ModelsPanel> {
  const webgpu =
    webgpuOverride ?? (await (await import('./providers/transformers.js')).checkWebGpuAvailable());
  const [tasks, catalog] = await Promise.all([
    buildModelTaskRows(getConfiguredModel().model, webgpu, {
      categorization: getTaskOverride('categorization'),
      'entity-classification': getTaskOverride('entity-classification'),
    }),
    buildModelCatalog(webgpu),
  ]);
  return { tasks, catalog };
}