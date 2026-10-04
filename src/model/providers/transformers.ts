/**
 * Transformers.js adapter — fully local, zero config, no API key required.
 *
 * Uses @huggingface/transformers v4, running in-process via Bun on the ONNX
 * Runtime backend that onnxruntime-node bundles (CPU, CoreML and WebGPU
 * execution providers). Models are cached to ~/.openaccountant/models/ on
 * first download.
 *
 * Device and dtype come from the model catalog (src/utils/model.ts), which pins
 * both per entry. Repos outside the catalog (user-typed ids) route by
 * LEGACY_WEBGPU_MODEL_PATTERNS and resolve their dtype from the Hub file list
 * via the shared resolver in src/model/transformers-dtype.ts — the same one the
 * browser hybrid client uses. No dtype is hardcoded: repos publish different
 * subsets (granite-4.0-micro-ONNX-web ships only q4f16).
 *
 * WebGPU models (q4f16) — require a GPU that ORT's bundled WebGPU EP can drive:
 * - onnx-community/granite-4.0-micro-ONNX-web  ~3B Micro, IBM tool-calling   ~2.3GB
 * - onnx-community/Qwen3-1.7B-ONNX             ~1.7B, Qwen3 architecture     ~1.4GB
 * - LiquidAI/LFM2.5-1.2B-Instruct-ONNX         ~1.2B, trained for tool use   ~760MB
 * - onnx-community/granite-4.0-350m-ONNX-web   ~350M, IBM Granite, fast      ~350MB
 * - onnx-community/Qwen3-0.6B-ONNX             ~0.6B, Qwen3 architecture     ~570MB
 *
 * CPU/WASM models (q4, no GPU required):
 * - HuggingFaceTB/SmolLM3-3B-ONNX         ~2.8GB, 92.3% BFCL score
 * - onnx-community/Qwen2.5-1.5B-Instruct  ~1.8GB, solid instruction following
 *
 * Tool call format: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>
 *
 * Limitations:
 * - Small models (0.5B) are far less capable than Claude/GPT for complex reasoning.
 * - First run downloads the model from HuggingFace Hub (~350MB–2.8GB).
 * - Subsequent runs load from cache (<2s startup time).
 * - Tool calling via prompt injection is unreliable — works for simple single-tool
 *   calls, fails on complex multi-tool chains.
 * - Recommended for: offline use, simple Q&A, categorization.
 * - Not recommended for: multi-tool agent tasks.
 */

import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse, ToolCall, ToolDef } from '../types.js';
import { getTransformersCatalogEntry } from '../../utils/model.js';
import { discoverSkills } from '../../skills/index.js';
import {
  corruptCacheError,
  dtypesFromFileList,
  fetchOnnxTreeSizes,
  findCacheSizeMismatches,
  isCorruptModelFileError,
  resolveTransformersDtype,
  type DtypeFetch,
  type HubRequestOptions,
  type OnnxDtype,
  type ResolvedDtype,
  type TransformersDevice,
} from '../transformers-dtype.js';

/**
 * Device routing for repos that are NOT in the model catalog (user-typed ids).
 * Catalog entries carry an explicit `device` and never consult this list.
 */
export const WEBGPU_MODEL_PATTERNS = ['-ONNX-web', 'LFM2-1.2B-Tool-ONNX', 'Qwen3-0.6B-ONNX'];

/**
 * Where `modelName` (bare repo or `transformers:`-prefixed id) runs: the
 * catalog entry's `device` when there is one, else the legacy name patterns.
 */
export function resolveTransformersDevice(modelName: string): TransformersDevice {
  const entry = getTransformersCatalogEntry(modelName);
  if (entry?.device) return entry.device;
  return WEBGPU_MODEL_PATTERNS.some((p) => modelName.includes(p)) ? 'webgpu' : 'cpu';
}

const cacheDir = join(homedir(), '.openaccountant', 'models');

interface OnnxBackend {
  deviceToExecutionProviders(device: string): unknown[];
}

