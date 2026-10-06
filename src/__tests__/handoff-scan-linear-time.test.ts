/**
 * Permanent adversarial timing harness for the handoff scan surface.
 *
 * Every public entry point that reads a recorded prompt (judge view, dashboard flags, export checks, replay) is run
 * against a catalogue of hostile prompt shapes at MAX_CHAT_QUERY_CHARS and at SCAN_MAX_PROMPT_CHARS. Each case must
 * (a) stay under a generous absolute bound and (b) be linear: time(2N) / time(N) < 3 (best of 3 after a warm-up).
 * A quadratic path (an unbounded indexOf per anchor, ICU canonical reordering of long combining-mark runs, ...) fails
 * here long before it reaches a user.
 *
 * Env: HANDOFF_TIMING_TABLE=1 prints the timings table; HANDOFF_TIMING_SCALE=0.1 shrinks every size (only for
 * measuring an old, slow checkout without waiting an hour; the absolute bound keeps a 150 ms floor).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { TAGGED, TEST_STATE } from './handoff-test-utils.js';
import {
  HANDOFF_BLOCK_END_PREFIX,
  HANDOFF_BLOCK_HEADER_PREFIX,
  MENTION_BLOCK_PREFIX,
  SCAN_MAX_CANDIDATES,
  SCAN_MAX_PROMPT_CHARS,
  removeVerifiedHandoffBlocks,
} from '../dashboard/local-handoff-format.js';
import { analyzeHandoff, excerptHandoffBlocks, isHandoffFlagged, looksLikeHandoffMarker, neutralizeBrackets } from '../training/handoff-block.js';
import { detectorFor, ensureHandoffSecret } from '../training/handoff-tag.js';
import { foldCompat, maskPii, sanitizeUntrustedText, stripMarks } from '../mcp/text-hygiene.js';
import { FOLD_CLOSE_BRACKET_CPS, FOLD_OPEN_BRACKET_CPS, UNICODE_FOLD_VERSION } from '../mcp/unicode-fold-table.js';
import { getInteractionRead } from '../mcp/judge-reads.js';
import { MAX_CHAT_QUERY_CHARS } from '../dashboard/api.js';
import { CURRENT_MESSAGE_MARKER } from '../utils/history-context.js';

const SCALE = Number(process.env.HANDOFF_TIMING_SCALE ?? '1') || 1;
const PRINT = process.env.HANDOFF_TIMING_TABLE === '1';
/**
 * Absolute bound at 2M chars; smaller sizes get a proportional share with a floor. Shared CI runners are slower and
 * noisier than a dev machine, so CI gets more headroom; the quadratic cases this guards against took seconds to hours.
 */
const ON_CI = !!process.env.CI;
const BOUND_AT_MAX_MS = ON_CI ? 1500 : 250;
/** HANDOFF_TIMING_SHAPES=<regexp> runs only the matching shapes (to measure one without the slow ones). */
const ONLY = process.env.HANDOFF_TIMING_SHAPES ? new RegExp(process.env.HANDOFF_TIMING_SHAPES, 'i') : null;
/** time(2N) / time(N): linear is ~2, quadratic ~4. */
const RATIO_LIMIT = ON_CI ? 3.6 : 3;
/** Below this, timer noise dominates a ratio: compare against the floor instead. */
const RATIO_FLOOR_MS = ON_CI ? 60 : 25;

const TAG = '0123456789abcdef';
const CM = CURRENT_MESSAGE_MARKER;

function fit(unit: string, n: number): string {
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}
/**
 * Every code point that is not itself a mark but whose NFKD starts with a mark (halfwidth voiced marks U+FF9E / U+FF9F
 * are category Lm yet NFKC to U+3099 / U+309A, ccc 8; Thai/Lao SARA AM U+0E33 / U+0EB3, Arabic and Greek compatibility forms ...): the generic
 * family the U+FF9E bypass of the stream-safe pre-pass belongs to. Computed here, in a test, with the built-in normaliser
 * (the source guard only covers shipped source).
 */
const MARK_STARTING_CPS: string[] = (() => {
  const out: string[] = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (!/^\p{M}$/u.test(ch) && /^\p{M}/u.test(ch.normalize('NFKD'))) out.push(ch);
  }
  return out;
})();
const fakePair = `${HANDOFF_BLOCK_HEADER_PREFIX} k=${TAG}]\nx\n${HANDOFF_BLOCK_END_PREFIX} k=${TAG}]\n\n`;

