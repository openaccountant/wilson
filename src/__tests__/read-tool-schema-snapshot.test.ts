import { describe, expect, test } from 'bun:test';
import { jsonSchemaFor } from '../mcp/tool-catalog.js';
import { READ_TOOL_SCHEMAS, validateReadToolArgs } from '../dashboard/ui/src/hybrid/read-tool-schemas.js';

/**
 * The frozen UI snapshot of the 5 READ tools' JSON schemas. The UI cannot
 * import src/mcp/tool-catalog.ts (node:crypto + server query modules), so the
 * model worker and the mirror port validate against a copy. This test is the
 * drift detector: when the catalog changes (e.g. the judge's catalog v2), it
 * fails loudly and the snapshot is regenerated deliberately.
 */
describe('read-tool-schemas snapshot', () => {
  test.each(['transaction_search', 'spending_summary', 'profit_loss', 'net_worth', 'forecast'] as const)(
    '%s equals jsonSchemaFor',
    (name) => {
      // As plain JSON: zod attaches a non-JSON `~standard` member to the schema object it returns.
      expect(READ_TOOL_SCHEMAS[name] as unknown).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor(name))));
    }
  );

  test('covers exactly the 5 read tools', () => {
    expect(Object.keys(READ_TOOL_SCHEMAS).sort()).toEqual(
      ['forecast', 'net_worth', 'profit_loss', 'spending_summary', 'transaction_search']
    );
  });
});

describe('validateReadToolArgs', () => {
  const ok = (tool: string, args: unknown) => expect(validateReadToolArgs(tool, args)).toEqual({ ok: true });
  const bad = (tool: string, args: unknown) => expect(validateReadToolArgs(tool, args).ok).toBe(false);

  test('accepts valid args', () => {
    ok('transaction_search', { query: 'Adobe' });
    ok('spending_summary', {});
    ok('spending_summary', { period: 'quarter', compareWithPrevious: false });
    ok('profit_loss', { period: 'year', offset: -1 });
    ok('net_worth', { action: 'trend', months: 6 });
    ok('forecast', {});
    ok('forecast', {
      trailingMonths: 3,
      horizonMonths: 6,
      whatIf: [
        { type: 'adjust_category', category: 'Dining', monthlyDelta: -50 },
        { type: 'drop_recurring', description: 'Netflix' },
      ],
    });
  });

  test('rejects an unknown tool', () => {
    bad('tax_flag', { action: 'summary' });
    bad('categorize_transaction', { id: 1, category: 'Dining' });
    bad('__proto__', {});
    bad('constructor', {});
  });

  test('rejects non-object args', () => {
    for (const v of [null, undefined, 'x', 1, [], true]) bad('spending_summary', v);
  });

  test('rejects unknown keys', () => {
    bad('transaction_search', { query: 'x', bogus: 5 });
    bad('spending_summary', { period: 'month', extra: 1 });
    bad('forecast', { whatIf: [{ type: 'drop_recurring', bogus: 1 }] });
  });

  test('rejects missing required keys', () => {
    bad('transaction_search', {});
    bad('net_worth', { months: 3 });
    bad('forecast', { whatIf: [{ category: 'Dining' }] });
  });

  test('rejects wrong types and enum values', () => {
    bad('transaction_search', { query: 5 });
    bad('spending_summary', { period: 'week' });
    bad('spending_summary', { compareWithPrevious: 'yes' });
    bad('profit_loss', { offset: '1' });
    bad('profit_loss', { offset: Number.NaN });
    bad('profit_loss', { offset: Number.POSITIVE_INFINITY });
    bad('net_worth', { action: 'everything' });
    bad('forecast', { whatIf: 'cut dining' });
    bad('forecast', { whatIf: [{ type: 'adjust_category', monthlyDelta: '5' }] });
  });
});