/**
 * transformers.js keeps its ONNX backend out of the package `exports` map, so
 * deviceToExecutionProviders() is only reachable by file path. Resolve the
 * published entry point (which the exports map does allow) and walk back to the
 * package root, so this holds wherever node_modules ends up hoisted.
 */
async function loadOnnxBackend(): Promise<OnnxBackend> {
  const { createRequire } = await import('node:module');
  const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
  return (await import(join(dirname(entry), '..', 'src', 'backends', 'onnx.js'))) as OnnxBackend;
}

// Track whether we've initialized transformers (only once per process)
let transformersBootstrapped = false;

async function bootstrapTransformers(webgpu: boolean) {
  if (transformersBootstrapped) return;

  if (webgpu && !(await checkWebGpuAvailable())) {
    throw new Error(
      'WebGPU is not available on this machine. Select a CPU model via /model (SmolLM3 3B or Qwen 2.5 1.5B).',
    );
  }

  transformersBootstrapped = true;

  const { env } = await import('@huggingface/transformers');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (env as any).cacheDir = cacheDir;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((env as any).backends?.onnx?.wasm) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).backends.onnx.wasm.proxy = false;
  }
}

/**
 * Hugging Face token for gated/private repos: the same env vars transformers.js
 * itself sends on model downloads (HF_TOKEN, legacy HF_ACCESS_TOKEN).
 */
function hubToken(): string | undefined {
  return process.env.HF_TOKEN || process.env.HF_ACCESS_TOKEN || undefined;
}

/** Hub requests from the server: env.remoteHost, HF_TOKEN, and a short timeout. */
async function serverHubOptions(): Promise<HubRequestOptions> {
  const { env } = await import('@huggingface/transformers');
  const fetchImpl: DtypeFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { hubUrl: env.remoteHost, hubToken: hubToken(), fetchImpl };
}

/** Where transformers.js caches `repo`: <cacheDir>/<org>/<name> (FileCache keys are repo-relative paths). */
export function modelCachePath(repo: string, dir = cacheDir): string {
  return join(dir, repo.replace(/^transformers:/, ''));
}

/**
 * dtypes whose main model file (onnx/model<suffix>.onnx) is already in the
 * local cache. A plain directory listing: no network, no transformers.js
 * memoization, and in-flight `.tmp.*` downloads never match.
 */
export async function listCachedDtypes(repo: string, dir = cacheDir): Promise<OnnxDtype[]> {
  try {
    const files = await readdir(join(modelCachePath(repo, dir), 'onnx'));
    return [...dtypesFromFileList(files.map((f) => `onnx/${f}`))];
  } catch {
    return [];
  }
}

/** Bytes on disk of every cached onnx/ file (repo-relative path → size), skipping in-flight temp files. */
export async function cachedOnnxFileSizes(repo: string, dir = cacheDir): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const onnxDir = join(modelCachePath(repo, dir), 'onnx');
  let files: string[];
  try {
    files = await readdir(onnxDir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (f.includes('.tmp.')) continue;
    try {
      const st = await stat(join(onnxDir, f));
      if (st.isFile()) out.set(`onnx/${f}`, st.size);
    } catch {
      // vanished mid-listing — ignore
    }
  }
  return out;
}

/**
 * Turn a pipeline() failure into something actionable. A damaged cached file
 * (truncated download → "Deserialize tensor … out of bounds") becomes a
 * TransformersCacheError naming the repo and the folder to delete, plus — when
 * the Hub is reachable — which cached files are the wrong size. Nothing is
 * ever deleted here. Any other error is returned unchanged.
 */
export async function explainModelLoadError(
  repo: string,
  err: unknown,
  opts: { dir?: string; hub?: HubRequestOptions } = {},
): Promise<unknown> {
  if (!isCorruptModelFileError(err)) return err;
  const path = modelCachePath(repo, opts.dir);
  let mismatches: ReturnType<typeof findCacheSizeMismatches> = [];
  try {
    const [local, remote] = await Promise.all([
      cachedOnnxFileSizes(repo, opts.dir),
      fetchOnnxTreeSizes(repo, opts.hub ?? (await serverHubOptions())),
    ]);
    mismatches = findCacheSizeMismatches(local, remote);
  } catch {
    // offline or Hub error — the message still names the folder to delete
  }
  return corruptCacheError(repo, path, err, mismatches);
}

