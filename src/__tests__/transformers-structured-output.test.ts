import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ensureTestProfile } from './helpers.js';

// The real plugin, captured before it is mocked: the spy below passes through
// to it for the model-backed tests and fakes it for the stubbed-pipe tests.
const real = await import('@huggingface/transformers-structured-output');
const RealProcessor = real.StructuredOutputProcessor;

let passThrough = false;
let constructorError: Error | null = null;
let warmupError: Error | null = null;
const constructed: Array<{ tokenizer: unknown; format: unknown; instance: object }> = [];
const warmedTokenizers: unknown[] = [];

class SpyProcessor {
  constructor(tokenizer: unknown, format: unknown) {
    if (constructorError) throw constructorError;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = passThrough ? new RealProcessor(tokenizer as any, format as any) : this;
    constructed.push({ tokenizer, format, instance });
    return instance;
  }
  static warmup(tokenizer: unknown) {
    warmedTokenizers.push(tokenizer);
    if (warmupError) throw warmupError;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (passThrough) RealProcessor.warmup(tokenizer as any);
  }
}

mock.module('@huggingface/transformers-structured-output', () => ({ StructuredOutputProcessor: SpyProcessor }));

const {
  TransformersAdapter,
  setPipelineForTests,
  isConstrainedDecodingActive,
  listCachedDtypes,
  checkWebGpuAvailable,
  isConstraintGenerationError,
} = await import('../model/providers/transformers.js');
const { callLlm } = await import('../model/llm.js');
const { buildCategorizationOutputSchema } = await import('../tools/categorize/categorize.js');
const { LlmValidationError } = await import('../model/structured-output.js');
const { buildCategorizationPrompt } = await import('../tools/categorize/prompt.js');
const { CATEGORIZER_SYSTEM_PROMPT } = await import('../tools/categorize/categorize.js');

/** Not in the catalog: routes to CPU, so no prompt budget applies. */
const STUB_MODEL = 'stub-org/stub-model';

const schema = z.object({
  transactions: z.array(z.object({ id: z.number(), category: z.string(), confidence: z.number().min(0).max(1) })),
});

const DEAD_END = 'The constraint reached a dead end before producing a valid output.';
const EOS_MISMATCH =
  'StructuredOutputProcessor observed the tokenizer EOS token after generation continued. Ensure the model generation config uses the same eos_token_id as the tokenizer.';

type PipeOptions = { max_new_tokens: number; do_sample: boolean; logits_processor?: unknown };

/** A text-generation pipe whose replies come from `reply` (a string, or a throw). */
function stubPipe(reply: (call: number, options: PipeOptions) => string) {
  const calls: PipeOptions[] = [];
  const pipe = Object.assign(
    async (messages: Array<{ role: string; content: string }>, options: PipeOptions) => {
      calls.push(options);
      const content = reply(calls.length, options);
      return [{ generated_text: [...messages, { role: 'assistant', content }] }];
    },
    { tokenizer: { stub: 'tokenizer' } },
  );
  return { pipe, calls };
}

const VALID = '{"transactions":[{"id":1,"category":"Groceries","confidence":0.9}]}';

beforeEach(async () => {
  passThrough = false;
  constructorError = null;
  warmupError = null;
  constructed.length = 0;
  warmedTokenizers.length = 0;
  await setPipelineForTests();
});

afterEach(async () => {
  await setPipelineForTests();
});

