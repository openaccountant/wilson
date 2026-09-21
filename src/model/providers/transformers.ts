/**
 * Transformers.js adapter — fully local, zero config, no API key required.
 *
 * Uses @huggingface/transformers v4, running in-process via Bun on the ONNX
 * Runtime backend that onnxruntime-node bundles (CPU, CoreML and WebGPU
 * execution providers). Models are cached to ~/.openaccountant/models/ on
 * first download.
 *
 * WebGPU models — require a GPU that ORT's bundled WebGPU EP can drive:
 * - onnx-community/granite-4.0-micro-ONNX-web  ~3B Micro, IBM tool-calling
 * - onnx-community/LFM2-1.2B-Tool-ONNX         ~1.2B, purpose-built for tool use
 * - onnx-community/granite-4.0-350m-ONNX-web   ~350M, IBM Granite, fast
 * - onnx-community/Qwen3-0.6B-ONNX             ~0.6B, Qwen3 architecture
 *
 * CPU/WASM models (default, no GPU required):
 * - HuggingFaceTB/SmolLM3-3B-ONNX         ~2GB, 92.3% BFCL score
 * - onnx-community/Qwen2.5-1.5B-Instruct  ~900MB, solid instruction following
 *
 * Tool call format: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>
 *
 * Limitations:
 * - Small models (0.5B) are far less capable than Claude/GPT for complex reasoning.
 * - First run downloads the model from HuggingFace Hub (~270MB–500MB).
 * - Subsequent runs load from cache (<2s startup time).
 * - Tool calling via prompt injection is unreliable — works for simple single-tool
 *   calls, fails on complex multi-tool chains.
 * - Recommended for: offline use, simple Q&A, categorization.
 * - Not recommended for: multi-tool agent tasks.
 */

import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse, ToolCall, ToolDef } from '../types.js';

export const WEBGPU_MODEL_PATTERNS = ['-ONNX-web', 'LFM2-1.2B-Tool-ONNX', 'Qwen3-0.6B-ONNX'];
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

// Singleton pipeline cache: model name → pipeline instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pipelineCache = new Map<string, any>();

async function getOrCreatePipeline(modelName: string) {
  const cached = pipelineCache.get(modelName);
  if (cached) return cached;

  const isWebGpu = WEBGPU_MODEL_PATTERNS.some((p) => modelName.includes(p));
  await bootstrapTransformers(isWebGpu);

  const { pipeline } = await import('@huggingface/transformers'); // module-cached after first import
  const device = isWebGpu ? 'webgpu' : 'cpu';
  const dtype = isWebGpu ? 'fp16' : 'q4';

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
 * Build the system prompt with tool injection when tools are provided.
 */
function buildSystemPrompt(systemPrompt: string, tools?: ToolDef[]): string {
  if (!tools || tools.length === 0) return systemPrompt;

  const toolSchemas = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema),
  }));

  return `${systemPrompt}

You have access to tools. To call a tool, output ONLY this exact format and nothing else:
<tool_call>{"name": "TOOL_NAME", "arguments": {ARGS_JSON}}</tool_call>

Available tools:
${JSON.stringify(toolSchemas, null, 2)}

If no tool is needed, respond normally in plain text.`;
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
 * Parse a tool call from model output.
 * Returns parsed ToolCall if found, null otherwise.
 */
function parseToolCall(output: string): ToolCall | null {
  const match = output.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!match) return null;

  try {
    // Support both 'arguments' (SmolLM3 native format) and 'args' (legacy)
    const parsed = JSON.parse(match[1]) as { name: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
    return {
      id: crypto.randomUUID(),
      name: parsed.name,
      args: parsed.arguments ?? parsed.args ?? {},
    };
  } catch {
    return null;
  }
}

export class TransformersAdapter implements ProviderAdapter {
  async call(options: ProviderCallOptions): Promise<LlmResponse> {
    const { model, systemPrompt, userPrompt, tools, outputSchema } = options;

    let finalSystemPrompt = systemPrompt;
    if (outputSchema) {
      finalSystemPrompt = buildStructuredSystemPrompt(systemPrompt, outputSchema);
    } else if (tools && tools.length > 0) {
      finalSystemPrompt = buildSystemPrompt(systemPrompt, tools);
    }

    const messages = [
      { role: 'system', content: finalSystemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const pipe = await getOrCreatePipeline(model);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await pipe(messages as any, {
      max_new_tokens: options.maxTokens ?? 512,
      do_sample: false,
    });

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
      const toolCall = parseToolCall(rawOutput);
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