/**
 * The dtype the server loads for `modelName` on `device`: the catalog pin, or
 * (for user-typed repos) the shared Hub-file-list resolution. Offline, it walks
 * the same preference chain over what is already in ~/.openaccountant/models —
 * including for a catalog pin whose file is not cached. Throws
 * TransformersDtypeError ("no ONNX weights for <repo> in any of: …", or "repo
 * not found or gated: <repo>") when the Hub says nothing is loadable — before
 * any download.
 */
export async function resolveServerDtype(modelName: string, device: TransformersDevice): Promise<ResolvedDtype> {
  const repo = modelName.replace(/^transformers:/, '');
  const entry = getTransformersCatalogEntry(repo);
  const { dtype } = await resolveTransformersDtype(repo, device, {
    // A catalog dtype only applies on the device it was pinned for.
    catalogDtype: entry?.device === device ? entry.dtype : undefined,
    ...(await serverHubOptions()),
    localDtypes: (r) => listCachedDtypes(r),
  });
  return dtype;
}

// Singleton pipeline cache: model name → pipeline instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipelineCache = new Map<string, any>();

async function getOrCreatePipeline(modelName: string) {
  const cached = pipelineCache.get(modelName);
  if (cached) return cached;

  const device = resolveTransformersDevice(modelName);
  await bootstrapTransformers(device === 'webgpu');

  const { pipeline } = await import('@huggingface/transformers'); // module-cached after first import
  const dtype = await resolveServerDtype(modelName, device);

  // Suppress library console output during load to avoid corrupting TUI rendering
  const noop = () => {};
  const origLog = console.log;
  const origWarn = console.warn;
  const origInfo = console.info;
  console.log = noop;
  console.warn = noop;
  console.info = noop;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipe: any;
  try {
    pipe = await pipeline('text-generation', modelName, { device, dtype });
  } catch (err) {
    throw await explainModelLoadError(modelName.replace(/^transformers:/, ''), err);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.info = origInfo;
  }
  pipelineCache.set(modelName, pipe);
  return pipe;
}

/**
 * Warm the transformers pipeline for `modelName` and measure the load
 * separately from any generation call.
 *
 * On a cold machine this includes the first-run HuggingFace Hub download —
 * that is honest, and it is exactly why the Speed Showdown renders model load
 * time on its own line, never folded into the decision timer.
 */
export async function warmTransformersPipeline(
  modelName: string,
): Promise<{ loadMs: number; loadedFresh: boolean }> {
  const loadStart = Date.now();
  const loadedFresh = !pipelineCache.has(modelName);
  await getOrCreatePipeline(modelName);
  return { loadMs: Date.now() - loadStart, loadedFresh };
}

/**
 * A complete 110-byte ONNX model: one MatMul over two 1x1 float32 inputs.
 * Small enough to build a session and run it in well under a second, and it
 * forces the WebGPU execution provider to actually reach the GPU — registering
 * the EP alone succeeds even where no adapter exists.
 *
 * The bytes are a plain ModelProto (ir_version 8, opset 13) and can be
 * regenerated by any ONNX exporter.
 */
const WEBGPU_PROBE_MODEL_B64 =
  'CAgSBXByb2JlOl0KFQoBYQoBYhIBeRoCbW0iBk1hdE11bBIFcHJvYmVaEwoBYRIOCgwIARIICgIIAQoCCAFaEwoBYhIOCgwIARIICgIIAQoCCAFiEwoBeRIOCgwIARIICgIIAQoCCAFCBAoAEA0=';

let webGpuProbe: Promise<boolean> | null = null;

