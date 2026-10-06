/**
 * EOS compatibility check for constrained decoding. No weights are fetched.
 *
 *   bun scripts/structured-output-spike/eos-check.ts [> results/eos-check.md]
 *
 * StructuredOutputProcessor lets the *tokenizer's* eos_token_id through when the
 * JSON is complete, and transformers.js only stops on generation_config's
 * eos_token_id. If the chat template ends an assistant turn with a different
 * token (Gemma: <end_of_turn>), constrained generation can emit the wrong stop
 * token or never stop. This reports, per model, whether those line up.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getModelsForProvider } from '../../src/utils/model.js';

const EXTRA = [
  'onnx-community/gemma-4-E2B-it-ONNX',
  'nerding-io/granite-budget-parser-350m',
  'nerding-io/granite-budget-parser-1b',
];
const repos = [...new Set([...getModelsForProvider('transformers').map((m) => m.id.replace(/^transformers:/, '')), ...EXTRA])];

const token = process.env.HF_TOKEN || process.env.HF_ACCESS_TOKEN;
async function getJson(repo: string, file: string): Promise<any | { __error: string }> {
  try {
    const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { __error: `HTTP ${res.status}` };
    const text = await res.text();
    return file.endsWith('.jinja') ? text : JSON.parse(text);
  } catch (e) {
    return { __error: e instanceof Error ? e.message : String(e) };
  }
}
const bad = (x: any) => x && typeof x === 'object' && '__error' in x;

// Candidate end-of-turn tokens, most specific first.
const END_OF_TURN = ['<end_of_turn>', '<turn|>', '<|im_end|>', '<|eot_id|>', '<|end_of_text|>', '<|end|>', '<|endoftext|>', '</s>', '<eos>'];

const tokText = (t: any): string | undefined => (typeof t === 'string' ? t : t?.content);
const asList = (v: unknown): number[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v as number]);

// Does this transformers.js build map the model_type for text-generation?
const entry = createRequire(import.meta.url).resolve('@huggingface/transformers');
const registry = readFileSync(join(dirname(entry), '..', 'src', 'models', 'registry.js'), 'utf8');
const causal = registry.slice(registry.indexOf('MODEL_FOR_CAUSAL_LM_MAPPING_NAMES'));
const causalBlock = causal.slice(0, causal.indexOf(']);'));
const causalTypes = new Map([...causalBlock.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]]));
const tjsVersion = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version;

const rows: string[][] = [];
const notes: string[] = [];
for (const repo of repos) {
  const [cfg, gen, tokCfg, tokJson, jinja] = await Promise.all([
    getJson(repo, 'config.json'),
    getJson(repo, 'generation_config.json'),
    getJson(repo, 'tokenizer_config.json'),
    getJson(repo, 'tokenizer.json'),
    getJson(repo, 'chat_template.jinja'),
  ]);
  if (bad(cfg) && bad(tokCfg)) {
    rows.push([repo, `unreachable (config ${cfg.__error}, tokenizer_config ${tokCfg.__error})`, '', '', '', '', '', '']);
    continue;
  }
  const modelType: string = bad(cfg) ? '?' : cfg.model_type ?? '?';
  const eosTok = bad(tokCfg) ? undefined : tokText(tokCfg.eos_token);
  const added: any[] = bad(tokJson) ? [] : tokJson.added_tokens ?? [];
  const idOf = (c?: string) => (c === undefined ? undefined : added.find((t) => t.content === c)?.id ?? (bad(tokJson) ? undefined : tokJson.model?.vocab?.[c]));
  const eosId = idOf(eosTok);
  const genEos = bad(gen) ? [] : asList(gen.eos_token_id);
  const cfgEos = bad(cfg) ? [] : asList(cfg.eos_token_id ?? cfg.text_config?.eos_token_id);
  const effectiveGen = genEos.length ? genEos : cfgEos;
  const template: string = typeof jinja === 'string' ? jinja : bad(tokCfg) ? '' : typeof tokCfg.chat_template === 'string' ? tokCfg.chat_template : JSON.stringify(tokCfg.chat_template ?? '');
  const eot = END_OF_TURN.find((t) => template.includes(t));
  const eotAdded = eot ? added.find((t) => t.content === eot) : undefined;
  const eotId = eot ? idOf(eot) : undefined;
  const match = eosId !== undefined && effectiveGen.length ? effectiveGen.includes(eosId) : undefined;
  const eotStops = eotId !== undefined && effectiveGen.length ? effectiveGen.includes(eotId) : undefined;
  const mapped = causalTypes.get(modelType) ?? (modelType === '?' ? '?' : 'NO');
  rows.push([
    repo,
    `${modelType} -> ${mapped}`,
    `${eosTok ?? '?'} (${eosId ?? '?'})`,
    `${genEos.length ? `[${genEos.join(', ')}]` : `none (config: [${cfgEos.join(', ')}])`}`,
    match === undefined ? '?' : match ? 'yes' : 'NO',
    eot ? `${eot} (${eotId ?? '?'})` : 'none found',
    eotAdded ? (eotAdded.special ? 'yes' : 'NO (added, non-special)') : eot ? 'not in added_tokens' : '',
    eotStops === undefined ? '?' : eotStops ? 'yes' : 'NO',
  ]);
  if (bad(cfg) || bad(gen)) {
    notes.push(`- ${repo}: config.json ${bad(cfg) ? cfg.__error : 'ok'}, generation_config.json ${bad(gen) ? gen.__error : 'ok'} at repo root. Not a plain ONNX repo (safetensors/trl output), so generation eos and architecture are unverified; check after conversion.`);
  }
  // Gemma-style: model ends turns with a token other than the tokenizer eos. Constraint masks it out.
  if (eotId !== undefined && eosId !== undefined && eotId !== eosId && effectiveGen.includes(eotId)) {
    notes.push(`- ${repo}: native end-of-turn ${eot} (${eotId}) differs from tokenizer eos ${eosTok} (${eosId}). Both stop generation, but the processor only unmasks the tokenizer eos once the JSON is complete, so the model must emit ${eosTok} instead of its trained ${eot}. Verify it actually terminates (and does not trail whitespace) in the gate stage.`);
  }
  if (match === false || eotStops === false) {
    notes.push(`- ${repo}: tokenizer eos ${eosTok} (${eosId}) vs generation eos [${effectiveGen.join(', ')}]; end-of-turn ${eot} (${eotId}). ${match === false ? 'Processor will allow tokenizer EOS, which generation will not treat as a stop. ' : ''}${eotStops === false ? 'Model\'s own end-of-turn token does not stop generation.' : ''}`);
  }
}

const out: string[] = [
  '# EOS / stop-token check',
  '',
  `Generated by scripts/structured-output-spike/eos-check.ts on ${new Date().toISOString().slice(0, 10)}. Only config/tokenizer/generation_config/chat template files fetched; no weights.`,
  '',
  `transformers.js ${tjsVersion} text-generation (MODEL_FOR_CAUSAL_LM) architectures including gemma: ${[...causalTypes.entries()].filter(([k]) => /gemma/.test(k)).map(([k, v]) => `${k} -> ${v}`).join(', ')}`,
  `gemma4 supported for text-generation: ${causalTypes.has('gemma4') ? 'YES (gemma4 -> ' + causalTypes.get('gemma4') + ')' : 'NO'}`,
  '',
  '| repo | model_type -> class | tokenizer eos (id) | generation eos_token_id | tokenizer eos in generation eos | chat-template end-of-turn (id) | end-of-turn special | end-of-turn stops generation |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.join(' | ')} |`),
  '',
  '## Mismatches',
  '',
  ...(notes.length ? notes : ['none']),
  '',
];
console.log(out.join('\n'));
