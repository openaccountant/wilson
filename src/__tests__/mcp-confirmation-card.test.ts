import { describe, expect, test } from 'bun:test';
import { confirmationCardModel, formatValue } from '../mcp/confirmation-card.js';

/**
 * Content model for the confirmation card (src/mcp/confirmation-card.ts).
 * The card is the ONE visible confirmation for every mutating call; these
 * tests pin that it always names the change with semantic context — tool
 * label, requester, the server-computed summary line, and the from/to delta —
 * and never invents or omits the fallbacks the chat-shaped ops rely on.
 */

const webmcpCategorize = {
  source: 'webmcp',
  tool_name: 'categorize_transaction',
  summary: 'Categorize "MAPLE AVE APARTMENTS RENT" (2026-08-01) as "Home"',
  before_json: JSON.stringify({ category: null, entity_id: null }),
  after_json: JSON.stringify({ category: 'Home', entity_id: null }),
};

describe('confirmationCardModel — tool label', () => {
  test('human labels for the mutating catalog tools', () => {
    expect(confirmationCardModel(webmcpCategorize).title).toBe('Categorize Transaction');
    expect(
      confirmationCardModel({ ...webmcpCategorize, tool_name: 'edit_transaction' }).title,
    ).toBe('Edit Transaction');
    expect(confirmationCardModel({ ...webmcpCategorize, tool_name: 'tax_flag' }).title).toBe('Tax Flag');
  });

  test('unknown tools fall back to their raw name (never blank, never a JSON blob)', () => {
    expect(confirmationCardModel({ ...webmcpCategorize, tool_name: 'future_tool' }).title).toBe('future_tool');
  });
});

describe('confirmationCardModel — source label', () => {
  test('webmcp, http-mcp, and chat each name who is asking', () => {
    expect(confirmationCardModel(webmcpCategorize).sourceLabel).toBe('this page (WebMCP)');
    expect(confirmationCardModel({ ...webmcpCategorize, source: 'http-mcp' }).sourceLabel).toBe('external MCP client');
    expect(confirmationCardModel({ ...webmcpCategorize, source: 'chat' }).sourceLabel).toBe('dashboard chat');
    expect(confirmationCardModel({ ...webmcpCategorize, source: 'whatever-new' }).sourceLabel).toBe('this page (WebMCP)');
  });
});

describe('confirmationCardModel — summary line (the semantic context)', () => {
  test('passes the server-computed summary through untouched', () => {
    const model = confirmationCardModel(webmcpCategorize);
    expect(model.summary).toBe('Categorize "MAPLE AVE APARTMENTS RENT" (2026-08-01) as "Home"');
  });

  test('chat-shaped ops (summary null) degrade to null without throwing', () => {
    const model = confirmationCardModel({
      source: 'chat',
      tool_name: 'categorize',
      summary: null,
      before_json: null,
      after_json: null,
    });
    expect(model.summary).toBeNull();
    expect(model.deltaRows).toBeNull(); // → "No structured delta available for this action."
  });
});

describe('confirmationCardModel — delta rows', () => {
  test('from/to values with formatValue parity: null renders as —, objects as JSON', () => {
    const model = confirmationCardModel(webmcpCategorize);
    expect(model.deltaRows).toEqual({
      rows: [
        { field: 'category', from: '—', to: 'Home' },
        { field: 'entity_id', from: '—', to: '—' },
      ],
    });
  });

  test('a tax-flag shape renders its before/after objects as JSON strings', () => {
    const model = confirmationCardModel({
      source: 'webmcp',
      tool_name: 'tax_flag',
      summary: 'Flag "X" (2026-08-01) as tax-deductible: Meals',
      before_json: null,
      after_json: JSON.stringify({ irs_category: 'Meals', tax_year: 2026, notes: null }),
    });
    expect(model.deltaRows?.rows).toEqual([
      { field: 'irs_category', from: '—', to: 'Meals' },
      { field: 'tax_year', from: '—', to: '2026' },
      { field: 'notes', from: '—', to: '—' },
    ]);
  });

  test('a delta with no changed fields yields an empty row set (→ "No fields changed.")', () => {
    const model = confirmationCardModel({
      source: 'webmcp',
      tool_name: 'edit_transaction',
      before_json: '{}',
      after_json: '{}',
      summary: 'Edit transaction #7: X',
    });
    expect(model.deltaRows).toEqual({ rows: [] });
  });

  test('formatValue rules match the bridge display contract', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(3200)).toBe('3200');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue('Home')).toBe('Home');
  });

  test('the model never emits raw JSON blobs as row values for scalar fields', () => {
    const model = confirmationCardModel(webmcpCategorize);
    for (const row of model.deltaRows?.rows ?? []) {
      expect(row.from.startsWith('{')).toBe(false);
      expect(row.to.startsWith('{')).toBe(false);
    }
  });
});