async function probeWebGpu(): Promise<boolean> {
  // 1. Does this build of transformers.js know the webgpu device at all? A
  //    stale or downgraded tree throws `Unsupported device` here (issue #37).
  const { deviceToExecutionProviders } = await loadOnnxBackend();
  if (!deviceToExecutionProviders('webgpu').includes('webgpu')) return false;

  // 2. Does this platform's onnxruntime-node ship the WebGPU EP? Linux arm64
  //    prebuilds, for instance, do not.
  const ort = await import('onnxruntime-node');
  if (!ort.listSupportedBackends().some((b) => b.name === 'webgpu')) return false;

  // 3. Does the GPU actually work? Build and run the tiny probe model.
  const session = await ort.InferenceSession.create(
    Buffer.from(WEBGPU_PROBE_MODEL_B64, 'base64'),
    { executionProviders: ['webgpu'], logSeverityLevel: 4 },
  );
  try {
    const one = () => new ort.Tensor('float32', Float32Array.from([1]), [1, 1]);
    const out = await session.run({ a: one(), b: one() });
    return (out.y.data as Float32Array)[0] === 1;
  } finally {
    await session.release?.();
  }
}

/**
 * Whether WebGPU-backed models can run here. Never throws; the result is cached
 * for the lifetime of the process (including the in-flight promise, so
 * concurrent callers share one probe).
 */
export async function checkWebGpuAvailable(): Promise<boolean> {
  webGpuProbe ??= probeWebGpu().catch(() => false);
  return webGpuProbe;
}

/**
 * Largest prompt (in tokens, chat template included) a WebGPU model is handed.
 * Measured with granite-4.0-micro q4f16 through onnxruntime-node's WebGPU EP:
 * 8k-token prompts ran (~22s prefill); 12k and 17k failed with ONNX Runtime's
 * opaque "Unknown failure" — after 41s and 90s of prefill. Failing fast here
 * beats a minute-long prefill that cannot succeed.
 */
export const WEBGPU_PROMPT_TOKEN_BUDGET = 8192;

/** Prompt-token ceiling for `modelName`, or null when none is enforced (CPU). */
export function localPromptBudget(modelName: string): number | null {
  return resolveTransformersDevice(modelName) === 'webgpu' ? WEBGPU_PROMPT_TOKEN_BUDGET : null;
}

/** A prompt larger than the local model's budget; raised before any inference. */
export class LocalPromptTooLargeError extends Error {
  constructor(readonly model: string, readonly promptTokens: number, readonly budget: number) {
    super(
      `Local model ${model} cannot take this ${promptTokens}-token prompt (limit ${budget} on WebGPU). ` +
        'Start a new chat, ask something narrower, or pick a cloud model in Settings.',
    );
    this.name = 'LocalPromptTooLargeError';
  }
}

export function assertWithinPromptBudget(modelName: string, promptTokens: number): void {
  const budget = localPromptBudget(modelName);
  if (budget !== null && promptTokens > budget) {
    throw new LocalPromptTooLargeError(modelName.replace(/^transformers:/, ''), promptTokens, budget);
  }
}

/**
 * ONNX Runtime reports a failed WebGPU run as just "Unknown failure". Name the
 * model, device and prompt size so the error says something actionable.
 */
export function explainGenerationError(
  modelName: string,
  device: TransformersDevice,
  promptTokens: number | null,
  err: unknown,
): Error {
  const reason = err instanceof Error ? err.message : String(err);
  const size = promptTokens !== null ? ` on a ${promptTokens}-token prompt` : '';
  const hint = device === 'webgpu' ? ' Large prompts can exceed GPU limits — try a shorter request or a cloud model.' : '';
  return new Error(`Local model ${modelName.replace(/^transformers:/, '')} failed${size} (${device}): ${reason}.${hint}`);
}

