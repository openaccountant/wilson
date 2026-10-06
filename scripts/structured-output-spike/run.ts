/**
 * P0 spike: prompt-only vs grammar-constrained categorize on a local model.
 *
 *   bun scripts/structured-output-spike/run.ts --model onnx-community/granite-4.0-350m-ONNX-web --limit 3
 *   flags: --model <repo> --limit <n> --device cpu|webgpu --dtype q4|q4f16|... --max-batches-tokens <n>
 *
 * Drives pipeline() directly (independent of the TransformersAdapter) with the
 * production categorize prompt, so it measures the technique, not the wiring.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { z } from 'zod';
import { buildCategorizationPrompt } from '../../src/tools/categorize/prompt.js';
import { CATEGORIZER_SYSTEM_PROMPT } from '../../src/tools/categorize/categorize.js';
import * as categorizeModule from '../../src/tools/categorize/categorize.js';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const model = arg('model');
if (!model) {
  console.error('usage: run.ts --model <hf repo> [--limit n] [--device cpu|webgpu] [--dtype q4f16]');
  process.exit(1);
}
const limit = Number(arg('limit', '50'));
const device = arg('device', 'cpu') as string;
const dtype = arg('dtype', 'q4f16') as string;

// The production schema is module-private; prefer it if categorize.ts exports it, else mirror it.
const categorizationOutputSchema: z.ZodType =
  (categorizeModule as Record<string, unknown>).categorizationOutputSchema as z.ZodType ??
  z.object({
    transactions: z.array(z.object({ id: z.number(), category: z.string(), confidence: z.number().min(0).max(1) })),
  });

/** Strip what StructuredOutputProcessor rejects or ignores: $schema, pattern, format. */
function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'pattern' || k === 'format') continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return node;
}
const jsonSchema = sanitize(z.toJSONSchema(categorizationOutputSchema)) as Record<string, unknown>;

// Mirrors the adapter's buildStructuredSystemPrompt wrapper (not exported there).
const systemPrompt = `${CATEGORIZER_SYSTEM_PROMPT}

Respond ONLY with valid JSON matching this schema:
${JSON.stringify(z.toJSONSchema(categorizationOutputSchema), null, 2)}

Do not include any other text, explanation, or markdown. Output only the JSON object.`;

interface Fixture { batches: Array<{ id: string; transactions: Array<{ id: number; description: string; amount: number; date: string; expected: string | null }> }> }
const fixture: Fixture = JSON.parse(readFileSync(join(here, '..', '..', 'src', '__tests__', 'fixtures', 'structured-output', 'categorize-batches.json'), 'utf8'));
const batches = fixture.batches.slice(0, limit);

const { pipeline, env } = await import('@huggingface/transformers');
const { StructuredOutputProcessor } = await import('@huggingface/transformers-structured-output');
(env as any).cacheDir = join(homedir(), '.openaccountant', 'models');

const loadStart = Date.now();
const pipe: any = await pipeline('text-generation', model, { device: device as any, dtype: dtype as any });
const loadMs = Date.now() - loadStart;
const warmStart = Date.now();
StructuredOutputProcessor.warmup(pipe.tokenizer);
const warmupMs = Date.now() - warmStart;

type Mode = 'prompt-only' | 'constrained';
interface Stat { mode: Mode; batches: number; rows: number; parseOk: number; zodOk: number; scored: number; correct: number; errors: number; ms: number; tokens: number }
const stats: Record<Mode, Stat> = {
  'prompt-only': { mode: 'prompt-only', batches: 0, rows: 0, parseOk: 0, zodOk: 0, scored: 0, correct: 0, errors: 0, ms: 0, tokens: 0 },
  constrained: { mode: 'constrained', batches: 0, rows: 0, parseOk: 0, zodOk: 0, scored: 0, correct: 0, errors: 0, ms: 0, tokens: 0 },
};
const perBatch: unknown[] = [];

