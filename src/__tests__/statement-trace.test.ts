import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { parseStatementContent, sha256Hex, type ParsedStatement } from '../tools/import/client-import.js';
import { runStatementChain, importStep, predictStep, reconcileStep, type TraceChainInput } from '../demo/statement-trace.js';
import { KNOWN_MERCHANTS } from '../demo/known-merchants.js';
import { CATEGORIES } from '../tools/categorize/categories.js';
import { computeExternalId } from '../tools/import/external-id.js';
import { createFakeEmbedder } from './fake-embedder.js';
import { createTestDb } from './helpers.js';

const FIXTURE_CONTENT = readFileSync(new URL('../../demos/fixtures/august-2026-chase.csv', import.meta.url), 'utf-8');

function parseFixture(): ParsedStatement {
  return parseStatementContent(FIXTURE_CONTENT);
}

function fixtureInput(parsed: ParsedStatement, fileHash: string): TraceChainInput {
  return {
    filename: 'august-2026-chase.csv',
    bank: parsed.bank,
    format: parsed.format,
    fileHash,
    transactions: parsed.transactions.map((t) => ({
      date: t.date,
      description: t.description,
      amount: t.amount,
      bank: t.bank,
      merchant_name: t.merchant_name,
    })),
  };
}

const fakeEmbedder = createFakeEmbedder();

describe('vendored fixture (demos/fixtures/august-2026-chase.csv)', () => {
  test('parses as a Chase CSV statement with the known shape', () => {
    const parsed = parseFixture();
    expect(parsed.format).toBe('csv');
    expect(parsed.bank).toBe('chase');
    expect(parsed.transactions.length).toBe(34);
    expect(parsed.dateRange).toEqual({ start: '2026-08-01', end: '2026-08-30' });
    expect(parsed.transactions[0].description).toBe('PAYROLL DEPOSIT - ACME CORP');
  });

  test('fixture hash is stable (dedup key parity with the CLI pipeline)', async () => {
    const hash = await sha256Hex(FIXTURE_CONTENT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(FIXTURE_CONTENT)).toBe(hash);
  });
});

describe('KNOWN_MERCHANTS reference set', () => {
  test('non-empty with unique labels and Wilson-taxonomy categories', () => {
    expect(KNOWN_MERCHANTS.length).toBeGreaterThan(0);
    const labels = KNOWN_MERCHANTS.map((m) => m.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const m of KNOWN_MERCHANTS) {
      expect(CATEGORIES).toContain(m.category);
    }
  });
});

