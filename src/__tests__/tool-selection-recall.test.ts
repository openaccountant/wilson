import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeEmbedder } from './fake-embedder.js';
import { getToolRegistry } from '../tools/registry.js';
import { discoverSkills } from '../skills/index.js';
import { selectTools, type ToolCandidate } from '../agent/tool-selection.js';
import { skillCardText, toolCardText, toolSchemaTokens } from '../agent/tool-cards.js';
import { estimateTokens } from '../model/providers/transformers.js';

// Fixed question set (design 2026-10-03 §2.3: 50 dev + 30 fresh queries).
// Real-MiniLM recall is measured by scripts/eval-tool-selection.ts (needs the
// cached model); in CI this guards what holds without a model: every needed
// tool stays reachable, packing stays in budget, and the keyword fallback
// does not regress below its frozen numbers.
const SET = join(import.meta.dir, '..', '..', 'specs', 'eval', 'tool-selection.dev.jsonl');
const rows: Array<{ q: string; tools: string[]; origin: string }> = readFileSync(SET, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const MODEL = 'transformers:onnx-community/granite-4.0-micro-ONNX-web';
let candidates: ToolCandidate[] = [];
let skills: Array<{ name: string; card: string }> = [];
const savedKey = process.env.EXASEARCH_API_KEY;

beforeAll(async () => {
  // Register web_search (it is never called).
  process.env.EXASEARCH_API_KEY = 'test-only';
  const registry = await getToolRegistry(MODEL);
  candidates = registry.map((entry) => ({
    name: entry.name,
    card: toolCardText(entry),
    schemaTokens: toolSchemaTokens(entry.tool, estimateTokens),
  }));
  skills = discoverSkills().map((s) => ({ name: s.name, card: skillCardText(s) }));
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.EXASEARCH_API_KEY;
  else process.env.EXASEARCH_API_KEY = savedKey;
});

function scorable() {
  const names = new Set(candidates.map((c) => c.name));
  return rows
    .map((r) => ({ ...r, gold: r.tools.filter((t) => names.has(t)) }))
    .filter((r) => r.gold.length > 0);
}

describe('tool selection recall on the fixed question set', () => {
  test('the set is the doc’s 80 queries', () => {
    expect(rows).toHaveLength(80);
    expect(rows.filter((r) => r.origin === 'doc-fresh')).toHaveLength(30);
  });

  test('every needed tool is reachable (selected or indexed) for every query', async () => {
    const embed = createFakeEmbedder().embed;
    for (const row of scorable()) {
      const sel = await selectTools({ query: row.q, tools: candidates, skills, embed });
      const reachable = new Set([...sel.tools, ...sel.indexed]);
      for (const t of row.gold) expect(reachable.has(t)).toBe(true);
      expect(sel.tokens.tools).toBeLessThanOrEqual(1500);
    }
  });

  test('keyword fallback recall (any) does not regress: dev 49/49, fresh 18/30', async () => {
    const hits: Record<string, number> = {};
    for (const row of scorable()) {
      const sel = await selectTools({ query: row.q, tools: candidates, skills, embed: null });
      if (row.gold.some((t) => sel.tools.includes(t))) hits[row.origin] = (hits[row.origin] ?? 0) + 1;
    }
    expect(hits['doc-dev']).toBeGreaterThanOrEqual(49);
    expect(hits['doc-fresh']).toBeGreaterThanOrEqual(18);
  });
});