const SHAPES: Record<string, (n: number) => string> = {
  'U+FDFA expansion': (n) => 'ﷺ'.repeat(n),
  'alternating combining marks': (n) => fit('á̖', n),
  'combining marks on one base': (n) => `a${fit('̖́', n - 1)}`,
  // U+FF9E / U+FF9F are category Lm (not \p{M}) but NFKC to U+3099 / U+309A (ccc 8): defeated the stream-safe pre-pass.
  'alternating halfwidth voiced marks': (n) => `a${fit('\uFF9E\u0301', n - 1)}`, // ONE base: a starter per unit would end every run
  'halfwidth marks, voiced/semi-voiced mix': (n) => `a${fit('\uFF9E\u0301\uFF9F\u0316', n - 1)}`,
  'U+0E33 / U+0EB3 runs': (n) => `a${fit('\u0E33\u0EB3', n - 1)}`,
  'U+0E33 / U+0EB3 alternated with marks': (n) => `a${fit('\u0E33\u0301\u0EB3\u0316', n - 1)}`,
  'every code point whose NFKD starts with a mark + U+0301': (n) => `a${fit(MARK_STARTING_CPS.map((c) => `${c}\u0301`).join(''), n - 1)}`,
  'fake same-tag pairs, far ends': (n) => {
    const k = SCAN_MAX_CANDIDATES + 20;
    const head = `${HANDOFF_BLOCK_HEADER_PREFIX} k=${TAG}]\nx\n`.repeat(k);
    const tail = `\n${HANDOFF_BLOCK_END_PREFIX} k=${TAG}]`.repeat(k);
    return head + 'y'.repeat(Math.max(0, n - head.length - tail.length)) + tail;
  },
  'exhausted scan, then 20k mention anchors': (n) => {
    const head = fakePair.repeat(SCAN_MAX_CANDIDATES + 20);
    const unit = `${CM}\n${MENTION_BLOCK_PREFIX}\nQuery: ${MENTION_BLOCK_PREFIX}\n`;
    const reps = Math.min(20_000, Math.floor((n - head.length) / unit.length));
    const body = unit.repeat(Math.max(0, reps));
    return head + body + 'z'.repeat(Math.max(0, n - head.length - body.length));
  },
  '20k+ marker anchors, malformed headers': (n) => fit(`${CM}\n${HANDOFF_BLOCK_HEADER_PREFIX} k=zz]\n`, n),
  '20k+ Query anchors, headers with no end': (n) => fit(`Query: ${HANDOFF_BLOCK_HEADER_PREFIX} k=${TAG}]\n`, n),
  'bare header and end prefixes': (n) => fit(`${HANDOFF_BLOCK_HEADER_PREFIX}${HANDOFF_BLOCK_END_PREFIX}`, n),
  'deep bracket look-alikes': (n) => '[【〔［'.repeat(Math.ceil(n / 8)).slice(0, n >> 1) + ']】〕］'.repeat(Math.ceil(n / 8)).slice(0, n - (n >> 1)),
  'many lines, no blank line': (n) => fit('a line of ordinary words\n', n),
};

const ENTRY_POINTS: Record<string, (text: string, ctx: Ctx) => unknown> = {
  excerptHandoffBlocks: (t) => excerptHandoffBlocks(t, TAGGED),
  analyzeHandoff: (t) => analyzeHandoff(t, TAGGED),
  removeVerifiedHandoffBlocks: (t) => removeVerifiedHandoffBlocks(t, TAGGED),
  'isHandoffFlagged (row detector)': (t) => isHandoffFlagged(t, detectorFor(TEST_STATE, '2026-10-01 00:00:00')),
  neutralizeBrackets: (t) => neutralizeBrackets(t),
  looksLikeHandoffMarker: (t) => looksLikeHandoffMarker(t),
  sanitizeUntrustedText: (t) => sanitizeUntrustedText(t, 500),
  'sanitizeUntrustedText (huge max)': (t) => sanitizeUntrustedText(t, SCAN_MAX_PROMPT_CHARS),
  maskPii: (t) => maskPii(t.length > 400_000 ? t.slice(0, 400_000) : t),
  'getInteractionRead (stored row)': (t, ctx) => getInteractionRead(ctx.db, { id: ctx.rowFor(t), section: 'user_prompt' }, 100_000),
};

interface Ctx { db: Database; rowFor: (text: string) => number }

const makeCtx = (): Ctx => {
  const db = createTestDb();
  db.prepare("INSERT INTO dashboard_config (key, value) VALUES ('handoff_tag_since', '2000-01-01 00:00:00')").run();
  ensureHandoffSecret(db);
  const ids = new Map<string, number>();
  return {
    db,
    rowFor(text) {
      const known = ids.get(text);
      if (known) return known;
      const r = db.prepare(
        `INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, response_content, status, created_at)
         VALUES ('timing', 1, 'agent', 'gpt-4', 'openai', @p, 'ok', 'ok', datetime('now'))`,
      ).run({ p: text }) as { lastInsertRowid: number };
      ids.set(text, Number(r.lastInsertRowid));
      return Number(r.lastInsertRowid);
    },
  };
};

