import { describe, expect, test } from 'bun:test';
import {
  AUTOBOOK_TOOL,
  AUTOBOOK_COPY,
  AUTOBOOK_CONFIRM_WINDOW_MS,
  AUTOBOOK_POLL_INTERVAL_MS,
  pickGrant,
  phaseFor,
  requiresChoice,
} from '../dashboard/ui/src/demo/auto-book.js';

/**
 * The pure client state machine for the Demo tab's auto-book beat. These pin
 * the honest-copy contract: the deny path always *says* nothing changed, and
 * the awaiting path never pretends the section itself can approve.
 */

const GRANTED_TOOLS = [
  { name: 'transaction_search', grantId: 'grant-read' },
  { name: AUTOBOOK_TOOL, grantId: 'grant-cat' },
];

describe('pickGrant', () => {
  test('finds the categorize_transaction grant in the exposed set', () => {
    expect(pickGrant(GRANTED_TOOLS)).toBe('grant-cat');
  });

  test('null when the tool is not exposed (default state is zero tools)', () => {
    expect(pickGrant([{ name: 'transaction_search', grantId: 'x' }])).toBeNull();
    expect(pickGrant([])).toBeNull();
  });
});

describe('requiresChoice', () => {
  test('more than one candidate means the attendee picks first', () => {
    expect(requiresChoice([])).toBe(false);
    expect(requiresChoice([{ id: 1, date: '2026-08-01', description: 'X', amount: 1, category: null }])).toBe(false);
    expect(
      requiresChoice([
        { id: 1, date: '2026-08-01', description: 'X', amount: 1, category: null },
        { id: 2, date: '2026-08-15', description: 'X', amount: 1, category: null },
      ]),
    ).toBe(true);
  });
});

describe('phaseFor', () => {
  test('pending stays awaiting — the card is the only approval surface', () => {
    expect(phaseFor({ status: 'pending' })).toBe('awaiting');
  });

  test('committed → booked; rejected → denied; stale → stale', () => {
    expect(phaseFor({ status: 'committed' })).toBe('booked');
    expect(phaseFor({ status: 'rejected' })).toBe('denied');
    expect(phaseFor({ status: 'stale' })).toBe('stale');
  });

  test('unexpected statuses are an honest error, never a fake success', () => {
    expect(phaseFor({ status: 'expired' })).toBe('error');
    expect(phaseFor({ status: 'something-new' })).toBe('error');
  });
});

describe('the exact status copy (the deny path always says so)', () => {
  test('denied names that nothing changed', () => {
    expect(AUTOBOOK_COPY.denied).toBe('denied — nothing changed');
  });

  test('stale names that nothing was written', () => {
    expect(AUTOBOOK_COPY.stale).toBe('the row changed since you saw it — nothing was written');
  });

  test('awaiting names the card — and there is no in-section approve/deny', () => {
    expect(AUTOBOOK_COPY.awaiting).toBe('confirmation card open — approve or deny there');
    expect(AUTOBOOK_COPY.stillAwaiting).toBe('still awaiting your decision on the confirmation card');
  });

  test('booked names the write; the opt-in copy names the zero-tools default', () => {
    expect(AUTOBOOK_COPY.booked).toBe('booked — category written');
    expect(AUTOBOOK_COPY.needsGrant).toContain('zero tools exposed');
    expect(AUTOBOOK_COPY.pending).toContain('not requested');
  });

  test('the error copy never claims a write happened', () => {
    expect(AUTOBOOK_COPY.error).toContain('nothing was written');
    expect(AUTOBOOK_COPY.noCandidates).toContain('nothing was prepared');
  });
});

describe('timing parity with the substrate', () => {
  test('the confirmation window mirrors OPERATION_TTL_MS and the poll mirrors the bridge', () => {
    expect(AUTOBOOK_CONFIRM_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(AUTOBOOK_POLL_INTERVAL_MS).toBe(800);
  });
});