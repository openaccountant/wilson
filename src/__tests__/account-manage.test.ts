import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { initAccountManageTool, accountManageTool } from '../tools/net-worth/account-manage.js';
import { getAccountById, getAccounts } from '../db/net-worth-queries.js';

describe('account_manage tool', () => {
  function setup() {
    const db = createTestDb();
    initAccountManageTool(db);
    return db;
  }

  function parse(result: string) {
    return JSON.parse(result).data;
  }

  // ── Add ─────────────────────────────────────────────────────────────────

  test('add checking account', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'add',
      name: 'Chase Checking',
      accountSubtype: 'checking',
      institution: 'Chase',
      accountNumberLast4: '4567',
      currentBalance: 15000,
    });

    const data = parse(result);
    expect(data.message).toContain('Chase Checking');
    expect(data.message).toContain('Checking');
    expect(data.account.account_type).toBe('asset');
    expect(data.account.account_subtype).toBe('checking');
    expect(data.account.current_balance).toBe(15000);
  });

  test('add real estate asset', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'add',
      name: 'Primary Residence',
      accountSubtype: 'real_estate',
      currentBalance: 400000,
    });

    const data = parse(result);
    expect(data.account.account_type).toBe('asset');
    expect(data.account.account_subtype).toBe('real_estate');
    expect(data.account.current_balance).toBe(400000);
  });

  test('add liability account', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'add',
      name: 'Home Mortgage',
      accountSubtype: 'mortgage',
      institution: 'Wells Fargo',
      currentBalance: 300000,
    });

    const data = parse(result);
    expect(data.account.account_type).toBe('liability');
    expect(data.account.account_subtype).toBe('mortgage');
  });

  test('add requires name', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'add',
      accountSubtype: 'checking',
    });
    const data = parse(result);
    expect(data.error).toContain('name is required');
  });

  test('add requires accountSubtype', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'add',
      name: 'Test',
    });
    const data = parse(result);
    expect(data.error).toContain('accountSubtype is required');
  });

  // ── Update ──────────────────────────────────────────────────────────────

  test('update account', async () => {
    const db = setup();
    // Create account first
    await accountManageTool.func({
      action: 'add',
      name: 'Old Name',
      accountSubtype: 'savings',
      currentBalance: 1000,
    });

    const accounts = getAccounts(db);
    const id = accounts[0].id;

    const result = await accountManageTool.func({
      action: 'update',
      accountId: id,
      name: 'Emergency Fund',
      currentBalance: 5000,
    });

    const data = parse(result);
    expect(data.message).toContain('updated');
    expect(data.account.name).toBe('Emergency Fund');
    expect(data.account.current_balance).toBe(5000);
  });

  test('update requires accountId', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'update',
      name: 'Nope',
    });
    const data = parse(result);
    expect(data.error).toContain('accountId is required');
  });

  test('update nonexistent account', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'update',
      accountId: 999,
      name: 'Nope',
    });
    const data = parse(result);
    expect(data.error).toContain('not found');
  });

  // ── Remove ──────────────────────────────────────────────────────────────

  test('remove (deactivate) account', async () => {
    const db = setup();
    await accountManageTool.func({
      action: 'add',
      name: 'To Remove',
      accountSubtype: 'checking',
    });

    const accounts = getAccounts(db);
    const id = accounts[0].id;

    const result = await accountManageTool.func({
      action: 'remove',
      accountId: id,
    });

    const data = parse(result);
    expect(data.message).toContain('deactivated');

    // Should be inactive
    const account = getAccountById(db, id);
    expect(account!.is_active).toBe(0);
  });

  test('remove requires accountId', async () => {
    setup();
    const result = await accountManageTool.func({
      action: 'remove',
    });
    const data = parse(result);
    expect(data.error).toContain('accountId is required');
  });

  // ── List ────────────────────────────────────────────────────────────────

  test('list all accounts', async () => {
    setup();
    await accountManageTool.func({ action: 'add', name: 'Checking', accountSubtype: 'checking', currentBalance: 5000 });
    await accountManageTool.func({ action: 'add', name: 'House', accountSubtype: 'real_estate', currentBalance: 400000 });
    await accountManageTool.func({ action: 'add', name: 'Mortgage', accountSubtype: 'mortgage', currentBalance: 300000 });

    const result = await accountManageTool.func({ action: 'list' });
    const data = parse(result);
    expect(data.count).toBe(3);
    expect(data.accounts.length).toBe(3);
  });

  test('list with type filter', async () => {
    setup();
    await accountManageTool.func({ action: 'add', name: 'Checking', accountSubtype: 'checking', currentBalance: 5000 });
    await accountManageTool.func({ action: 'add', name: 'Mortgage', accountSubtype: 'mortgage', currentBalance: 300000 });

    const result = await accountManageTool.func({ action: 'list', type: 'liability' });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.accounts[0].name).toBe('Mortgage');
  });

  test('list excludes deactivated accounts', async () => {
    const db = setup();
    await accountManageTool.func({ action: 'add', name: 'Active', accountSubtype: 'checking' });
    await accountManageTool.func({ action: 'add', name: 'Inactive', accountSubtype: 'savings' });

    const accounts = getAccounts(db);
    const inactiveId = accounts.find((a) => a.name === 'Inactive')!.id;
    await accountManageTool.func({ action: 'remove', accountId: inactiveId });

    const result = await accountManageTool.func({ action: 'list' });
    const data = parse(result);
    expect(data.count).toBe(1);
    expect(data.accounts[0].name).toBe('Active');
  });
});
