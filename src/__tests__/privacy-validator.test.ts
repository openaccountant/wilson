import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  classifyProvider,
  buildProviderLedger,
  startPrivacyRun,
  getPrivacyLedger,
  getPrivacyExhibit,
  EXHIBIT_NOTE,
} from '../demo/privacy.js';
import {
  SIMULATED_PROVIDER,
  BROWSER_LOCAL_PROVIDER,
  SHOWDOWN_SYSTEM_PROMPT,
  buildShowdownUserPrompt,
} from '../demo/showdown.js';
import { getSampleBySlug, SAMPLE_TRANSACTIONS } from '../demo/samples.js';
import { buildCategorizationPrompt } from '../tools/categorize/prompt.js';
import { PROVIDERS, getProviderById } from '../providers.js';
import { traceStore, type LlmTrace } from '../utils/trace-store.js';
import { insertTransactions } from '../db/queries.js';
import { createTestDb } from './helpers.js';

function makeTrace(overrides: Partial<LlmTrace> & { id: string }): LlmTrace {
  return {
    timestamp: new Date().toISOString(),
    model: 'm',
    provider: 'openai',
    promptLength: 10,
    responseLength: 5,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    durationMs: 12,
    status: 'ok',
    ...overrides,
  };
}

describe('privacy validator — classification', () => {
  test('classifyProvider: the simulated marker can never classify as cloud', () => {
    expect(SIMULATED_PROVIDER).toBe('simulated');
    expect(classifyProvider(SIMULATED_PROVIDER)).toBe('simulated');
    expect(classifyProvider('simulated')).not.toBe('cloud');
  });

  test("classifyProvider: the browser-local marker is local (the attendee's own browser)", () => {
    expect(BROWSER_LOCAL_PROVIDER).toBe('transformers-browser');
    expect(classifyProvider(BROWSER_LOCAL_PROVIDER)).toBe('local');
  });

  test('classifyProvider: every registry provider classifies per isLocal — the single source', () => {
    for (const p of PROVIDERS) {
      expect(classifyProvider(p.id)).toBe(p.isLocal ? 'local' : 'cloud');
    }
    // Spot-check the documented split.
    expect(classifyProvider('ollama')).toBe('local');
    expect(classifyProvider('transformers')).toBe('local');
    for (const cloud of ['openai', 'anthropic', 'google', 'xai', 'moonshot', 'deepseek', 'openrouter', 'litellm']) {
      expect(classifyProvider(cloud)).toBe('cloud');
    }
  });

  test('classifyProvider: an unrecognized provider is never silently local', () => {
    expect(classifyProvider('acme-cloud')).toBe('unknown');
    expect(classifyProvider('acme-cloud')).not.toBe('local');
    expect(classifyProvider('acme-cloud')).not.toBe('cloud');
  });
});

