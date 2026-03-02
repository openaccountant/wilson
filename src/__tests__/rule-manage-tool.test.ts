import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initRuleManageTool, ruleManageTool } from '../tools/rules/rule-manage.js';
import { createTestDb } from './helpers.js';

describe('rule_manage tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initRuleManageTool(db);
  });

  test('add creates a new rule', async () => {
    const raw = await ruleManageTool.func({ action: 'add', pattern: '*AMAZON*', category: 'Shopping' });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('Rule #');
    expect(result.data.rule.pattern).toBe('*AMAZON*');
    expect(result.data.rule.category).toBe('Shopping');
  });

  test('list returns all rules', async () => {
    await ruleManageTool.func({ action: 'add', pattern: '*COFFEE*', category: 'Dining' });
    await ruleManageTool.func({ action: 'add', pattern: '*GAS*', category: 'Transportation' });

    const raw = await ruleManageTool.func({ action: 'list' });
    const result = JSON.parse(raw as string);
    expect(result.data.rules).toHaveLength(2);
  });

  test('update modifies an existing rule', async () => {
    const addRaw = await ruleManageTool.func({ action: 'add', pattern: '*STARBUCKS*', category: 'Dining' });
    const addResult = JSON.parse(addRaw as string);
    const ruleId = addResult.data.rule.id;

    const raw = await ruleManageTool.func({ action: 'update', ruleId, category: 'Coffee', priority: 5 });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);

    const listRaw = await ruleManageTool.func({ action: 'list' });
    const listResult = JSON.parse(listRaw as string);
    const updated = listResult.data.rules.find((r: any) => r.id === ruleId);
    expect(updated.category).toBe('Coffee');
    expect(updated.priority).toBe(5);
  });

  test('delete removes a rule', async () => {
    const addRaw = await ruleManageTool.func({ action: 'add', pattern: '*TEST*', category: 'Other' });
    const addResult = JSON.parse(addRaw as string);
    const ruleId = addResult.data.rule.id;

    const raw = await ruleManageTool.func({ action: 'delete', ruleId });
    const result = JSON.parse(raw as string);
    expect(result.data.success).toBe(true);

    // Delete again returns false
    const raw2 = await ruleManageTool.func({ action: 'delete', ruleId });
    const result2 = JSON.parse(raw2 as string);
    expect(result2.data.success).toBe(false);
  });

  test('add without pattern returns error', async () => {
    const raw = await ruleManageTool.func({ action: 'add', category: 'Shopping' });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('pattern');
  });

  test('add without category returns error', async () => {
    const raw = await ruleManageTool.func({ action: 'add', pattern: '*STORE*' });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('category');
  });

  test('update without ruleId returns error', async () => {
    const raw = await ruleManageTool.func({ action: 'update', category: 'Test' });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('ruleId');
  });

  test('delete without ruleId returns error', async () => {
    const raw = await ruleManageTool.func({ action: 'delete' });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('ruleId');
  });

  test('list on empty DB returns no rules message', async () => {
    const raw = await ruleManageTool.func({ action: 'list' });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('No categorization rules');
  });
});