function bestOf3(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** The (small, large) pairs: the chat-query cap and the scan cap, each against its half. */
const PAIRS: Array<[number, number]> = [
  [Math.floor((MAX_CHAT_QUERY_CHARS * SCALE) / 2), Math.floor(MAX_CHAT_QUERY_CHARS * SCALE)],
  [Math.floor((SCAN_MAX_PROMPT_CHARS * SCALE) / 2), Math.floor(SCAN_MAX_PROMPT_CHARS * SCALE)],
];

const table: Array<{ shape: string; entry: string; size: number; ms: number }> = [];
const ctx = makeCtx();

afterAll(() => {
  if (!PRINT) return;
  const lines = ['shape | entry point | chars | ms', ...table.map((r) => `${r.shape} | ${r.entry} | ${r.size} | ${r.ms.toFixed(1)}`)];
  console.log(`\nHANDOFF TIMING TABLE\n${lines.join('\n')}`);
});

describe('handoff scan surface is linear on adversarial prompts', () => {
  // Warm-up once per entry point so JIT and lazy ICU/regex compilation are not charged to the first measured case.
  for (const [entry, fn] of Object.entries(ENTRY_POINTS)) fn('warm up. '.repeat(500) + '́', ctx);

  for (const [shape, build] of Object.entries(SHAPES)) {
    if (ONLY && !ONLY.test(shape)) continue;
    describe(shape, () => {
      for (const [entry, fn] of Object.entries(ENTRY_POINTS)) {
        test(entry, () => {
          for (const [small, large] of PAIRS) {
            const ts: number[] = [];
            for (const n of [small, large]) {
              const text = build(n);
              if (entry.startsWith('getInteractionRead')) ctx.rowFor(text); // insert outside the timed region
              fn(text, ctx); // warm-up for this input
              const ms = bestOf3(() => fn(text, ctx));
              ts.push(ms);
              table.push({ shape, entry, size: n, ms });
            }
            const bound = Math.max(150, (BOUND_AT_MAX_MS * large) / SCAN_MAX_PROMPT_CHARS);
            expect(ts[1]).toBeLessThan(bound);
            const ratio = ts[1] / Math.max(ts[0], RATIO_FLOOR_MS);
            expect(ratio).toBeLessThan(RATIO_LIMIT);
          }
        }, 600_000);
      }
    });
  }
});

describe('foldCompat: per-code-point compatibility fold (replaces the built-in normaliser)', () => {
  test('single code points fold as NFKC does: fullwidth, halfwidth katakana marks, U+FDFA, ligatures, brackets', () => {
    for (const ch of ['Ａ', '１２３', '．', 'ﾞ', 'ﾟ', 'ﾊ', 'ﷺ', 'ﬃ', 'ﬁ', '①', 'ｱ', '㌀', '\u00A0', '\u0E33', '\u0EB3', '\u2126', '\u212B', '［', '］', '﹇', '﹈', 'ǆ', 'ℌ']) {
      expect(foldCompat(ch)).toBe(ch.normalize('NFKC'));
    }
    expect(foldCompat('ﷺ')).toHaveLength(18);
    expect(foldCompat('ﾞ')).toBe('\u3099');
    expect(foldCompat('１２３４．５６７８')).toBe('1234.5678');
  });

  // The table is generated from one runtime's ICU data. Unicode's normalization stability policy means existing
  // NFKC mappings never change, but newer versions add mappings for new code points (CI's ICU had Unicode 17's
  // U+A7F1 -> 'S'). So: every code point the TABLE maps must match the runtime everywhere; "nothing else maps" is
  // only checked against the Unicode version the table was built from.
  const mismatchesWhere = (want: (cp: number) => boolean): string[] => {
    const out: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x30000 ? 1 : 7) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const folded = foldCompat(ch);
      if (want(cp) && folded !== ch && folded !== ch.normalize('NFKC') && out.length < 20) out.push(cp.toString(16));
    }
    return out;
  };
  test('every code point the table folds folds exactly as its own NFKC (stable across Unicode versions)', () => {
    expect(mismatchesWhere(() => true)).toEqual([]);
  }, 60_000);
  test.skipIf(process.versions.unicode !== UNICODE_FOLD_VERSION)('no code point outside the table has an NFKC mapping (same Unicode version only)', () => {
    const missing: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x30000 ? 1 : 7) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (foldCompat(ch) === ch && ch.normalize('NFKC') !== ch && missing.length < 20) missing.push(cp.toString(16));
    }
    expect(missing).toEqual([]);
  }, 60_000);

  test('ASCII and ordinary text are returned as the same string; the fold is idempotent', () => {
    const plain = 'Coffee at Joe\'s, $4.50 caf\u00e9 \u2014 naïve 日本語 한국어';
    expect(foldCompat(plain)).toBe(plain);
    expect(foldCompat('abc[]')).toBe('abc[]');
    const mixed = 'ＡＢＣ ﬃ ﷺ \uFF9E\u0301 x\u0316\u0301 \u{1D7D8}';
    expect(foldCompat(foldCompat(mixed))).toBe(foldCompat(mixed));
    expect(foldCompat('x\uD83D')).toBe('x\uD83D'); // a lone surrogate passes through
    expect(foldCompat('\u{1D7D8}\u{1D7D9}')).toBe('01'); // astral code points fold too
  });

  test('stripMarks drops accents and marks to ASCII base letters', () => {
    expect(stripMarks('caf\u00e9 \u00dcber ǆ'.normalize('NFKC'))).toContain('cafe Uber');
    expect(stripMarks('e\u0301\u0316')).toBe('e');
  });

  test('bracket look-alikes still neutralise: every code point whose fold has [ or ] ends up as ( or )', () => {
    const fx = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'bracket-lookalikes.json'), 'utf8')) as { entries: Array<{ cp: string }> };
    const generated = `${FOLD_OPEN_BRACKET_CPS} ${FOLD_CLOSE_BRACKET_CPS}`.split(' ').filter(Boolean).map((h) => String.fromCodePoint(parseInt(h, 16)));
    expect(generated.length).toBeGreaterThanOrEqual(4);
    const cps = new Set([...fx.entries.map((e) => e.cp), ...generated]);
    for (const ch of cps) expect(neutralizeBrackets(`x${ch}y`)).not.toMatch(/[[\]]/);
    for (const ch of generated) expect(foldCompat(ch)).toMatch(/[[\]]/); // the table is where they come from
  });
});

