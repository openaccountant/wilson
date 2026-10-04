import { describe, expect, test } from 'bun:test';
import { parseDbTimestamp } from '../dashboard/ui/src/format.js';

describe('parseDbTimestamp', () => {
  test('treats zone-less SQLite datetime as UTC', () => {
    expect(parseDbTimestamp('2026-10-02 23:45:56').toISOString()).toBe('2026-10-02T23:45:56.000Z');
  });

  test('leaves ISO strings with Z untouched', () => {
    expect(parseDbTimestamp('2026-03-05T02:33:58.976Z').toISOString()).toBe('2026-03-05T02:33:58.976Z');
  });

  test('respects explicit offsets', () => {
    expect(parseDbTimestamp('2026-10-02T19:45:56-04:00').toISOString()).toBe('2026-10-02T23:45:56.000Z');
  });
});
