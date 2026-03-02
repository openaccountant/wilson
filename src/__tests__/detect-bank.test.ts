import { describe, expect, test } from 'bun:test';
import { detectBank, detectFormat } from '../tools/import/detect-bank.js';

describe('detectBank', () => {
  test('detects Chase from headers', () => {
    expect(detectBank(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'])).toBe('chase');
  });

  test('detects Chase with Transaction Date + Category (no Post Date)', () => {
    expect(detectBank(['Transaction Date', 'Description', 'Category', 'Amount'])).toBe('chase');
  });

  test('detects Amex from headers', () => {
    expect(detectBank(['Date', 'Description', 'Card Member', 'Account #', 'Amount'])).toBe('amex');
  });

  test('detects Amex with Account # only', () => {
    expect(detectBank(['Date', 'Description', 'Account #', 'Amount'])).toBe('amex');
  });

  test('detects BofA checking from headers', () => {
    expect(detectBank(['Date', 'Description', 'Amount', 'Running Bal.'])).toBe('bofa');
  });

  test('detects BofA credit card from headers', () => {
    expect(detectBank(['Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'])).toBe('bofa-cc');
  });

  test('returns generic for unknown headers', () => {
    expect(detectBank(['Col1', 'Col2', 'Col3'])).toBe('generic');
  });

  test('case-insensitive header matching', () => {
    expect(detectBank(['transaction date', 'post date', 'description', 'category', 'type', 'amount'])).toBe('chase');
  });
});

describe('detectFormat', () => {
  test('detects OFX v1 (SGML) by OFXHEADER:', () => {
    expect(detectFormat('OFXHEADER:100\nDATA:OFXSGML')).toEqual({ format: 'ofx', bank: 'ofx' });
  });

  test('detects OFX v2 (XML) by <?OFX', () => {
    expect(detectFormat('<?OFX version="200"?>')).toEqual({ format: 'ofx', bank: 'ofx' });
  });

  test('detects QIF by !Type:', () => {
    expect(detectFormat('!Type:Bank\nD01/15/2026\nT-50.00')).toEqual({ format: 'qif', bank: 'qif' });
  });

  test('detects QIF by D-date pattern', () => {
    expect(detectFormat('D01/15/2026\nT-50.00')).toEqual({ format: 'qif', bank: 'qif' });
  });

  test('detects CSV Chase format', () => {
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount\n02/15/2026,02/16/2026,STORE,Shopping,Sale,-10';
    const result = detectFormat(csv);
    expect(result.format).toBe('csv');
    expect(result.bank).toBe('chase');
  });

  test('falls back to generic CSV for unknown headers', () => {
    const csv = 'Date,Memo,Value\n2026-01-01,Test,-10';
    const result = detectFormat(csv);
    expect(result.format).toBe('csv');
    expect(result.bank).toBe('generic');
  });
});