/** One tool as the local tool prompt shows it: compact JSON-Schema parameters, boilerplate stripped. */
export function compactToolSchema(t: ToolDef): { name: string; description: string; parameters: Record<string, unknown> } {
  const { $schema: _s, additionalProperties: _a, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  return { name: t.name, description: t.description, parameters };
}

/** Names listed in the "Other tools" line before it is cut short (user MCP servers can add many). */
export const TOOL_INDEX_MAX_NAMES = 60;

/**
 * System prompt plus tool schemas for prompt-injected tool calling. Compact
 * JSON with the JSON-Schema boilerplate stripped: every token counts against a
 * small local model's prompt budget (pretty-printing alone added ~45%).
 *
 * `toolIndex` names the registered tools whose schemas were left out (local
 * tool selection): they stay callable, and the executor answers a call with
 * bad arguments with the schema.
 */
export function buildToolSystemPrompt(systemPrompt: string, tools?: ToolDef[], toolIndex?: readonly string[]): string {
  if (!tools || tools.length === 0) return systemPrompt;

  const toolSchemas = tools.map(compactToolSchema);

  let indexLine = '';
  if (toolIndex && toolIndex.length > 0) {
    const shown = toolIndex.slice(0, TOOL_INDEX_MAX_NAMES).join(', ');
    const more = toolIndex.length - TOOL_INDEX_MAX_NAMES;
    indexLine = `\n\nOther tools (not shown; call by name and the schema is returned): ${shown}${more > 0 ? ` … and ${more} more (ask for them by topic)` : ''}`;
  }

  return `${systemPrompt}

You have access to tools. To call a tool, output ONLY this exact format and nothing else:
<tool_call>{"name": "TOOL_NAME", "arguments": {ARGS_JSON}}</tool_call>

Available tools:
${JSON.stringify(toolSchemas)}${indexLine}

If no tool is needed, respond normally in plain text.`;
}

/** Tool names a local model's output may call: the schemas sent plus the names-only index. */
export function callableToolNames(tools: ToolDef[], toolIndex?: readonly string[]): string[] {
  const names = tools.map((t) => t.name);
  for (const name of toolIndex ?? []) if (!names.includes(name)) names.push(name);
  return names;
}

/** Token estimate before a tokenizer is available: ~chars/3.2, within ~10% for compact JSON (measured on granite). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

/**
 * A token counter for `modelName`'s own tokenizer (plain text, no chat
 * template), for planning local prompts against the budget. Loads the same
 * pipeline the call is about to use; falls back to `estimateTokens` when the
 * pipeline cannot load (the call itself will then report why).
 */
export async function getLocalTokenCounter(modelName: string): Promise<(text: string) => number> {
  try {
    const pipe = await getOrCreatePipeline(modelName.replace(/^transformers:/, ''));
    return (text: string) => {
      try {
        return pipe.tokenizer.encode(text).length as number;
      } catch {
        return estimateTokens(text);
      }
    };
  } catch {
    return estimateTokens;
  }
}

/**
 * Prompt tokens for `messages` as the model will see them (chat template and
 * generation prompt included). Null when the tokenizer cannot say.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countPromptTokens(pipe: any, messages: Array<{ role: string; content: string }>): number | null {
  try {
    const text = pipe.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
    return pipe.tokenizer.encode(String(text)).length;
  } catch {
    return null;
  }
}

/**
 * Build the system prompt with JSON schema injection for structured output.
 */
function buildStructuredSystemPrompt(systemPrompt: string, schema: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(schema);
  return `${systemPrompt}

Respond ONLY with valid JSON matching this schema:
${JSON.stringify(jsonSchema, null, 2)}

Do not include any other text, explanation, or markdown. Output only the JSON object.`;
}

/**
 * A call that names a skill as if it were a tool (granite emitted
 * `{"name": "month-end-close"}`) becomes the `skill` tool the agent supports.
 */
function asSkillCall(name: string, args: Record<string, unknown>): ToolCall {
  const skillArgs = Object.keys(args).length > 0 ? JSON.stringify(args) : undefined;
  return {
    id: crypto.randomUUID(),
    name: 'skill',
    args: skillArgs ? { skill: name, args: skillArgs } : { skill: name },
  };
}

/**
 * `{name, arguments|args}` → ToolCall; `arguments` may itself be a JSON string.
 * A name in `skillNames` (and not a tool) becomes a `skill` call.
 */
function toToolCall(
  raw: string,
  toolNames?: readonly string[],
  skillNames?: readonly string[],
): ToolCall | null {
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; arguments?: unknown; args?: unknown };
    if (typeof parsed?.name !== 'string') return null;
    const isSkill = !!skillNames?.includes(parsed.name) && !toolNames?.includes(parsed.name);
    if (toolNames && !toolNames.includes(parsed.name) && !isSkill) return null;
    let args = parsed.arguments ?? parsed.args ?? {};
    if (typeof args === 'string') args = JSON.parse(args);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
    if (isSkill) return asSkillCall(parsed.name, args as Record<string, unknown>);
    return { id: crypto.randomUUID(), name: parsed.name, args: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * The leading balanced `{...}` of `text` (string- and escape-aware), or null.
 * Granite emits the call and then keeps writing an invented answer, so the
 * JSON is a prefix of the output, not all of it.
 */
function leadingJsonObject(text: string): string | null {
  if (!text.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

/**
 * Parse a tool call from model output: the documented
 * <tool_call>{...}</tool_call> form, or — only when it names one of
 * `toolNames` — a bare or fenced JSON object, which small models (granite-4.0-
 * micro) emit instead, often with `arguments` as a JSON string and often
 * followed by invented answer text, which is discarded.
 * Supports both 'arguments' (SmolLM3 native format) and 'args' (legacy).
 * A call naming one of `skillNames` is rewritten to `skill({ skill: name })`.
 */
export function parseToolCall(
  output: string,
  toolNames?: readonly string[],
  skillNames?: readonly string[],
): ToolCall | null {
  const tagged = output.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (tagged) return toToolCall(tagged[1], undefined, skillNames);
  if (!toolNames?.length) return null;
  const bare = leadingJsonObject(output.replace(/```(?:json)?/g, '').trim());
  return bare ? toToolCall(bare, toolNames, skillNames) : null;
}

export class TransformersAdapter implements ProviderAdapter {
  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, toolIndex, outputSchema } = options;

    let finalSystemPrompt = systemPrompt;
    if (outputSchema) {
      finalSystemPrompt = buildStructuredSystemPrompt(systemPrompt, outputSchema);
    } else if (tools && tools.length > 0) {
      finalSystemPrompt = buildToolSystemPrompt(systemPrompt, tools, toolIndex);
    }

    const messages = [
      { role: 'system', content: finalSystemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const pipe = await getOrCreatePipeline(model);

    const promptTokens = countPromptTokens(pipe, messages);
    if (promptTokens !== null) assertWithinPromptBudget(model, promptTokens);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await pipe(messages as any, {
        max_new_tokens: options.maxTokens ?? 512,
        do_sample: false,
      });
    } catch (err) {
      throw explainGenerationError(model, resolveTransformersDevice(model), promptTokens, err);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generated = (result as any)[0]?.generated_text;
    let rawOutput: string;

    if (Array.isArray(generated)) {
      // Chat template format: array of {role, content} messages
      // The last element is the assistant's response
      const last = generated[generated.length - 1];
      rawOutput = typeof last === 'object' && last?.content ? String(last.content) : String(last ?? '');
    } else {
      rawOutput = String(generated ?? '');
    }

    // Handle tool calls
    if (tools && tools.length > 0) {
      const names = callableToolNames(tools, toolIndex);
      const skillNames = names.includes('skill') ? discoverSkills().map((s) => s.name) : undefined;
      const toolCall = parseToolCall(rawOutput, names, skillNames);
      if (toolCall) {
        return { content: '', toolCalls: [toolCall] };
      }
    }

    // Handle structured output
    if (outputSchema) {
      try {
        const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? jsonMatch[0] : rawOutput.trim();
        const parsed = JSON.parse(jsonStr);
        return { content: rawOutput, toolCalls: [], structured: parsed };
      } catch {
        return { content: rawOutput, toolCalls: [] };
      }
    }

    return { content: rawOutput, toolCalls: [] };
  }
}
