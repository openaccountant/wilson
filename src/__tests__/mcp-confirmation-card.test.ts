import { describe, expect, test } from 'bun:test';
import { MCP_TOOL_CATALOG } from '../mcp/tool-catalog.js';
import { confirmationCardModel, formatValue, holdProgress, outcomeCopy } from '../mcp/confirmation-card.js';

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
      confirmationCardModel({ ...webmcpCategorize, tool_name: 'update_transaction' }).title,
    ).toBe('Update Transaction');
    expect(confirmationCardModel({ ...webmcpCategorize, tool_name: 'set_tax_flag' }).title).toBe('Set Tax Flag');
  });

  test('I4: chat cards read exactly as they did before the rename (chat names are chat tools, not catalog names)', () => {
    const chat = { ...webmcpCategorize, source: 'chat' };
    expect(confirmationCardModel({ ...chat, tool_name: 'tax_flag' }).title).toBe('Tax Flag');
    expect(confirmationCardModel({ ...chat, tool_name: 'edit_transaction' }).title).toBe('Edit Transaction');
    // A chat tool the labels never knew keeps falling back to its raw name, and a chat row never resolves a catalog label.
    expect(confirmationCardModel({ ...chat, tool_name: 'categorize' }).title).toBe('categorize');
    expect(confirmationCardModel({ ...chat, tool_name: 'set_tax_flag' }).title).toBe('set_tax_flag');
  });

  test('I4: a history row with a retired name gets the label of its current name (non-chat only)', () => {
    expect(confirmationCardModel({ ...webmcpCategorize, tool_name: 'tax_flag' }).title).toBe('Set Tax Flag');
    expect(confirmationCardModel({ ...webmcpCategorize, source: 'http-mcp', tool_name: 'edit_transaction' }).title).toBe('Update Transaction');
    expect(confirmationCardModel({ ...webmcpCategorize, tool_name: 'judge_interaction' }).title).toBe('Propose Judgment');
  });

  test('every catalog tool has a label keyed by its current name', () => {
    // get_operation_result never raised a card and never had a label (it is /mcp-only); every other tool has one.
    for (const def of MCP_TOOL_CATALOG.filter((d) => d.name !== 'get_operation_result')) {
      expect(confirmationCardModel({ ...webmcpCategorize, tool_name: def.name }).title).not.toBe(def.name);
    }
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
      tool_name: 'set_tax_flag',
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
      tool_name: 'update_transaction',
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
describe('confirmationCardModel — requested by (server-derived)', () => {
  test('the server-derived label wins over the source-based fallback', () => {
    const model = confirmationCardModel({ ...webmcpCategorize, requestedBy: { kind: 'another_tab', label: 'another tab (…ab12)' } });
    expect(model.sourceLabel).toBe('another tab (…ab12)');
  });

  test('a card for another tab is never labelled "this page"', () => {
    const model = confirmationCardModel({ ...webmcpCategorize, requestedBy: { kind: 'another_tab', label: 'another tab (…ab12)' } });
    expect(model.sourceLabel).not.toContain('this page');
    expect(confirmationCardModel({ ...webmcpCategorize, requestedBy: { kind: 'this_tab', label: 'this tab' } }).sourceLabel).toBe('this tab');
  });

  test('without requestedBy the old source labels still apply', () => {
    expect(confirmationCardModel({ ...webmcpCategorize, requestedBy: null }).sourceLabel).toBe('this page (WebMCP)');
  });

  test('get_tax_summary has a label, though a read never raises a card', () => {
    expect(confirmationCardModel({ ...webmcpCategorize, tool_name: 'get_tax_summary' }).title).toBe('Tax Summary');
  });
});

describe('outcomeCopy', () => {
  test('every way an operation can end has plain copy, including cancelled and expired', () => {
    for (const outcome of ['committed', 'rejected', 'stale', 'expired', 'cancelled', 'unknown', 'anything-else']) {
      expect(outcomeCopy(outcome).length).toBeGreaterThan(10);
    }
    expect(outcomeCopy('expired')).toContain('expired');
    expect(outcomeCopy('cancelled')).toContain('withdrew');
    expect(outcomeCopy('committed')).toContain('applied');
    expect(outcomeCopy('expired')).toContain('Nothing was changed');
  });
});

describe('P1 card hardening', () => {
  const readOp = {
    source: 'webmcp',
    tool_name: 'search_transactions',
    kind: 'read',
    summary: null,
    before_json: null,
    after_json: null,
    read: {
      args: { query: 'dining over $50' },
      filter: [{ label: 'Category', value: 'Dining' }, { label: 'Amount at least', value: '50' }],
    },
  };

  test('a read-ask card is titled "Allow read: ..." in the amber variant; a change is "Confirm: ..." in the default one', () => {
    const read = confirmationCardModel(readOp);
    expect(read.heading).toBe('Allow read: Search Transactions');
    expect(read.variant).toBe('read');
    expect(read.tone).toBe('amber');
    const change = confirmationCardModel(webmcpCategorize);
    expect(change.heading).toBe('Confirm: Categorize Transaction');
    expect(change.variant).toBe('change');
    expect(change.tone).toBe('default');
    expect(read.title).toBe('Search Transactions'); // title stays the bare label
  });

  test('a read card shows the parsed filter rows and the full canonical args, never a truncated prefix', () => {
    const long = 'dining ' + 'y'.repeat(190);
    const model = confirmationCardModel({ ...readOp, read: { args: { query: long, limit: 5 }, filter: readOp.read.filter } });
    expect(model.filterRows).toEqual(readOp.read.filter);
    expect(model.argsBlock).toContain(long);
    expect(model.argsBlock).toContain('"limit": 5');
    expect(model.deltaRows).toBeNull(); // a read has no from/to
  });

  test('every read tool has a label', () => {
    for (const [tool, label] of [['get_spending_summary', 'Spending Summary'], ['get_profit_loss', 'Profit & Loss'], ['get_net_worth', 'Net Worth'], ['get_cash_forecast', 'Cash Forecast']]) {
      expect(confirmationCardModel({ ...readOp, tool_name: tool }).title).toBe(label);
    }
  });

  test('bankDataRow is split from the summary: sanitized, bounded, and absent from the summary line', () => {
    const op = {
      ...webmcpCategorize,
      summary: 'Categorize transaction #42 (2026-08-01) as "Home"',
      bank_data: `"RENT\u202E ${'x'.repeat(200)}"`,
    };
    const model = confirmationCardModel(op);
    expect(model.bankDataRow).not.toBeNull();
    expect(model.bankDataRow!.length).toBeLessThanOrEqual(64);
    expect(model.bankDataRow).not.toContain('\u202E');
    expect(model.summary).toBe('Categorize transaction #42 (2026-08-01) as "Home"');
    expect(model.summary).not.toContain('RENT');
    expect(confirmationCardModel(webmcpCategorize).bankDataRow).toBeNull();
  });

  test('the dwell and hold timings are part of the model', () => {
    const model = confirmationCardModel(webmcpCategorize);
    expect(model.holdMs).toBe(600);
    expect(model.enableAfterMs).toBe(800);
  });

  test('holdProgress runs 0..1 over holdMs and never leaves that range', () => {
    expect(holdProgress(1000, 1000, 600)).toBe(0);
    expect(holdProgress(1000, 1300, 600)).toBeCloseTo(0.5);
    expect(holdProgress(1000, 1600, 600)).toBe(1);
    expect(holdProgress(1000, 9999, 600)).toBe(1);
    expect(holdProgress(1000, 500, 600)).toBe(0);
  });

  test('"Requested by" renders the server-derived label for another tab', () => {
    const model = confirmationCardModel({ ...webmcpCategorize, requestedBy: { kind: 'another_tab', label: 'another tab (…abcd)' } });
    expect(model.sourceLabel).toBe('another tab (…abcd)');
    expect(model.requestedByLine).toBe('Requested by: another tab (…abcd)');
  });

  test('approval_too_fast has copy that tells the user to wait', () => {
    expect(outcomeCopy('approval_too_fast').toLowerCase()).toContain('wait');
  });
});

describe('P4a judge proposal card', () => {
  const proposal = {
    source: 'webmcp',
    tool_name: 'propose_judgments',
    kind: 'proposal',
    summary: 'Add 3 proposed judgements (not used for training until you accept)',
    before_json: null,
    after_json: JSON.stringify({ judgements: 3, interactions: '#12, #13, #14', ratings: '4, 2, 5', 'judge model (declared by agent)': 'claude-test', rubric: 'a1b2c3d4e5f6' }),
  };

  test('is a change card ("Confirm: Propose Judgments") with the server sentence and the declared model as a delta row', () => {
    const model = confirmationCardModel(proposal);
    expect(model.heading).toBe('Confirm: Propose Judgments');
    expect(model.variant).toBe('change');
    expect(model.summary).toBe('Add 3 proposed judgements (not used for training until you accept)');
    const fields = model.deltaRows!.rows.map((r) => r.field);
    expect(fields).toContain('judge model (declared by agent)');
    expect(fields).not.toContain('rationale');
  });

  test('every judge tool has a label', () => {
    for (const [tool, label] of [
      ['list_interactions', 'List Interactions'],
      ['get_interaction', 'Get Interaction'],
      ['get_judge_rubric', 'Get Judge Rubric'],
      ['propose_judgments', 'Propose Judgments'],
      ['propose_judgment', 'Propose Judgment'],
    ]) {
      expect(confirmationCardModel({ ...proposal, tool_name: tool }).title).toBe(label);
    }
  });
});