for (const b of batches) {
  const prompt = buildCategorizationPrompt(b.transactions.map(({ id, description, amount, date }) => ({ id, description, amount, date })));
  const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];
  const maxTokens = 64 + 40 * b.transactions.length; // same budget formula as production categorize
  for (const mode of ['prompt-only', 'constrained'] as Mode[]) {
    const s = stats[mode];
    s.batches++;
    s.rows += b.transactions.length;
    const opts: Record<string, unknown> = { max_new_tokens: maxTokens, do_sample: false };
    // Processors are single-use per generate, so build a fresh one every call.
    if (mode === 'constrained') opts.logits_processor = new StructuredOutputProcessor(pipe.tokenizer, { type: 'json_schema', json_schema: jsonSchema as any });
    const t0 = Date.now();
    let raw = '';
    let error: string | undefined;
    try {
      const res = await pipe(messages as any, opts);
      const g = res[0]?.generated_text;
      raw = Array.isArray(g) ? String(g[g.length - 1]?.content ?? '') : String(g ?? '');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      s.errors++;
    }
    const ms = Date.now() - t0;
    const tokens = raw ? pipe.tokenizer.encode(raw).length : 0;
    s.ms += ms;
    s.tokens += tokens;

    let parsed: unknown;
    let parseOk = false;
    try { parsed = JSON.parse(raw); parseOk = true; } catch { /* counts as parse failure */ }
    // Prompt-only output is routinely wrapped in prose/fences; production extracts the {...} span, so score that too.
    let extractedOk = false;
    if (!parseOk) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); extractedOk = true; } catch { /* still invalid */ }
    }
    if (parseOk) s.parseOk++;
    const z1 = parseOk || extractedOk ? categorizationOutputSchema.safeParse(parsed) : undefined;
    if (z1?.success && parseOk) s.zodOk++;
    let correct = 0, scored = 0;
    if (z1?.success) {
      const byId = new Map((z1.data as any).transactions.map((t: any) => [t.id, t.category]));
      for (const t of b.transactions) {
        if (!t.expected) continue;
        scored++;
        if (byId.get(t.id) === t.expected) correct++;
      }
    } else {
      scored = b.transactions.filter((t) => t.expected).length; // unparseable batch scores zero correct
    }
    s.scored += scored;
    s.correct += correct;
    perBatch.push({ batch: b.id, mode, ms, tokens, parseOk, extractedOk, zodOk: !!z1?.success, correct, scored, error, raw: raw.slice(0, 2000) });
    console.log(`${b.id} ${mode.padEnd(11)} ${ms}ms ${tokens}tok parse=${parseOk} zod=${!!z1?.success} acc=${correct}/${scored}${error ? ` ERR ${error}` : ''}`);
  }
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const summary = Object.values(stats).map((s) => ({
  ...s,
  parseRate: s.parseOk / (s.batches || 1),
  zodRate: s.zodOk / (s.batches || 1),
  accuracy: s.scored ? s.correct / s.scored : null,
  tokensPerSec: s.ms ? (s.tokens / s.ms) * 1000 : 0,
}));

const slug = model.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-|-$/g, '');
const resultsDir = join(here, 'results');
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, `${slug}.json`), JSON.stringify({ model, device, dtype, limit, loadMs, warmupMs, summary, perBatch }, null, 2) + '\n');
const md = [
  `# Structured output spike: ${model}`,
  '',
  `device=${device} dtype=${dtype} batches=${batches.length} load=${loadMs}ms warmup=${warmupMs}ms`,
  '',
  '| mode | batches | JSON.parse | zod pass | category accuracy | errors | wall time | tokens/sec |',
  '|---|---|---|---|---|---|---|---|',
  ...summary.map((s) => `| ${s.mode} | ${s.batches} | ${pct(s.parseOk, s.batches)} | ${pct(s.zodOk, s.batches)} | ${pct(s.correct, s.scored)} (${s.correct}/${s.scored}) | ${s.errors} | ${(s.ms / 1000).toFixed(1)}s | ${s.tokensPerSec.toFixed(1)} |`),
  '',
  'Accuracy scores only rows with an `expected` label; an unparseable or schema-invalid batch counts all its labeled rows as wrong. JSON.parse is on the raw output (no extraction); zod pass requires raw JSON.parse success.',
  '',
].join('\n');
writeFileSync(join(resultsDir, `${slug}.md`), md);
console.log('\n' + md);
