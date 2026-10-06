/**
 * Offline routing eval for local tool selection (design 2026-10-03 §8).
 *
 * Runs the real selector (src/agent/tool-selection.ts) with real MiniLM card
 * embeddings and the real granite tokenizer over a labeled question set, and
 * reports subset recall ("any": at least one acceptable tool selected;
 * "strict": every needed tool selected), reachable recall (selected ∪
 * names-only index) and schema tokens. Also scores the keyword-only fallback.
 *
 * Needs the cached models and never downloads (allowRemoteModels = false).
 * Run with a throwaway HOME whose .openaccountant/models links to the cache,
 * so no real profile, skill or MCP config is read:
 *
 *   mkdir -p /tmp/oa-eval/.openaccountant
 *   ln -s ~/.openaccountant/models /tmp/oa-eval/.openaccountant/models
 *   HOME=/tmp/oa-eval bun scripts/eval-tool-selection.ts [specs/eval/tool-selection.dev.jsonl]
 *
 * Pre-registered bar (§8): held-out subset recall (any) ≥ 90% and reachable
 * recall = 100%. Tune only on the dev set; a held-out run burns the set.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'transformers:onnx-community/granite-4.0-micro-ONNX-web';
const SET = process.argv[2] ?? join(import.meta.dir, '..', 'specs', 'eval', 'tool-selection.dev.jsonl');

// web_search registers only with a search key; it is never called here.
process.env.EXASEARCH_API_KEY ??= 'eval-only-never-called';

const { env, AutoTokenizer } = await import('@huggingface/transformers');
env.allowRemoteModels = false;
env.cacheDir = join(homedir(), '.openaccountant', 'models');

const { getToolRegistry } = await import('../src/tools/registry.js');
const { discoverSkills } = await import('../src/skills/index.js');
const { selectTools } = await import('../src/agent/tool-selection.js');
const { getCardEmbedder, skillCardText, toolCardText, toolSchemaTokens } = await import('../src/agent/tool-cards.js');
const { estimateTokens } = await import('../src/model/providers/transformers.js');

let countTokens: (text: string) => number = estimateTokens;
try {
  const tok = await AutoTokenizer.from_pretrained(MODEL.replace(/^transformers:/, ''));
  countTokens = (text) => tok.encode(text).length;
} catch {
  console.warn('granite tokenizer not cached: schema tokens are chars/3.2 estimates');
}

interface Row {
  q: string;
  tools: string[];
  origin?: string;
}
const rows: Row[] = readFileSync(SET, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const registry = await getToolRegistry(MODEL);
const names = new Set(registry.map((t) => t.name));
const candidates = registry.map((entry) => ({
  name: entry.name,
  card: toolCardText(entry),
  schemaTokens: toolSchemaTokens(entry.tool, countTokens),
}));
const skills = discoverSkills().map((s) => ({ name: s.name, card: skillCardText(s) }));
const embed = getCardEmbedder();

type Arm = 'hybrid' | 'keywords';
interface Score {
  n: number;
  any: number;
  strict: number;
  reachable: number;
  tokens: number[];
  tools: number[];
  misses: string[];
}
const scores = new Map<string, Score>();
const bucket = (key: string) => {
  let s = scores.get(key);
  if (!s) scores.set(key, (s = { n: 0, any: 0, strict: 0, reachable: 0, tokens: [], tools: [], misses: [] }));
  return s;
};

const started = performance.now();
for (const arm of ['hybrid', 'keywords'] as Arm[]) {
  for (const row of rows) {
    const gold = row.tools.filter((t) => names.has(t));
    if (gold.length === 0) continue; // e.g. monarch_import without a Pro license: no selector can include it
    const sel = await selectTools({ query: row.q, tools: candidates, skills, embed: arm === 'hybrid' ? embed : null });
    const shown = new Set(sel.tools);
    const reachable = new Set([...sel.tools, ...sel.indexed]);
    for (const key of [`${arm} all`, `${arm} ${row.origin ?? 'unlabeled'}`]) {
      const s = bucket(key);
      s.n++;
      if (gold.some((t) => shown.has(t))) s.any++;
      else s.misses.push(`${row.q} -> wanted ${gold.join('|')}, got ${sel.tools.join(',')}`);
      if (gold.every((t) => shown.has(t))) s.strict++;
      if (gold.every((t) => reachable.has(t))) s.reachable++;
      s.tokens.push(sel.tokens.tools);
      s.tools.push(sel.tools.length);
    }
  }
}

const pct = (a: number, n: number) => `${a}/${n} (${((100 * a) / n).toFixed(1)}%)`;
const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(`set: ${SET}  registry: ${registry.length} tools, ${skills.length} skills  (${Math.round(performance.now() - started)} ms)`);
for (const [key, s] of [...scores.entries()].sort()) {
  console.log(
    JSON.stringify({
      arm: key,
      any: pct(s.any, s.n),
      strict: pct(s.strict, s.n),
      reachable: pct(s.reachable, s.n),
      avgSchemaTokens: avg(s.tokens),
      maxSchemaTokens: Math.max(...s.tokens),
      avgTools: +(s.tools.reduce((a, b) => a + b, 0) / s.tools.length).toFixed(1),
      misses: s.misses,
    }),
  );
}