describe('privacy validator — ledger rendered from trace records', () => {
  test('mixed run: verbatim passthrough, honest counts, failing verdict', () => {
    const rows: LlmTrace[] = [
      makeTrace({ id: 't1', provider: BROWSER_LOCAL_PROVIDER, model: 'onnx-community/Qwen3-0.6B-ONNX', durationMs: 42 }),
      makeTrace({ id: 't2', provider: SIMULATED_PROVIDER, model: 'simulated:openai/gpt-4o-mini', durationMs: 1 }),
      makeTrace({ id: 't3', provider: 'transformers', model: 'transformers:onnx-community/Qwen3-0.6B-ONNX', durationMs: 900 }),
      makeTrace({
        id: 't4',
        provider: 'openrouter',
        model: 'openrouter:openai/gpt-4o-mini',
        durationMs: 640,
        status: 'error',
        error: '401 unauthorized',
      }),
      makeTrace({ id: 't5', provider: 'acme-cloud', model: 'acme/mystery', durationMs: 7 }),
    ];

    const ledger = buildProviderLedger({ runId: 'r1', startedAt: '2026-09-21T10:00:00.000Z', rows });

    // verbatim passthrough, chronological order preserved
    expect(ledger.entries.map((e) => e.traceId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(ledger.entries.map((e) => e.provider)).toEqual([
      BROWSER_LOCAL_PROVIDER,
      SIMULATED_PROVIDER,
      'transformers',
      'openrouter',
      'acme-cloud',
    ]);
    expect(ledger.entries.map((e) => e.model)).toEqual(rows.map((r) => r.model));
    expect(ledger.entries.map((e) => e.durationMs)).toEqual([42, 1, 900, 640, 7]);
    expect(ledger.entries.map((e) => e.bucket)).toEqual([
      'local',
      'simulated',
      'local',
      'cloud',
      'unknown',
    ]);

    // a failed cloud attempt still lands in the cloud bucket with its error
    expect(ledger.entries[3].status).toBe('error');
    expect(ledger.entries[3].error).toBe('401 unauthorized');

    expect(ledger.counts).toEqual({ local: 2, simulated: 1, cloud: 1, unknown: 1, total: 5 });
    expect(ledger.allLocal).toBe(false);
    expect(ledger.verdict).toContain('does not hold');
    expect(ledger.verdict).toContain('1 request');
  });

  test('simulated-only run: never misattributed as cloud — the all-local verdict holds', () => {
    const rows = [
      makeTrace({ id: 's1', provider: SIMULATED_PROVIDER, model: 'simulated:openai/gpt-4o-mini' }),
      makeTrace({ id: 's2', provider: SIMULATED_PROVIDER, model: 'simulated:openai/gpt-4o-mini' }),
    ];
    const ledger = buildProviderLedger({ runId: 'r2', startedAt: '2026-09-21T10:00:00.000Z', rows });

    expect(ledger.entries.every((e) => e.bucket === 'simulated')).toBe(true);
    expect(ledger.counts.cloud).toBe(0);
    expect(ledger.counts.simulated).toBe(2);
    expect(ledger.allLocal).toBe(true);
    expect(ledger.verdict).toContain('0 cloud calls');
    expect(ledger.verdict).toContain('clearly-marked simulated');
    expect(ledger.verdict).toContain('stayed on localhost');
  });

  test('verdict matrix: empty, singular, plural, unknown-only', () => {
    const empty = buildProviderLedger({ runId: 'r3', startedAt: 'x', rows: [] });
    expect(empty.verdict).toBe(
      'No model or agent requests since you started watching — nothing has left this machine.',
    );
    expect(empty.allLocal).toBe(true);
    expect(empty.counts.total).toBe(0);

    const one = buildProviderLedger({
      runId: 'r4',
      startedAt: 'x',
      rows: [makeTrace({ id: 'l1', provider: 'ollama', model: 'ollama:llama3' })],
    });
    expect(one.verdict).toBe(
      'All 1 request stayed on localhost — 1 local, 0 clearly-marked simulated timers, 0 cloud calls.',
    );
    expect(one.allLocal).toBe(true);

    const two = buildProviderLedger({
      runId: 'r5',
      startedAt: 'x',
      rows: [
        makeTrace({ id: 'l2', provider: 'transformers', model: 'transformers:m' }),
        makeTrace({ id: 'l3', provider: SIMULATED_PROVIDER, model: 'simulated:m' }),
      ],
    });
    expect(two.verdict).toBe(
      'All 2 requests stayed on localhost — 1 local, 1 clearly-marked simulated timers, 0 cloud calls.',
    );

    const unknownOnly = buildProviderLedger({
      runId: 'r6',
      startedAt: 'x',
      rows: [makeTrace({ id: 'u1', provider: 'who-is-this', model: 'm' })],
    });
    expect(unknownOnly.allLocal).toBe(false);
    expect(unknownOnly.counts.unknown).toBe(1);
    expect(unknownOnly.counts.local).toBe(0);
    expect(unknownOnly.verdict).toContain('unrecognized provider');
    expect(unknownOnly.verdict).toContain('not counted as local');
  });
});

describe('privacy validator — run lifecycle (real trace store, no db)', () => {
  beforeEach(() => {
    traceStore.clear();
  });
  afterEach(() => {
    traceStore.clear();
  });

  test('watermark: rows recorded before the arm are excluded; unknown runs throw', () => {
    traceStore.record(makeTrace({ id: 'A' }));
    const run = startPrivacyRun(null);
    traceStore.record(makeTrace({ id: 'B' }));
    traceStore.record(makeTrace({ id: 'C' }));

    const ledger = getPrivacyLedger(null, run.id);
    expect(ledger.entries.map((e) => e.traceId)).toEqual(['B', 'C']);
    expect(ledger.runId).toBe(run.id);

    // a fresh run re-arms with a new watermark
    const run2 = startPrivacyRun(null);
    traceStore.record(makeTrace({ id: 'D' }));
    const ledger2 = getPrivacyLedger(null, run2.id);
    expect(ledger2.entries.map((e) => e.traceId)).toEqual(['D']);

    expect(() => getPrivacyLedger(null, 'nope')).toThrow('unknown privacy run');
    expect(() => getPrivacyLedger(null, null)).toThrow('unknown privacy run');
  });

  test('DB-backed read: DB-first, no duplication from the memory buffer, timestamps normalize', () => {
    const db = createTestDb();
    traceStore.setDatabase(db);
    try {
      const run = startPrivacyRun(db);
      const canary = makeTrace({
        id: 'E-id',
        provider: 'openrouter',
        model: 'openrouter:openai/gpt-4o-mini',
      });
      traceStore.record(canary); // lands in memory AND in llm_traces

      const ledger = getPrivacyLedger(db, run.id);
      expect(ledger.entries).toHaveLength(1); // DB-first read — never duplicated
      expect(ledger.entries[0].traceId).toBe('E-id');
      expect(ledger.entries[0].provider).toBe('openrouter'); // verbatim from the DB row
      expect(ledger.entries[0].bucket).toBe('cloud');
      expect(Number.isNaN(new Date(ledger.entries[0].timestamp).getTime())).toBe(false);
      expect(ledger.entries[0].timestamp).toContain('T');
    } finally {
      traceStore.clear();
    }
  });
});

describe('privacy validator — the would-be cloud payload exhibit (fixtures only)', () => {
  test('no slug: the full 8-row fixture payload, byte-equal to the production builder', () => {
    const exhibit = getPrivacyExhibit();
    expect(exhibit.rowCount).toBe(8);
    expect(exhibit.rows).toEqual(
      SAMPLE_TRANSACTIONS.map((s) => ({
        id: s.id,
        slug: s.slug,
        description: s.description,
        amount: s.amount,
        date: s.date,
      })),
    );
    expect(exhibit.payload.user).toBe(
      buildCategorizationPrompt(
        SAMPLE_TRANSACTIONS.map((s) => ({
          id: s.id,
          description: s.description,
          amount: s.amount,
          date: s.date,
        })),
      ),
    );
    for (const s of SAMPLE_TRANSACTIONS) {
      expect(exhibit.payload.user).toContain(s.description);
    }
    expect(exhibit.payload.user).toContain('Groceries');
    expect(exhibit.payload.user).toContain('RULES');
    expect(exhibit.payload.system).toBe(SHOWDOWN_SYSTEM_PROMPT);
    expect(exhibit.cloudModel).toBe(getProviderById('openrouter')!.fastModel!);
    expect(exhibit.note).toBe(EXHIBIT_NOTE);
    expect(exhibit.note).toContain('synthetic');
    expect(exhibit.note).toContain('never');
  });

  test('with slug: byte-identical to what the showdown arms send for that sample', () => {
    const exhibit = getPrivacyExhibit('harborview-dental');
    expect(exhibit.payload).toEqual({
      system: SHOWDOWN_SYSTEM_PROMPT,
      user: buildShowdownUserPrompt(getSampleBySlug('harborview-dental')),
    });
    expect(exhibit.rowCount).toBe(1);
    expect(exhibit.payload.user).toContain('HARBORVIEW DENTAL GROUP');
    expect(exhibit.payload.user).toContain('-318');
    // exactly one transaction row — synthetic samples only, never an import
    expect((exhibit.payload.user.match(/"description":/g) ?? []).length).toBe(1);
    expect(exhibit.rows).toEqual([
      { id: 2, slug: 'harborview-dental', description: 'HARBORVIEW DENTAL GROUP', amount: -318.0, date: '2026-09-14' },
    ]);
  });

  test('no attendee data can leak in: an imported canary row never reaches the payload', () => {
    // Wire a test db holding an imported row — the exhibit takes no db
    // parameter and reads nothing, so this row is structurally incapable of
    // entering the payload. This pin is the fixture-only guard.
    const db = createTestDb();
    insertTransactions(db, [
      {
        date: '2026-08-15',
        description: 'ATTENDEE-CANARY-XYZ',
        amount: -99.99,
        category: 'Uncategorized',
        source_file: 'attendee-statement.csv',
      },
    ]);

    const full = JSON.stringify(getPrivacyExhibit());
    expect(full).not.toContain('ATTENDEE-CANARY');
    expect(full).toContain('HARBORVIEW DENTAL GROUP');

    const single = JSON.stringify(getPrivacyExhibit('harborview-dental'));
    expect(single).not.toContain('ATTENDEE-CANARY');
  });

  test('unknown slug throws (the endpoint turns that into a 400)', () => {
    expect(() => getPrivacyExhibit('nope')).toThrow('Unknown sample slug');
  });
});