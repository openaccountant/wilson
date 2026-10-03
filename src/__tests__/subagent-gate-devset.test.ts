import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateQuestion, keywordRoute } from '../dashboard/ui/src/hybrid/subagent-core.js';
import { detectComparisonIntent } from '../dashboard/ui/src/hybrid/subagent-intent.js';

/**
 * Round 3 "Gate" (specs/DECISIONS.md): the Round-2 gate sent 54% of read questions
 * to the server. It was loosened so terse read questions qualify, and these tests pin
 * that none/mutation diversion stays >= 95% on BOTH burned dev sets.
 *
 * v1 (heldout-router.v1-burned.jsonl) and v2 (heldout-router.v2.jsonl) are burned and may be
 * used as DEV sets. They measure nothing for go/no-go any more. v3 is held out: never read here.
 *
 * "Diverted" is the scorer's definition (scripts/subagent-route-score.mjs): the question never
 * reaches a read tool. Before any tool read the pipeline can stop it at three places: the gate,
 * the single-call shape check (what-if / comparison / trend), and the keyword router (zero or
 * several matches hand off).
 */

const EVAL_DIR = join(import.meta.dir, '..', '..', 'specs', 'eval');

interface DevRow {
  q: string;
  expect: string;
  mutation: boolean;
}

function load(file: string, isMutation: (r: Record<string, unknown>, noneIndex: number) => boolean): DevRow[] {
  let noneIndex = 0;
  return readFileSync(join(EVAL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const r = JSON.parse(l) as Record<string, unknown>;
      const expect = String(r.expect);
      const mutation = expect === 'none' && isMutation(r, noneIndex);
      if (expect === 'none') noneIndex++;
      return { q: String(r.q), expect, mutation };
    });
}

// v1: the scorer documents "held-out none rows 1-21" as the mutation requests.
// v2: the writer marked them in answerNotes ("Mutation request; ...").
const SETS: Record<string, DevRow[]> = {
  v1: load('heldout-router.v1-burned.jsonl', (_r, i) => i < 21),
  v2: load('heldout-router.v2.jsonl', (r) => String(r.answerNotes ?? '').startsWith('Mutation request')),
};

const reachesReadTool = (q: string): boolean =>
  gateQuestion(q).kind === 'route' && detectComparisonIntent(q) === null && keywordRoute(q).length === 1;

function rates(rows: DevRow[]) {
  const read = rows.filter((r) => r.expect !== 'none');
  const none = rows.filter((r) => r.expect === 'none');
  const mutation = rows.filter((r) => r.mutation);
  const falselyGated = read.filter((r) => gateQuestion(r.q).kind !== 'route');
  const divertedNone = none.filter((r) => !reachesReadTool(r.q));
  const divertedMutation = mutation.filter((r) => !reachesReadTool(r.q));
  const gatedMutation = mutation.filter((r) => gateQuestion(r.q).kind !== 'route');
  return {
    read: read.length,
    none: none.length,
    mutation: mutation.length,
    falseGatePct: (100 * falselyGated.length) / read.length,
    divertedPct: (100 * divertedNone.length) / none.length,
    mutationDivertedPct: (100 * divertedMutation.length) / mutation.length,
    mutationGatedPct: (100 * gatedMutation.length) / mutation.length,
    leaked: none.filter((r) => reachesReadTool(r.q)).map((r) => r.q),
  };
}

describe('dev sets load', () => {
  test('v1 has 43 none rows (21 mutation); v2 has 41 none rows (23 mutation)', () => {
    expect(SETS.v1.filter((r) => r.expect === 'none').length).toBe(43);
    expect(SETS.v1.filter((r) => r.mutation).length).toBe(21);
    expect(SETS.v2.filter((r) => r.expect === 'none').length).toBe(41);
    expect(SETS.v2.filter((r) => r.mutation).length).toBe(23);
  });
});

describe('Round 3 gate: diversion on the burned dev sets', () => {
  for (const [name, rows] of Object.entries(SETS)) {
    test(`${name}: none rows are diverted >= 95% before any read tool`, () => {
      const s = rates(rows);
      expect(s.divertedPct, `leaked: ${s.leaked.join(' | ')}`).toBeGreaterThanOrEqual(95);
    });

    test(`${name}: every mutation row is diverted before any read tool`, () => {
      expect(rates(rows).mutationDivertedPct).toBe(100);
    });

    test(`${name}: every mutation row is stopped by the GATE itself, not left to the keyword router`, () => {
      expect(rates(rows).mutationGatedPct).toBe(100);
    });
  }

  test('v1 and v2 combined: diversion >= 95%', () => {
    const s = rates([...SETS.v1, ...SETS.v2]);
    expect(s.divertedPct, `leaked: ${s.leaked.join(' | ')}`).toBeGreaterThanOrEqual(95);
  });
});

describe('Round 3 gate: false-gate rate (read questions sent to the server before routing)', () => {
  // Round-2 baseline, measured at HEAD 442551f: v1 18.8% (15/80), v2 54.4% (112/206).
  test('v1: false-gate rate is at most 10%', () => {
    expect(rates(SETS.v1).falseGatePct).toBeLessThanOrEqual(10);
  });

  test('v2: false-gate rate is at most 15%', () => {
    expect(rates(SETS.v2).falseGatePct).toBeLessThanOrEqual(15);
  });
});

describe('Round 3 gate: terse read questions qualify', () => {
  const TERSE_READS = [
    'hulu charges?',
    'P&L 2025',
    'income statement for last year',
    'netflix',
    'adobe charges?',
    'transactions last month',
    'q3 spending',
    'last quarter profit',
    'networth',
    'cash forecast',
    'monthly spending',
    'paychecks',
    'uber rides',
    'ytd income and expenses',
    'lookup charge SQ *BLUE BOTTLE',
    'can I afford rent in two months at this rate',
  ];
  for (const q of TERSE_READS) {
    test(`routes: ${q}`, () => {
      expect(gateQuestion(q).kind).toBe('route');
    });
  }
});

describe('Round 3 gate: terse mutation and chat phrasing is still diverted', () => {
  const MUST_DIVERT = [
    'Chipotle should count as Dining',
    'that Starbucks thing should be Dining',
    'I want Netflix under Entertainment',
    'Duplicate Adobe row needs to go away',
    'the date on that Venmo is wrong',
    'that PayPal transfer was rent, file it that way',
    'Use Childcare for Sunshine Daycare going forward',
    'toss that second Lyft charge, it is a dupe',
    'that deposit on Friday is a reimbursement, not income',
    'Rid my records of the second Adobe line',
    'cancel netflix',
    'good morning',
    'lol nice',
    'hey there!',
    'thanks, that was helpful',
    'explain what a Roth IRA is',
    // vocabulary-bearing but change-shaped (not in either dev set)
    'Uber charges as Travel',
    'adobe charges into Software',
    'those gym payments belong in Health',
  ];
  for (const q of MUST_DIVERT) {
    test(`diverts: ${q}`, () => {
      expect(gateQuestion(q).kind).not.toBe('route');
    });
  }
});
