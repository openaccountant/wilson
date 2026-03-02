import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { createTestDb } from './helpers.js';
import { initMortgageManageTool, mortgageManageTool } from '../tools/net-worth/mortgage-manage.js';
import { insertAccount } from '../db/net-worth-queries.js';
import * as licenseModule from '../licensing/license.js';
import type { Database } from '../db/compat-sqlite.js';

describe('mortgage_manage tool', () => {
  let db: Database;
  let mortgageAccountId: number;
  let houseAccountId: number;
  let licenseSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = createTestDb();
    initMortgageManageTool(db);
    licenseSpy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);

    // Create asset and liability accounts for testing
    houseAccountId = insertAccount(db, {
      name: 'House',
      account_type: 'asset',
      account_subtype: 'real_estate',
      current_balance: 400000,
    });

    mortgageAccountId = insertAccount(db, {
      name: 'Home Mortgage',
      account_type: 'liability',
      account_subtype: 'mortgage',
      current_balance: 300000,
    });
  });

  afterEach(() => {
    licenseSpy.mockRestore();
  });

  function parse(result: string) {
    return JSON.parse(result).data;
  }

  // ── Add ─────────────────────────────────────────────────────────────────

  test('add loan', async () => {
    const result = await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,  // User-friendly percentage
      termMonths: 360,
      startDate: '2024-01-01',
      linkedAssetId: houseAccountId,
    });

    const data = parse(result);
    expect(data.message).toContain('Loan');
    expect(data.message).toContain('Home Mortgage');
    expect(data.monthlyPayment).toBeCloseTo(1896.20, 0);
    expect(data.payoffMonths).toBe(360);
    expect(data.totalInterest).toBeGreaterThan(0);
    expect(data.totalPaid).toBeGreaterThan(300000);
  });

  test('add requires accountId', async () => {
    const result = await mortgageManageTool.func({
      action: 'add',
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });
    const data = parse(result);
    expect(data.error).toContain('accountId is required');
  });

  test('add requires all fields', async () => {
    const fields = ['originalPrincipal', 'interestRate', 'termMonths', 'startDate'];
    for (const field of fields) {
      const args: Record<string, unknown> = {
        action: 'add',
        accountId: mortgageAccountId,
        originalPrincipal: 300000,
        interestRate: 6.5,
        termMonths: 360,
        startDate: '2024-01-01',
      };
      delete args[field];
      const result = await mortgageManageTool.func(args as Parameters<typeof mortgageManageTool.func>[0]);
      const data = parse(result);
      expect(data.error).toBeDefined();
    }
  });

  test('add rejects asset account', async () => {
    const result = await mortgageManageTool.func({
      action: 'add',
      accountId: houseAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });
    const data = parse(result);
    expect(data.error).toContain('liability');
  });

  test('add rejects nonexistent account', async () => {
    const result = await mortgageManageTool.func({
      action: 'add',
      accountId: 999,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });
    const data = parse(result);
    expect(data.error).toContain('not found');
  });

  // ── Update ──────────────────────────────────────────────────────────────

  test('update loan', async () => {
    // Create loan first
    await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const result = await mortgageManageTool.func({
      action: 'update',
      accountId: mortgageAccountId,
      extraPayment: 500,
      notes: 'Added extra payment',
    });

    const data = parse(result);
    expect(data.message).toContain('updated');
  });

  test('update nonexistent loan', async () => {
    const result = await mortgageManageTool.func({
      action: 'update',
      accountId: mortgageAccountId,
      extraPayment: 500,
    });
    const data = parse(result);
    expect(data.error).toContain('No loan found');
  });

  // ── Schedule ────────────────────────────────────────────────────────────

  test('schedule shows amortization', async () => {
    await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const result = await mortgageManageTool.func({
      action: 'schedule',
      accountId: mortgageAccountId,
      showMonths: 12,
    });

    const data = parse(result);
    expect(data.payments.length).toBe(12);
    expect(data.monthlyPayment).toBeCloseTo(1896.20, 0);
    expect(data.payments[0].date).toBe('2024-02-01');
    // First payment: interest > principal
    expect(data.payments[0].interest).toBeGreaterThan(data.payments[0].principal);
  });

  test('schedule shows all months by default', async () => {
    await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const result = await mortgageManageTool.func({
      action: 'schedule',
      accountId: mortgageAccountId,
    });

    const data = parse(result);
    expect(data.payments.length).toBe(360);
  });

  // ── Summary ─────────────────────────────────────────────────────────────

  test('summary with no loans', async () => {
    const result = await mortgageManageTool.func({
      action: 'summary',
    });
    const data = parse(result);
    expect(data.message).toContain('No loans');
  });

  test('summary lists all loans', async () => {
    const carAccountId = insertAccount(db, {
      name: 'Car Loan',
      account_type: 'liability',
      account_subtype: 'auto_loan',
      current_balance: 25000,
    });

    await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    await mortgageManageTool.func({
      action: 'add',
      accountId: carAccountId,
      originalPrincipal: 25000,
      interestRate: 4.9,
      termMonths: 60,
      startDate: '2025-01-01',
    });

    const result = await mortgageManageTool.func({
      action: 'summary',
    });

    const data = parse(result);
    expect(data.count).toBe(2);
    expect(data.loans[0].principal).toBe(300000);
    expect(data.loans[0].rate).toBe('6.50%');
  });

  // ── Payoff ──────────────────────────────────────────────────────────────

  test('payoff simulation', async () => {
    await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const result = await mortgageManageTool.func({
      action: 'payoff',
      accountId: mortgageAccountId,
      extraPayment: 500,
    });

    const data = parse(result);
    expect(data.withoutExtra.payoffMonths).toBe(360);
    expect(data.withExtra.payoffMonths).toBeLessThan(360);
    expect(data.withExtra.extraPerMonth).toBe(500);
    expect(data.savings.monthsSaved).toBeGreaterThan(0);
    expect(data.savings.interestSaved).toBeGreaterThan(0);
  });

  test('payoff with no extra payment shows same result', async () => {
    await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 300000,
      interestRate: 6.5,
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const result = await mortgageManageTool.func({
      action: 'payoff',
      accountId: mortgageAccountId,
    });

    const data = parse(result);
    expect(data.withoutExtra.payoffMonths).toBe(data.withExtra.payoffMonths);
    expect(data.savings.monthsSaved).toBe(0);
    expect(data.savings.interestSaved).toBeCloseTo(0, 0);
  });

  // ── Rate conversion ─────────────────────────────────────────────────────

  test('rate converted from percentage to decimal', async () => {
    const result = await mortgageManageTool.func({
      action: 'add',
      accountId: mortgageAccountId,
      originalPrincipal: 100000,
      interestRate: 5.0,  // 5% as user input
      termMonths: 360,
      startDate: '2024-01-01',
    });

    const data = parse(result);
    expect(data.message).toContain('Loan');

    // Verify the stored rate is decimal
    const loan = db.prepare('SELECT interest_rate FROM loans WHERE account_id = @accountId').get({ accountId: mortgageAccountId }) as { interest_rate: number };
    expect(loan).toBeDefined();
    expect(loan.interest_rate).toBe(0.05);
  });
});