describe('source guard: no built-in normalisation of untrusted text in the handoff / judge / export / replay surface', () => {
  const root = join(import.meta.dir, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === 'node_modules' || f === '.output' || f === 'spike' || f.startsWith('dist')) return []; // build output and spikes are not shipped server code
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : [];
    });
  // The scan surface: training, mcp and server-side dashboard code, plus the replay path in utils/ and agent/.
  const REPLAY_FILES = ['utils/history-context.ts', 'utils/in-memory-chat-history.ts', 'agent/agent.ts'].map((f) => join(root, f));
  const surfaceFiles = () => [...['training', 'mcp', 'dashboard'].flatMap((d) => walk(join(root, d))), ...REPLAY_FILES];
  test('no normalize() use (call, bracket access, .call, or destructuring) on the scan surface', () => {
    const files = surfaceFiles();
    expect(files.length).toBeGreaterThan(20);
    const re = /\.normalize\s*\(|\[\s*['"`]normalize['"`]\s*\]|\bnormalize\.(call|apply|bind)\b|\{[^}]*\bnormalize\b[^}]*\}\s*=\s*String\.prototype/;
    const offenders = files.filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]); // the only allowed caller is scripts/gen-unicode-fold-table.ts
  });
  test('no other ICU collation/locale-casing calls on the server-side scan surface', () => {
    const files = surfaceFiles().filter((f) => !f.includes('/dashboard/ui/'));
    const offenders = files.filter((f) => /localeCompare|Intl\.Collator|toLocale(Lower|Upper)Case/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  test('the generator script is the one place that calls it, and the table records the Unicode version', () => {
    expect(readFileSync(join(root, '..', 'scripts', 'gen-unicode-fold-table.ts'), 'utf8')).toMatch(/\.normalize\('NFKC'\)/);
    expect(readFileSync(join(root, 'mcp', 'unicode-fold-table.ts'), 'utf8')).toMatch(/UNICODE_FOLD_VERSION = "\d+\.\d+/);
  });
});

describe('hostile mark runs through the real entry points (were 10 s+ with the built-in normaliser)', () => {
  const shapes: Record<string, string> = {
    'a + alternating marks': `a${'\u0316\u0301'.repeat(50_000)}`,
    'halfwidth voiced marks': 'a\uFF9E\u0301'.repeat(35_000),
    'hidden char between marks': `a${('\u0316\u0301' + '\u200b').repeat(60_000)}`,
  };
  for (const [name, text] of Object.entries(shapes)) {
    test(name, () => {
      for (const fn of [() => neutralizeBrackets(text), () => looksLikeHandoffMarker(text), () => maskPii(text), () => sanitizeUntrustedText(text, 500)]) {
        const t0 = performance.now();
        fn();
        expect(performance.now() - t0).toBeLessThan(1_000);
      }
    }, 60_000);
  }
});
