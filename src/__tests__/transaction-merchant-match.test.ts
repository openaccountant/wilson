import { beforeAll, describe, expect, test } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { getTransactions, insertTransactions } from '../db/queries.js';
import { parseNaturalQueryAt } from '../tools/read-core/nl-query.js';
import { createTestDb } from './helpers.js';

/**
 * Round 4 search precision (specs/DECISIONS.md "Round 4", item 4). The merchant filter matched its
 * term ANYWHERE in the description, so a short term hit the middle of an unrelated word
 * ("car" in "CHILDCARE"). A term now has to START a word of the description. The matcher is shared
 * (src/db/transaction-where.ts), so the server tool and the offline mirror stay identical.
 */

const DESCRIPTIONS = [
  'AUTO LOAN PAYMENT - CARMAX FINANCIAL',
  'SUNRISE CHILDCARE CENTER',
  'SCARBOROUGH FAIR TICKETS',
  'STARBUCKS #1234 SEATTLE',
  'UBER*TRIP HELP.UBER.COM',
  'SQ *BLUE BOTTLE COFFEE',
  'PAYPAL *EBAY',
  'APPLE.COM/BILL',
  'WHOLE FOODS MARKET #10',
  'CVS/PHARMACY #0123',
];

let db: Database;
beforeAll(() => {
  db = createTestDb();
  insertTransactions(
    db,
    DESCRIPTIONS.map((description, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      description,
      amount: -10 - i,
      category: 'Other',
      file_hash: `h${i}`,
    }))
  );
});

const hits = (merchant: string): string[] => getTransactions(db, { merchant }).map((t) => t.description).sort();

describe('merchant filter: the term must start a word', () => {
  test('a short term does not match the middle of an unrelated word', () => {
    expect(hits('car')).toEqual(['AUTO LOAN PAYMENT - CARMAX FINANCIAL']);
  });
  test('and not inside another word further along either', () => {
    expect(hits('bor')).toEqual([]);
    expect(hits('bucks')).toEqual([]);
  });
  test('a prefix of a word still matches (partial typing keeps working)', () => {
    expect(hits('starbuck')).toEqual(['STARBUCKS #1234 SEATTLE']);
    expect(hits('whole')).toEqual(['WHOLE FOODS MARKET #10']);
    expect(hits('scar')).toEqual(['SCARBOROUGH FAIR TICKETS']);
  });
  test('punctuation separates words: * . / - #', () => {
    expect(hits('uber')).toEqual(['UBER*TRIP HELP.UBER.COM']);
    expect(hits('ebay')).toEqual(['PAYPAL *EBAY']);
    expect(hits('blue bottle')).toEqual(['SQ *BLUE BOTTLE COFFEE']);
    expect(hits('apple')).toEqual(['APPLE.COM/BILL']);
    expect(hits('pharmacy')).toEqual(['CVS/PHARMACY #0123']);
    expect(hits('financial')).toEqual(['AUTO LOAN PAYMENT - CARMAX FINANCIAL']);
  });
  test('case-insensitive, multi-word phrases, first word of the description', () => {
    expect(hits('Whole Foods')).toEqual(['WHOLE FOODS MARKET #10']);
    expect(hits('sunrise childcare')).toEqual(['SUNRISE CHILDCARE CENTER']);
    expect(hits('auto loan')).toEqual(['AUTO LOAN PAYMENT - CARMAX FINANCIAL']);
  });
  test('LIKE wildcards in the term are literal text', () => {
    expect(hits('%')).toEqual([]);
    expect(hits('_')).toEqual([]);
  });
  test('through the natural-language parser: "car payment"-style terms are not substring hits', () => {
    const f = parseNaturalQueryAt('car', new Date('2026-07-15T12:00:00'), []);
    expect(f.merchant).toBe('car');
    expect(getTransactions(db, f).map((t) => t.description)).toEqual(['AUTO LOAN PAYMENT - CARMAX FINANCIAL']);
  });
});