describe('runStatementChain — orchestrator on the vendored fixture', () => {
  test('runs all four steps in order with per-step timing and exact totalMs accumulation', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);

    const run = await runStatementChain(fixtureInput(parsed, fileHash), { db, embed: fakeEmbedder.embed });

    expect(run.steps.map((s) => s.step)).toEqual(['import', 'embed', 'predict', 'reconcile']);
    for (const step of run.steps) {
      expect(step.status).toBe('ok');
      expect(Number.isFinite(step.durationMs)).toBe(true);
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
    // The accumulation contract: totalMs is the exact sum of the step durations.
    expect(run.totalMs).toBe(run.steps.reduce((sum, s) => sum + s.durationMs, 0));

    const embedDetail = run.steps[1].detail as { model: string; matches: unknown[] };
    expect(embedDetail.matches.length).toBe(34);
    const predictDetail = run.steps[2].detail as { description: string; category: string; confidence: number; displayOnly: true };
    expect(predictDetail.description).toBe('PAYROLL DEPOSIT - ACME CORP');
    expect(predictDetail.category).toBe('Income');
    expect(predictDetail.displayOnly).toBe(true);
  });

  test('import step commits 34 rows and resolves their ids via computeExternalId', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);

    const result = await importStep(fixtureInput(parsed, fileHash), { db, embed: fakeEmbedder.embed });
    expect(result.status).toBe('ok');
    const detail = result.detail as { rowCount: number; imported: number; skippedRows: number; importedIds: number[]; bank: string; format: string };
    expect(detail.rowCount).toBe(34);
    expect(detail.imported).toBe(34);
    expect(detail.skippedRows).toBe(0);
    expect(detail.importedIds.length).toBe(34);
    expect(detail.bank).toBe('chase');
    expect(detail.format).toBe('csv');

    // Spot-check two ids against the fixture rows via the same derivation the
    // CLI uses — row 0 (payroll) and the first Megamart duplicate row.
    const payroll = parsed.transactions[0];
    const megamart = parsed.transactions.find((t) => t.description === 'MEGAMART ONLINE' && t.date === '2026-08-12');
    expect(megamart).toBeDefined();
    for (const row of [payroll, megamart!]) {
      const extId = computeExternalId(row);
      const row2 = db.prepare('SELECT date, description, amount FROM transactions WHERE external_id = @extId').get({ extId }) as { date: string; description: string; amount: number };
      expect(row2.date).toBe(row.date);
      expect(row2.description).toBe(row.description);
      expect(row2.amount).toBe(row.amount);
    }
  });

  test('embedding lookup matches exact merchant strings at score 1.0', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);

    const run = await runStatementChain(fixtureInput(parsed, fileHash), { db, embed: fakeEmbedder.embed });
    const embedDetail = run.steps[1].detail as { matches: { description: string; label: string; category: string; score: number }[] };

    for (const m of embedDetail.matches) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
    const oak = embedDetail.matches.filter((m) => m.description === 'OAK STREET COFFEE');
    expect(oak.length).toBeGreaterThan(0);
    for (const m of oak) {
      expect(m.label).toBe('OAK STREET COFFEE');
      expect(m.category).toBe('Dining');
      expect(m.score).toBe(1);
    }
    // Partial-overlap sanity: the Harborview rows match the exact HOTEL
    // reference, never the shared-word DENTAL GROUP one.
    const harborview = embedDetail.matches.filter((m) => m.description === 'HARBORVIEW HOTEL');
    for (const m of harborview) {
      expect(m.label).toBe('HARBORVIEW HOTEL');
      expect(m.category).toBe('Travel');
      expect(m.score).toBe(1);
    }
  });

  test('prediction is display-only — no category is ever written', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);

    const run = await runStatementChain(fixtureInput(parsed, fileHash), { db, embed: fakeEmbedder.embed });
    const importDetail = run.steps[0].detail as { importedIds: number[] };
    const predictDetail = run.steps[2].detail as { category: string; confidence: number; displayOnly: true };
    expect(predictDetail.category).toBe('Income');
    expect(predictDetail.confidence).toBeGreaterThanOrEqual(0);
    expect(predictDetail.confidence).toBeLessThanOrEqual(1);
    expect(predictDetail.displayOnly).toBe(true);

    // Nothing written: every imported row still has a NULL category.
    const placeholders = importDetail.importedIds.map((_, i) => `@id${i}`).join(',');
    const params = Object.fromEntries(importDetail.importedIds.map((id, i) => [`id${i}`, id]));
    const rows = db.prepare(`SELECT category FROM transactions WHERE id IN (${placeholders})`).all(params) as { category: string | null }[];
    expect(rows.length).toBe(34);
    for (const r of rows) expect(r.category).toBeNull();
  });

  test('reconciliation surfaces exactly the two proven duplicate beats', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);

    const run = await runStatementChain(fixtureInput(parsed, fileHash), { db, embed: fakeEmbedder.embed });
    const importDetail = run.steps[0].detail as { importedIds: number[] };
    const reconcile = await reconcileStep(importDetail.importedIds, { db, embed: fakeEmbedder.embed });

    expect(reconcile.status).toBe('ok');
    const detail = reconcile.detail as { duplicates: { transactions: { date: string; description: string; amount: number }[]; message: string }[]; spikes: unknown[] };

    expect(detail.duplicates.length).toBe(2);
    const byDescription = new Map(detail.duplicates.map((d) => [d.transactions[0].description, d]));
    const megamart = byDescription.get('MEGAMART ONLINE');
    expect(megamart).toBeDefined();
    expect(megamart!.transactions.map((t) => t.date).sort()).toEqual(['2026-08-12', '2026-08-13']);
    expect(megamart!.transactions[0].amount).toBe(-89.99);
    const harborview = byDescription.get('HARBORVIEW HOTEL');
    expect(harborview).toBeDefined();
    expect(harborview!.transactions.map((t) => t.date).sort()).toEqual(['2026-08-17', '2026-08-20']);
    expect(harborview!.transactions[0].amount).toBe(-318);
    for (const d of detail.duplicates) {
      expect(d.message).toContain(d.transactions[0].description);
      expect(d.message).toContain(Math.abs(d.transactions[0].amount).toFixed(2));
    }
    // The spike detector needs ≥3 same-description rows — the fixture alone
    // yields none, and the node says so honestly.
    expect(detail.spikes).toEqual([]);
  });

  test('re-drop of the same statement skips cleanly — file-level dedup', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);
    const input = fixtureInput(parsed, fileHash);

    const first = await runStatementChain(input, { db, embed: fakeEmbedder.embed });
    expect((first.steps[0].detail as { imported: number }).imported).toBe(34);

    const second = await runStatementChain(input, { db, embed: fakeEmbedder.embed });
    const [importStep2, embedStep2, predictStep2, reconcileStep2] = second.steps;
    expect(importStep2.step).toBe('import');
    expect(importStep2.status).toBe('skipped');
    const detail = importStep2.detail as { previouslyImported?: { importedAt: string; transactionCount: number | null }; message: string };
    expect(detail.previouslyImported).toBeDefined();
    expect(detail.previouslyImported!.transactionCount).toBe(34);
    expect(detail.message).toContain('already imported');

    // Steps 2–4 are skipped fillers with zero duration; totalMs still sums exactly.
    for (const step of [embedStep2, predictStep2, reconcileStep2]) {
      expect(step.status).toBe('skipped');
      expect(step.durationMs).toBe(0);
    }
    expect(second.totalMs).toBe(second.steps.reduce((sum, s) => sum + s.durationMs, 0));

    // And no rows were duplicated.
    const count = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    expect(count.c).toBe(34);
  });

  test('a validation-failing import propagates as an error step and inserts nothing', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);
    const badInput: TraceChainInput = {
      ...fixtureInput(parsed, fileHash),
      transactions: [{ date: '08/01/2026', description: 'BAD DATE FORMAT', amount: -10 }],
    };

    const run = await runStatementChain(badInput, { db, embed: fakeEmbedder.embed });
    expect(run.steps.map((s) => s.step)).toEqual(['import', 'embed', 'predict', 'reconcile']);
    expect(run.steps[0].status).toBe('error');
    expect(run.steps[0].error).toContain('YYYY-MM-DD');
    for (const step of run.steps.slice(1)) {
      expect(step.status).toBe('skipped');
    }
    const count = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    expect(count.c).toBe(0);
  });

  test('a throwing embed step stops the chain with later steps skipped', async () => {
    const db = createTestDb();
    const parsed = parseFixture();
    const fileHash = await sha256Hex(FIXTURE_CONTENT);
    const input = fixtureInput(parsed, fileHash);

    const run = await runStatementChain(input, {
      db,
      embed: async () => {
        throw new Error('embedder exploded');
      },
    });
    expect(run.steps[0].status).toBe('ok');
    expect(run.steps[1].step).toBe('embed');
    expect(run.steps[1].status).toBe('error');
    expect(run.steps[1].error).toBe('embedder exploded');
    expect(run.steps[2].status).toBe('skipped');
    expect(run.steps[3].status).toBe('skipped');
    expect(run.totalMs).toBe(run.steps.reduce((sum, s) => sum + s.durationMs, 0));
  });
});

describe('predictStep (standalone)', () => {
  test('predicts a category with clamped confidence and writes nothing', async () => {
    const db = createTestDb();
    const result = await predictStep('FUEL DEPOT', { db, embed: fakeEmbedder.embed });
    expect(result.status).toBe('ok');
    const detail = result.detail as { description: string; category: string; confidence: number; displayOnly: true };
    expect(detail.description).toBe('FUEL DEPOT');
    expect(detail.category).toBe('Transport');
    expect(detail.displayOnly).toBe(true);
    expect(detail.confidence).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number };
    expect(count.c).toBe(0);
  });
});