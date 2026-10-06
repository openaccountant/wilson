import { describe, expect, test } from 'bun:test';
import { describeApproval, ApprovalPromptComponent, sessionApprovalLabel } from '../components/approval-prompt.js';
import { approvalSelectorItems } from '../components/select-list.js';

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

describe('approval selector (#152)', () => {
  test('the session option names the one tool it covers, not "all edits"', () => {
    const items = approvalSelectorItems('Delete Transaction');
    expect(items.map((i) => i.value)).toEqual(['allow-once', 'allow-session', 'deny']);
    const session = items.find((i) => i.value === 'allow-session')!;
    expect(session.label).toContain('Delete Transaction');
    expect(session.label).not.toContain('all edits');
  });
});


describe('approval selector session scope (#152)', () => {
  test('an action-scoped approval names the action it covers', () => {
    const session = approvalSelectorItems('Memory Manage (add)').find((i) => i.value === 'allow-session')!;
    expect(session.label).toContain('Memory Manage (add)');
  });

  test('chain/team approvals (no session scope) offer only yes / no', () => {
    const items = approvalSelectorItems(null);
    expect(items.map((i) => i.value)).toEqual(['allow-once', 'deny']);
    expect(items.map((i) => i.label)).toEqual(['1. Yes', '2. No']);
  });

  test('sessionApprovalLabel formats the scope for the prompt', () => {
    expect(sessionApprovalLabel('memory_manage', { key: 'memory_manage:add', action: 'add' })).toBe('Memory Manage (add)');
    expect(sessionApprovalLabel('delete_transaction', { key: 'delete_transaction' })).toBe('Delete Transaction');
    expect(sessionApprovalLabel('chain_imp', null)).toBeNull();
  });

  test('the prompt constructs for a chain call with no session option', () => {
    expect(() => new ApprovalPromptComponent('chain_imp', { input: 'x' }, undefined, null)).not.toThrow();
  });
});
