import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseStatementContent,
  sha256Hex,
  canCommitImport,
} from '../tools/import/client-import.js';

const data = (...p: string[]) => join(import.meta.dir, '..', '..', 'data', ...p);
const read = (...p: string[]) => readFileSync(data(...p), 'utf-8');

/**
 * Tests for the browser-side statement-import helpers in
 * src/tools/import/client-import.ts — the parse orchestration the dashboard's
 * importer runs client-side before anything is POSTed to /api/import.
 * No DB, no server, no DOM: Bun provides crypto.subtle for the WebCrypto tests.
 */

// Fixture expectations pinned to today's parser output.
const FIXTURES = [
  { path: ['csv', 'chase', 'standard.csv'], format: 'csv', bank: 'chase', rows: 9, range: { start: '2026-01-03', end: '2026-02-05' } },
  { path: ['csv', 'amex', 'standard.csv'], format: 'csv', bank: 'amex', rows: 8, range: { start: '2026-01-05', end: '2026-02-06' } },
  { path: ['csv', 'bofa-checking', 'standard.csv'], format: 'csv', bank: 'bofa', rows: 7, range: { start: '2026-01-03', end: '2026-01-28' } },
  { path: ['csv', 'bofa-cc', 'standard.csv'], format: 'csv', bank: 'bofa-cc', rows: 7, range: { start: '2026-01-04', end: '2026-02-04' } },
  { path: ['csv', 'generic', 'standard.csv'], format: 'csv', bank: 'generic', rows: 8, range: { start: '2026-01-03', end: '2026-02-05' } },
  { path: ['csv', 'generic', 'debit-credit-cols.csv'], format: 'csv', bank: 'generic', rows: 7, range: { start: '2026-01-03', end: '2026-02-01' } },
  { path: ['ofx', 'v1-standard.ofx'], format: 'ofx', bank: 'ofx', rows: 8, range: { start: '2026-01-03', end: '2026-02-01' } },
  { path: ['ofx', 'v2-standard.ofx'], format: 'ofx', bank: 'ofx', rows: 5, range: { start: '2026-01-05', end: '2026-01-30' } },
  { path: ['qif', 'standard.qif'], format: 'qif', bank: 'qif', rows: 10, range: { start: '2026-01-03', end: '2026-02-01' } },
] as const;

describe('parseStatementContent — per-bank fixtures', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture.path.join('/')} → ${fixture.bank}/${fixture.format}, ${fixture.rows} rows`, () => {
      const content = read(...fixture.path);
      const parsed = parseStatementContent(content);

      expect(parsed.format).toBe(fixture.format);
      expect(parsed.bank).toBe(fixture.bank);
      expect(parsed.transactions.length).toBe(fixture.rows);
      expect(parsed.dateRange).toEqual(fixture.range);
      expect(parsed.total).toBeCloseTo(
        parsed.transactions.reduce((sum, t) => sum + t.amount, 0),
      );

      const first = parsed.transactions[0];
      expect(first.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(first.description.trim().length).toBeGreaterThan(0);
      expect(Number.isFinite(first.amount)).toBe(true);
    });
  }

  test('Chase fixture rows carry their detected bank', () => {
    const parsed = parseStatementContent(read('csv', 'chase', 'standard.csv'));
    for (const t of parsed.transactions) expect(t.bank).toBe('chase');
  });

  test('OFX FITID passes through as external_id', () => {
    const parsed = parseStatementContent(read('ofx', 'v1-standard.ofx'));
    expect(parsed.transactions.some((t) => typeof t.external_id === 'string' && t.external_id.length > 0)).toBe(true);
  });
});

describe('parseStatementContent — parse failures stay client-side', () => {
  test('CSV without detectable date/description columns throws (dialog error, nothing POSTed)', () => {
    // Two lines so csv-parse yields records and generic column detection runs:
    // "foo"/"bar" match no date/description pattern → the parser throws.
    expect(() => parseStatementContent('foo,bar\n2026-01-01,hello\n')).toThrow(/Could not auto-detect/);
  });

  test('single-line garbage parses to zero transactions (no header row → no records)', () => {
    // csv-parse treats the lone line as the header, leaving zero records —
    // the parser returns [] without throwing. The dialog treats 0 rows as a
    // parse failure either way; both paths stay client-side.
    const parsed = parseStatementContent('this is not a bank statement, just text');
    expect(parsed.transactions).toEqual([]);
  });

  test('header-only CSV parses to zero transactions (treated as failure by the dialog)', () => {
    const headerOnly = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n';
    const parsed = parseStatementContent(headerOnly);
    expect(parsed.transactions).toEqual([]);
    expect(parsed.dateRange).toEqual({ start: '', end: '' });
    expect(parsed.total).toBe(0);
  });
});

describe('parseStatementContent — server contract net', () => {
  // apiImport (src/dashboard/api.ts) 400s on rows missing a valid date,
  // description, or finite amount — assert every parsed row satisfies it.
  test('every parsed row from every fixture is valid ImportTransactionInput shape', () => {
    for (const fixture of FIXTURES) {
      const parsed = parseStatementContent(read(...fixture.path));
      for (const t of parsed.transactions) {
        expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(t.description.length).toBeGreaterThan(0);
        expect(Number.isFinite(t.amount)).toBe(true);
      }
    }
  });
});

describe('sha256Hex — WebCrypto parity with the CLI pipeline', () => {
  // The CLI hashes with createHash('sha256').update(content).digest('hex')
  // (csv-import.ts, over readFileSync(filePath, 'utf-8')). Pin the browser
  // helper against that exact expression so file-level dedup holds cross-path.
  test('matches node createHash over every fixture file', async () => {
    for (const fixture of FIXTURES) {
      const content = read(...fixture.path);
      const webcrypto = await sha256Hex(content);
      const node = createHash('sha256').update(content).digest('hex');
      expect(webcrypto).toBe(node);
    }
  });

  test('matches node createHash on edge strings, incl. empty and >10KB', async () => {
    const longText = '💸 café ☕ ünïcödé '.repeat(700); // >10KB
    const cases = ['', '💸 café ☕ ünïcödé', longText];
    for (const content of cases) {
      const webcrypto = await sha256Hex(content);
      const node = createHash('sha256').update(content).digest('hex');
      expect(webcrypto).toBe(node);
      expect(webcrypto).toMatch(/^[0-9a-f]{64}$/);
    }
    // Deterministic across calls
    expect(await sha256Hex(longText)).toBe(await sha256Hex(longText));
    // Empty string is sha256 of the empty byte string
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('canCommitImport — RBAC policy (mirrors /api/import gate)', () => {
  test('auth off or not yet loaded → open (standalone demo default)', () => {
    expect(canCommitImport(null)).toBe(true);
    expect(canCommitImport(undefined)).toBe(true);
    expect(canCommitImport({})).toBe(true);
    expect(canCommitImport({ authEnabled: false, user: null })).toBe(true);
    expect(canCommitImport({ authEnabled: false, user: { role: 'viewer' } })).toBe(true);
  });

  test('auth on → admin only', () => {
    expect(canCommitImport({ authEnabled: true, user: { role: 'admin' } })).toBe(true);
    expect(canCommitImport({ authEnabled: true, user: { role: 'viewer' } })).toBe(false);
    expect(canCommitImport({ authEnabled: true, user: null })).toBe(false);
    expect(canCommitImport({ authEnabled: true })).toBe(false);
  });
});