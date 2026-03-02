import { describe, expect, test } from 'bun:test';
import { buildCategorizationPrompt } from '../tools/categorize/prompt.js';

describe('buildCategorizationPrompt', () => {
  const sampleTxns = [
    { id: 1, description: 'WHOLE FOODS MARKET', amount: -85.50, date: '2026-02-15' },
    { id: 2, description: 'NETFLIX.COM', amount: -15.99, date: '2026-02-18' },
  ];

  test('output contains category list', () => {
    const prompt = buildCategorizationPrompt(sampleTxns);
    expect(prompt).toContain('Dining');
    expect(prompt).toContain('Groceries');
    expect(prompt).toContain('Shopping');
  });

  test('output contains transaction data as JSON', () => {
    const prompt = buildCategorizationPrompt(sampleTxns);
    expect(prompt).toContain('"id": 1');
    expect(prompt).toContain('"description": "WHOLE FOODS MARKET"');
    expect(prompt).toContain('"amount": -85.5');
  });

  test('escapes quotes in descriptions', () => {
    const txns = [{ id: 1, description: 'JOHN "JACK" DOE', amount: -10, date: '2026-01-01' }];
    const prompt = buildCategorizationPrompt(txns);
    expect(prompt).toContain('\\"JACK\\"');
  });

  test('includes JSON response format instructions', () => {
    const prompt = buildCategorizationPrompt(sampleTxns);
    expect(prompt).toContain('"transactions"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"confidence"');
  });

  test('includes rules about sign convention', () => {
    const prompt = buildCategorizationPrompt(sampleTxns);
    expect(prompt).toContain('Negative amounts are expenses');
  });
});