describe('TransformersAdapter with outputSchema (stubbed pipe)', () => {
  test('a new processor is built per call and passed as logits_processor', async () => {
    const { pipe, calls } = stubPipe(() => VALID);
    await setPipelineForTests(STUB_MODEL, pipe);
    const adapter = new TransformersAdapter();
    const opts = { model: STUB_MODEL, systemPrompt: 'SYS', userPrompt: 'go', outputSchema: schema };

    const first = await adapter.call(opts);
    const second = await adapter.call(opts);

    expect(constructed).toHaveLength(2);
    expect(constructed[0].instance).not.toBe(constructed[1].instance);
    expect(calls[0].logits_processor).toBe(constructed[0].instance);
    expect(calls[1].logits_processor).toBe(constructed[1].instance);
    expect(constructed[0].tokenizer).toBe(pipe.tokenizer);
    // Same zod schema → same JSON Schema object (the package's mask cache key).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fmt = (i: number) => constructed[i].format as any;
    expect(fmt(0).type).toBe('json_schema');
    expect(fmt(0).json_schema).toBe(fmt(1).json_schema);
    expect(fmt(0).json_schema['x-guidance']).toEqual({ whitespace_flexible: true });
    expect(first.structured).toEqual(JSON.parse(VALID));
    expect(second.structured).toEqual(JSON.parse(VALID));
  });

  test('no outputSchema → no processor', async () => {
    const { pipe, calls } = stubPipe(() => 'hello');
    await setPipelineForTests(STUB_MODEL, pipe);
    const res = await new TransformersAdapter().call({ model: STUB_MODEL, systemPrompt: 'S', userPrompt: 'u' });
    expect(res.content).toBe('hello');
    expect(constructed).toHaveLength(0);
    expect('logits_processor' in calls[0]).toBe(false);
  });

  test('an unconstrainable schema falls back to prompt-only generation and the scrape', async () => {
    constructorError = new Error('Unsupported JSON Schema keyword "not"');
    const { pipe, calls } = stubPipe(() => `Sure!\n\`\`\`json\n${VALID}\n\`\`\``);
    await setPipelineForTests(STUB_MODEL, pipe);
    const res = await new TransformersAdapter().call({
      model: STUB_MODEL,
      systemPrompt: 'S',
      userPrompt: 'u',
      outputSchema: schema,
    });
    expect('logits_processor' in calls[0]).toBe(false);
    expect(res.structured).toEqual(JSON.parse(VALID));
  });

  test('constrained output is parsed as-is; truncated JSON comes back unstructured', async () => {
    const { pipe } = stubPipe(() => '{"transactions":[{"id":1,"category":');
    await setPipelineForTests(STUB_MODEL, pipe);
    const res = await new TransformersAdapter().call({
      model: STUB_MODEL,
      systemPrompt: 'S',
      userPrompt: 'u',
      outputSchema: schema,
    });
    expect(res.structured).toBeUndefined();
    expect(res.content).toBe('{"transactions":[{"id":1,"category":');
  });

  test.each([DEAD_END, 'Token 42 does not satisfy the constraint.'])(
    'a constraint failure (%s) becomes an unvalidated response, not a throw',
    async (message) => {
      const { pipe } = stubPipe(() => {
        throw new Error(message);
      });
      await setPipelineForTests(STUB_MODEL, pipe);
      const res = await new TransformersAdapter().call({
        model: STUB_MODEL,
        systemPrompt: 'S',
        userPrompt: 'u',
        outputSchema: schema,
      });
      expect(res).toEqual({ content: '', toolCalls: [] });
    },
  );

  test('an EOS mismatch retries once without the processor and keeps the answer', async () => {
    const { pipe, calls } = stubPipe((_n, options) => {
      if (options.logits_processor) throw new Error(EOS_MISMATCH);
      return VALID;
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    const res = await new TransformersAdapter().call({
      model: STUB_MODEL,
      systemPrompt: 'S',
      userPrompt: 'u',
      outputSchema: schema,
    });
    expect(res.content).toBe(VALID);
    expect(calls.length).toBe(2);
    expect(calls[1].logits_processor).toBeUndefined();
  });

  test('an EOS-mismatch retry parses fenced, prose-wrapped JSON (it is no longer constrained)', async () => {
    const { pipe } = stubPipe((_n, options) => {
      if (options.logits_processor) throw new Error(EOS_MISMATCH);
      return 'Here you go:\n```json\n' + VALID + '\n```';
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    const res = await new TransformersAdapter().call({
      model: STUB_MODEL,
      systemPrompt: 'S',
      userPrompt: 'u',
      outputSchema: schema,
    });
    expect(res.structured).toEqual(JSON.parse(VALID));
  });

  test('after an EOS mismatch the model is remembered: no processor is built and one generation runs', async () => {
    const { pipe, calls } = stubPipe((_n, options) => {
      if (options.logits_processor) throw new Error(EOS_MISMATCH);
      return VALID;
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    const adapter = new TransformersAdapter();
    const opts = { model: STUB_MODEL, systemPrompt: 'S', userPrompt: 'u', outputSchema: schema };

    await adapter.call(opts);
    expect(constructed.length).toBe(1);
    expect(calls.length).toBe(2);

    const res = await adapter.call(opts);
    expect(constructed.length).toBe(1);
    expect(calls.length).toBe(3);
    expect(calls[2].logits_processor).toBeUndefined();
    expect(res.structured).toEqual(JSON.parse(VALID));

    // Resetting the test seam forgets the mismatch.
    await setPipelineForTests();
    await setPipelineForTests(STUB_MODEL, pipe);
    await adapter.call(opts);
    expect(constructed.length).toBe(2);
  });

  test('the same message without a processor attached still throws', async () => {
    const { pipe } = stubPipe(() => {
      throw new Error(DEAD_END);
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    await expect(
      new TransformersAdapter().call({ model: STUB_MODEL, systemPrompt: 'S', userPrompt: 'u' }),
    ).rejects.toThrow('dead end');
  });

  test('other generation errors are not swallowed', async () => {
    expect(isConstraintGenerationError(new Error('Unknown failure'))).toBe(false);
    const { pipe } = stubPipe(() => {
      throw new Error('Unknown failure');
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    await expect(
      new TransformersAdapter().call({ model: STUB_MODEL, systemPrompt: 'S', userPrompt: 'u', outputSchema: schema }),
    ).rejects.toThrow('Unknown failure');
  });
});

describe('callLlm over the constrained adapter (stubbed pipe)', () => {
  beforeEach(() => ensureTestProfile());

  test('an EOS mismatch is visible under both the prefixed and bare model id', async () => {
    const { pipe } = stubPipe((_n, options) => {
      if (options.logits_processor) throw new Error(EOS_MISMATCH);
      return VALID;
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    expect(isConstrainedDecodingActive(`transformers:${STUB_MODEL}`)).toBe(true);
    expect(isConstrainedDecodingActive(STUB_MODEL)).toBe(true);

    await callLlm('categorize', { model: `transformers:${STUB_MODEL}`, outputSchema: schema });

    expect(isConstrainedDecodingActive(`transformers:${STUB_MODEL}`)).toBe(false);
    expect(isConstrainedDecodingActive(STUB_MODEL)).toBe(false);

    // The categorizer's narrowing gate then yields the loose schema.
    const loose = buildCategorizationOutputSchema([1], ['Groceries'], isConstrainedDecodingActive(`transformers:${STUB_MODEL}`));
    expect(loose.safeParse({ transactions: [{ id: 99, category: 'Anything', confidence: 0.5 }] }).success).toBe(true);
  });

  test('a dead end runs the repair re-prompt, which can succeed', async () => {
    const { pipe, calls } = stubPipe((n) => {
      if (n === 1) throw new Error(DEAD_END);
      return VALID;
    });
    await setPipelineForTests(STUB_MODEL, pipe);
    const result = await callLlm('categorize', { model: `transformers:${STUB_MODEL}`, outputSchema: schema });
    expect(calls).toHaveLength(2);
    expect(result.response.structured).toEqual(JSON.parse(VALID));
    // The repair call is constrained too, with its own processor.
    expect(constructed).toHaveLength(2);
    expect(calls[1].logits_processor).toBe(constructed[1].instance);
  });

  test('truncation still yields LlmValidationError after exactly one repair', async () => {
    const { pipe, calls } = stubPipe(() => '{\n  "transactions":');
    await setPipelineForTests(STUB_MODEL, pipe);
    const err = await callLlm('categorize', {
      model: `transformers:${STUB_MODEL}`,
      outputSchema: schema,
      maxTokens: 5,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.max_new_tokens === 5)).toBe(true);
  });
});

describe('structured-output warmup at pipeline load', () => {
  test('runs once per loaded pipeline, not per call', async () => {
    const { pipe } = stubPipe(() => VALID);
    await setPipelineForTests(STUB_MODEL, pipe);
    expect(warmedTokenizers).toEqual([pipe.tokenizer]);
    const adapter = new TransformersAdapter();
    await adapter.call({ model: STUB_MODEL, systemPrompt: 'S', userPrompt: 'u', outputSchema: schema });
    await adapter.call({ model: STUB_MODEL, systemPrompt: 'S', userPrompt: 'u', outputSchema: schema });
    expect(warmedTokenizers).toHaveLength(1);
  });

  test('a warmup failure never breaks loading', async () => {
    warmupError = new Error('boom');
    const { pipe } = stubPipe(() => VALID);
    await setPipelineForTests(STUB_MODEL, pipe);
    const res = await new TransformersAdapter().call({
      model: STUB_MODEL,
      systemPrompt: 'S',
      userPrompt: 'u',
      outputSchema: schema,
    });
    expect(res.structured).toEqual(JSON.parse(VALID));
  });
});

// ── Model-backed: skipped unless granite-4.0-350m is cached and WebGPU runs ──

const GRANITE_REPO = 'onnx-community/granite-4.0-350m-ONNX-web';

/**
 * The test preload swaps HOME for a throwaway dir, so the adapter's model cache
 * is empty here. Link just this repo from the developer's real cache (found via
 * userInfo, which the preload leaves alone) when it is there; CI has none and
 * the block skips.
 */
function linkRealGraniteCache(): boolean {
  const realCache = join(userInfo().homedir, '.openaccountant', 'models', GRANITE_REPO);
  const testCache = join(homedir(), '.openaccountant', 'models', GRANITE_REPO);
  if (!existsSync(join(realCache, 'onnx'))) return false;
  if (!existsSync(testCache)) {
    mkdirSync(dirname(testCache), { recursive: true });
    symlinkSync(realCache, testCache, 'dir');
  }
  return true;
}

const graniteCached = linkRealGraniteCache() && (await listCachedDtypes(GRANITE_REPO)).includes('q4f16');
const canRunGranite = graniteCached && (await checkWebGpuAvailable());

const BATCHES = [
  [
    { id: 101, description: 'WHOLEFDS MKT #10234 AUSTIN TX', amount: -84.12, date: '2026-09-02' },
    { id: 102, description: 'SHELL OIL 57444', amount: -46.3, date: '2026-09-03' },
  ],
  [
    { id: 201, description: 'NETFLIX.COM', amount: -15.49, date: '2026-09-05' },
    { id: 202, description: 'ACME CORP PAYROLL DIR DEP', amount: 3120, date: '2026-09-15' },
    { id: 203, description: 'CHIPOTLE 1123', amount: -12.85, date: '2026-09-16' },
  ],
  [{ id: 301, description: 'COMCAST CABLE COMM', amount: -89.99, date: '2026-09-20' }],
];

describe.skipIf(!canRunGranite)('granite-4.0-350m constrained categorize (model-backed)', () => {
  beforeEach(() => {
    passThrough = true;
  });

  test(
    'every reply parses as JSON, passes zod and covers every row',
    async () => {
      const adapter = new TransformersAdapter();
      for (const batch of BATCHES) {
        const res = await adapter.call({
          model: GRANITE_REPO,
          systemPrompt: CATEGORIZER_SYSTEM_PROMPT,
          userPrompt: buildCategorizationPrompt(batch),
          outputSchema: schema,
          maxTokens: 64 + 40 * batch.length,
        });
        const parsed = JSON.parse(res.content);
        expect(schema.safeParse(parsed).success).toBe(true);
        expect(res.structured).toEqual(parsed);
        // A schema-valid {"transactions":[]} categorizes nothing: every row must come back.
        expect(parsed.transactions.map((t: { id: number }) => t.id)).toEqual(batch.map((t) => t.id));
      }
      expect(constructed).toHaveLength(BATCHES.length);
    },
    300_000,
  );

  test(
    'a tiny max_new_tokens still ends in LlmValidationError after one repair',
    async () => {
      ensureTestProfile();
      const err = await callLlm(buildCategorizationPrompt(BATCHES[0]), {
        model: `transformers:${GRANITE_REPO}`,
        systemPrompt: CATEGORIZER_SYSTEM_PROMPT,
        outputSchema: schema,
        // Too few tokens to close the object, on the first call and on the repair.
        maxTokens: 5,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmValidationError);
      expect(constructed).toHaveLength(2);
    },
    300_000,
  );
});
