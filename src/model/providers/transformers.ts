/**
 * Transformers.js adapter — fully local, zero config, no API key required.
 *
 * Uses @huggingface/transformers v3 WASM/WebGPU backend running in-process via Bun.
 * Models are cached to ~/.openaccountant/models/ on first download.
 *
 * WebGPU models — require bun-webgpu (bun add bun-webgpu) + compatible GPU:
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

import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ProviderAdapter, ProviderCallOptions, LlmResponse, ToolCall, ToolDef } from '../types.js';

const WEBGPU_MODEL_PATTERNS = ['-ONNX-web', 'LFM2-1.2B-Tool-ONNX', 'Qwen3-0.6B-ONNX'];
const cacheDir = join(homedir(), '.openaccountant', 'models');

// Track whether we've initialized transformers (only once per process)
let transformersBootstrapped = false;

async function bootstrapTransformers(webgpu: boolean) {
  if (transformersBootstrapped) return;

  if (webgpu) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { setupGlobals } = await import('bun-webgpu' as any);
      setupGlobals(); // patches navigator.gpu before transformers.js is loaded
      // Verify the polyfill actually set up navigator.gpu
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (globalThis as any).navigator?.gpu === 'undefined') {
        throw new Error('navigator.gpu not available after polyfill install');
      }
    } catch {
      throw new Error(
        'WebGPU is not available on this machine. Select a CPU model via /model (SmolLM3 3B or Qwen 2.5 1.5B).',
      );
    }
  }

  transformersBootstrapped = true;

  // Import AFTER polyfill so IS_WEBGPU_AVAILABLE evaluates correctly
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

let webGpuAvailable: boolean | null = null;

export async function checkWebGpuAvailable(): Promise<boolean> {
  if (webGpuAvailable !== null) return webGpuAvailable;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { setupGlobals } = await import('bun-webgpu' as any);
    setupGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = await (navigator as any).gpu.requestAdapter();
    webGpuAvailable = adapter !== null;
  } catch {
    webGpuAvailable = false;
  }
  return webGpuAvailable;
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
      max_new_tokens: 512,
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
