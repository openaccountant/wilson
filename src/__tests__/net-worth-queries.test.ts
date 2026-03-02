import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import {
  insertAccount,
  updateAccount,
  deactivateAccount,
  getAccounts,
  getAccountById,
  getAccountByPlaidId,
  updateAccountBalance,
  insertBalanceSnapshot,
  insertLoan,
  updateLoan,
  getLoanByAccountId,
  getLoans,
  getNetWorthSummary,
  getNetWorthTrend,
  getEquitySummary,
  linkTransactionsToAccount,
  getAccountTransactionSummary,
} from '../db/net-worth-queries.js';
import { insertTransactions } from '../db/queries.js';

describe('net-worth-queries', () => {
  // ── Account CRUD ──────────────────────────────────────────────────────────

  describe('account CRUD', () => {
    test('insertAccount and getAccountById', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Chase Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        institution: 'Chase',
        account_number_last4: '4567',
        current_balance: 15000,
      });

      expect(id).toBeGreaterThan(0);

      const account = getAccountById(db, id);
      expect(account).toBeDefined();
      expect(account!.name).toBe('Chase Checking');
      expect(account!.account_type).toBe('asset');
      expect(account!.account_subtype).toBe('checking');
      expect(account!.institution).toBe('Chase');
      expect(account!.account_number_last4).toBe('4567');
      expect(account!.current_balance).toBe(15000);
      expect(account!.currency).toBe('USD');
      expect(account!.is_active).toBe(1);
    });

    test('insertAccount with defaults', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Cash',
        account_type: 'asset',
        account_subtype: 'cash',
      });

      const account = getAccountById(db, id);
      expect(account!.current_balance).toBe(0);
      expect(account!.currency).toBe('USD');
      expect(account!.institution).toBeNull();
      expect(account!.account_number_last4).toBeNull();
    });

    test('updateAccount', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Savings',
        account_type: 'asset',
        account_subtype: 'savings',
        current_balance: 1000,
      });

      const updated = updateAccount(db, id, { name: 'Emergency Fund', current_balance: 5000 });
      expect(updated).toBe(true);

      const account = getAccountById(db, id);
      expect(account!.name).toBe('Emergency Fund');
      expect(account!.current_balance).toBe(5000);
    });

    test('updateAccount returns false for nonexistent', () => {
      const db = createTestDb();
      const updated = updateAccount(db, 999, { name: 'Nope' });
      expect(updated).toBe(false);
    });

    test('updateAccount with no changes returns false', () => {
      const db = createTestDb();
      const updated = updateAccount(db, 1, {});
      expect(updated).toBe(false);
    });

    test('deactivateAccount', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Old Account',
        account_type: 'asset',
        account_subtype: 'checking',
      });

      const removed = deactivateAccount(db, id);
      expect(removed).toBe(true);

      const account = getAccountById(db, id);
      expect(account!.is_active).toBe(0);

      // Should not appear in active-only list
      const active = getAccounts(db, { active: true });
      expect(active.find((a) => a.id === id)).toBeUndefined();
    });

    test('getAccounts with type filter', () => {
      const db = createTestDb();
      insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 5000 });
      insertAccount(db, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', current_balance: 400000 });
      insertAccount(db, { name: 'Mortgage', account_type: 'liability', account_subtype: 'mortgage', current_balance: 300000 });

      const assets = getAccounts(db, { type: 'asset' });
      expect(assets.length).toBe(2);

      const liabilities = getAccounts(db, { type: 'liability' });
      expect(liabilities.length).toBe(1);
      expect(liabilities[0].name).toBe('Mortgage');
    });

    test('getAccountByPlaidId', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Plaid Account',
        account_type: 'asset',
        account_subtype: 'checking',
        plaid_account_id: 'plaid-abc-123',
      });

      const found = getAccountByPlaidId(db, 'plaid-abc-123');
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);

      const notFound = getAccountByPlaidId(db, 'nonexistent');
      expect(notFound).toBeFalsy();
    });
  });

  // ── Balance Management ────────────────────────────────────────────────────

  describe('balance management', () => {
    test('updateAccountBalance updates balance and creates snapshot', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 1000,
      });

      updateAccountBalance(db, id, 2500);

      const account = getAccountById(db, id);
      expect(account!.current_balance).toBe(2500);

      // Verify snapshot was created
      const snapshots = db.prepare('SELECT * FROM balance_snapshots WHERE account_id = @id').all({ id }) as { balance: number }[];
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].balance).toBe(2500);
    });

    test('insertBalanceSnapshot upserts on same date', () => {
      const db = createTestDb();
      const id = insertAccount(db, {
        name: 'Savings',
        account_type: 'asset',
        account_subtype: 'savings',
      });

      insertBalanceSnapshot(db, { account_id: id, balance: 1000, snapshot_date: '2026-01-15' });
      insertBalanceSnapshot(db, { account_id: id, balance: 2000, snapshot_date: '2026-01-15' });

      const snapshots = db.prepare('SELECT * FROM balance_snapshots WHERE account_id = @id AND snapshot_date = @date')
        .all({ id, date: '2026-01-15' }) as { balance: number }[];
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].balance).toBe(2000);
    });
  });

  // ── Loan CRUD ─────────────────────────────────────────────────────────────

  describe('loan CRUD', () => {
    test('insertLoan and getLoanByAccountId', () => {
      const db = createTestDb();
      const accountId = insertAccount(db, {
        name: 'Home Mortgage',
        account_type: 'liability',
        account_subtype: 'mortgage',
        current_balance: 300000,
      });

      const loanId = insertLoan(db, {
        account_id: accountId,
        original_principal: 300000,
        interest_rate: 0.065,
        term_months: 360,
        start_date: '2024-01-01',
      });

      expect(loanId).toBeGreaterThan(0);

      const loan = getLoanByAccountId(db, accountId);
      expect(loan).toBeDefined();
      expect(loan!.original_principal).toBe(300000);
      expect(loan!.interest_rate).toBe(0.065);
      expect(loan!.term_months).toBe(360);
      expect(loan!.extra_payment).toBe(0);
    });

    test('updateLoan', () => {
      const db = createTestDb();
      const accountId = insertAccount(db, {
        name: 'Car Loan',
        account_type: 'liability',
        account_subtype: 'auto_loan',
        current_balance: 25000,
      });

      const loanId = insertLoan(db, {
        account_id: accountId,
        original_principal: 25000,
        interest_rate: 0.049,
        term_months: 60,
        start_date: '2025-01-01',
      });

      const updated = updateLoan(db, loanId, { extra_payment: 200, notes: 'Paying extra' });
      expect(updated).toBe(true);

      const loan = getLoanByAccountId(db, accountId);
      expect(loan!.extra_payment).toBe(200);
      expect(loan!.notes).toBe('Paying extra');
    });

    test('getLoans returns all loans with account names', () => {
      const db = createTestDb();
      const a1 = insertAccount(db, { name: 'Mortgage', account_type: 'liability', account_subtype: 'mortgage', current_balance: 300000 });
      const a2 = insertAccount(db, { name: 'Car Loan', account_type: 'liability', account_subtype: 'auto_loan', current_balance: 20000 });

      insertLoan(db, { account_id: a1, original_principal: 300000, interest_rate: 0.065, term_months: 360, start_date: '2024-01-01' });
      insertLoan(db, { account_id: a2, original_principal: 20000, interest_rate: 0.05, term_months: 60, start_date: '2025-01-01' });

      const loans = getLoans(db);
      expect(loans.length).toBe(2);
      // Ordered by principal DESC
      expect(loans[0].account_name).toBe('Mortgage');
      expect(loans[1].account_name).toBe('Car Loan');
    });
  });

  // ── Net Worth Calculations ────────────────────────────────────────────────

  describe('net worth calculations', () => {
    test('getNetWorthSummary', () => {
      const db = createTestDb();
      insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 50000 });
      insertAccount(db, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', current_balance: 400000 });
      insertAccount(db, { name: 'Mortgage', account_type: 'liability', account_subtype: 'mortgage', current_balance: 300000 });
      insertAccount(db, { name: 'Credit Card', account_type: 'liability', account_subtype: 'credit_card', current_balance: 5000 });

      const summary = getNetWorthSummary(db);
      expect(summary.totalAssets).toBe(450000);
      expect(summary.totalLiabilities).toBe(305000);
      expect(summary.netWorth).toBe(145000);
      expect(summary.assetsBySubtype.length).toBe(2);
      expect(summary.liabilitiesBySubtype.length).toBe(2);
      expect(summary.accounts.length).toBe(4);
    });

    test('getNetWorthSummary with no accounts', () => {
      const db = createTestDb();
      const summary = getNetWorthSummary(db);
      expect(summary.totalAssets).toBe(0);
      expect(summary.totalLiabilities).toBe(0);
      expect(summary.netWorth).toBe(0);
      expect(summary.accounts.length).toBe(0);
    });

    test('getNetWorthSummary excludes inactive accounts', () => {
      const db = createTestDb();
      const id = insertAccount(db, { name: 'Old Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 10000 });
      insertAccount(db, { name: 'Active Savings', account_type: 'asset', account_subtype: 'savings', current_balance: 5000 });
      deactivateAccount(db, id);

      const summary = getNetWorthSummary(db);
      expect(summary.totalAssets).toBe(5000);
      expect(summary.accounts.length).toBe(1);
    });

    test('getNetWorthTrend', () => {
      const db = createTestDb();
      const id = insertAccount(db, { name: 'Checking', account_type: 'asset', account_subtype: 'checking', current_balance: 10000 });

      insertBalanceSnapshot(db, { account_id: id, balance: 8000, snapshot_date: '2025-12-01' });
      insertBalanceSnapshot(db, { account_id: id, balance: 9000, snapshot_date: '2026-01-01' });
      insertBalanceSnapshot(db, { account_id: id, balance: 10000, snapshot_date: '2026-02-01' });

      const trend = getNetWorthTrend(db, 6);
      expect(trend.length).toBe(3);
      expect(trend[0].totalAssets).toBe(8000);
      expect(trend[2].totalAssets).toBe(10000);
      // Net worth = assets - liabilities (no liabilities here)
      expect(trend[2].netWorth).toBe(10000);
    });

    test('getEquitySummary', () => {
      const db = createTestDb();
      const houseId = insertAccount(db, { name: 'House', account_type: 'asset', account_subtype: 'real_estate', current_balance: 400000 });
      const mortgageId = insertAccount(db, { name: 'Mortgage', account_type: 'liability', account_subtype: 'mortgage', current_balance: 280000 });

      insertLoan(db, {
        account_id: mortgageId,
        original_principal: 300000,
        interest_rate: 0.065,
        term_months: 360,
        start_date: '2024-01-01',
        linked_asset_id: houseId,
      });

      const equity = getEquitySummary(db);
      expect(equity.length).toBe(1);
      expect(equity[0].assetName).toBe('House');
      expect(equity[0].assetValue).toBe(400000);
      expect(equity[0].loanBalance).toBe(280000);
      expect(equity[0].equity).toBe(120000);
      expect(equity[0].equityPercent).toBe(30);
    });
  });

  // ── Transaction Linking ───────────────────────────────────────────────────

  describe('transaction linking', () => {
    test('linkTransactionsToAccount by account_last4', () => {
      const db = createTestDb();
      const accountId = insertAccount(db, {
        name: 'Chase Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        account_number_last4: '4567',
      });

      insertTransactions(db, [
        { date: '2026-01-01', description: 'Coffee', amount: -5, account_last4: '4567' },
        { date: '2026-01-02', description: 'Gas', amount: -40, account_last4: '4567' },
        { date: '2026-01-03', description: 'Other', amount: -20, account_last4: '9999' },
      ]);

      const linked = linkTransactionsToAccount(db, accountId, { accountLast4: '4567' });
      expect(linked).toBe(2);

      // Verify they got linked
      const rows = db.prepare('SELECT COUNT(*) as cnt FROM transactions WHERE account_id = @accountId').get({ accountId }) as { cnt: number };
      expect(rows.cnt).toBe(2);
    });

    test('linkTransactionsToAccount with no criteria returns 0', () => {
      const db = createTestDb();
      const linked = linkTransactionsToAccount(db, 1, {});
      expect(linked).toBe(0);
    });

    test('getAccountTransactionSummary', () => {
      const db = createTestDb();
      const accountId = insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
      });

      insertTransactions(db, [
        { date: '2026-01-15', description: 'Paycheck', amount: 5000 },
        { date: '2026-01-20', description: 'Rent', amount: -1500 },
        { date: '2026-01-25', description: 'Groceries', amount: -200 },
      ]);

      // Link all transactions
      db.prepare('UPDATE transactions SET account_id = @accountId').run({ accountId });

      const summary = getAccountTransactionSummary(db, accountId);
      expect(summary.income).toBe(5000);
      expect(summary.expenses).toBe(-1700);
      expect(summary.net).toBe(3300);
      expect(summary.count).toBe(3);
    });

    test('getAccountTransactionSummary with date range', () => {
      const db = createTestDb();
      const accountId = insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
      });

      insertTransactions(db, [
        { date: '2026-01-10', description: 'Early', amount: -100 },
        { date: '2026-01-20', description: 'Mid', amount: -200 },
        { date: '2026-02-10', description: 'Late', amount: -300 },
      ]);

      db.prepare('UPDATE transactions SET account_id = @accountId').run({ accountId });

      const summary = getAccountTransactionSummary(db, accountId, '2026-01-15', '2026-01-31');
      expect(summary.count).toBe(1);
      expect(summary.expenses).toBe(-200);
    });
  });
});
