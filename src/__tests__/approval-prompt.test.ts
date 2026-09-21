import { describe, expect, test } from 'bun:test';
import { describeApproval, ApprovalPromptComponent } from '../components/approval-prompt.js';

describe('describeApproval', () => {
  test('renders a real before/after delta when one is provided', () => {
    const lines = describeApproval(
      { id: 1, category: 'Entertainment' },
      { before: { category: 'Groceries' }, after: { category: 'Entertainment' } }
    );
    expect(lines.join('\n')).toContain('category: Groceries');
    expect(lines.join('\n')).toContain('Entertainment');
  });

  test('falls back to listing arguments when no delta is available (e.g. the bulk categorize tool)', () => {
    const lines = describeApproval({ limit: 25, entityId: 3 });
    expect(lines.some((l) => l.includes('limit') && l.includes('25'))).toBe(true);
    expect(lines.some((l) => l.includes('entityId') && l.includes('3'))).toBe(true);
    // The old component hardcoded args.path — nothing here references "path".
    expect(lines.some((l) => l.includes('path'))).toBe(false);
  });

  test('never crashes or shows "<unknown>" for a tool call with no path-like argument', () => {
    const lines = describeApproval({ transactionId: 42, irsCategory: 'Office Supplies' });
    expect(lines.join(' ')).not.toContain('<unknown>');
  });

  test('handles an empty args object', () => {
    expect(describeApproval({})).toEqual(['(no arguments)']);
  });
});

describe('ApprovalPromptComponent', () => {
  test('constructs without a delta (legacy call shape) without throwing', () => {
    expect(() => new ApprovalPromptComponent('categorize', { limit: 10 })).not.toThrow();
  });

  test('constructs with a delta without throwing', () => {
    expect(
      () =>
        new ApprovalPromptComponent('categorize_transaction', { id: 1, category: 'Dining' }, {
          before: { category: 'Groceries' },
          after: { category: 'Dining' },
        })
    ).not.toThrow();
  });
});
