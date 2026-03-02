import { describe, expect, test } from 'bun:test';
import { mapPlaidTypeToSubtype } from '../plaid/account-mapping.js';
import { createTestDb } from './helpers.js';
import {
  upsertAccountFromPlaid,
  getAccountByPlaidId,
  getAccountById,
} from '../db/net-worth-queries.js';

describe('mapPlaidTypeToSubtype', () => {
  test('maps depository/checking', () => {
    expect(mapPlaidTypeToSubtype('depository', 'checking')).toBe('checking');
  });

  test('maps depository/savings', () => {
    expect(mapPlaidTypeToSubtype('depository', 'savings')).toBe('savings');
  });

  test('maps depository/money market to savings', () => {
    expect(mapPlaidTypeToSubtype('depository', 'money market')).toBe('savings');
  });

  test('maps depository/cd to savings', () => {
    expect(mapPlaidTypeToSubtype('depository', 'cd')).toBe('savings');
  });

  test('maps credit/credit card', () => {
    expect(mapPlaidTypeToSubtype('credit', 'credit card')).toBe('credit_card');
  });

  test('maps loan/mortgage', () => {
    expect(mapPlaidTypeToSubtype('loan', 'mortgage')).toBe('mortgage');
  });

  test('maps loan/auto', () => {
    expect(mapPlaidTypeToSubtype('loan', 'auto')).toBe('auto_loan');
  });

  test('maps loan/student', () => {
    expect(mapPlaidTypeToSubtype('loan', 'student')).toBe('student_loan');
  });

  test('maps loan/personal', () => {
    expect(mapPlaidTypeToSubtype('loan', 'personal')).toBe('personal_loan');
  });

  test('maps loan/home equity', () => {
    expect(mapPlaidTypeToSubtype('loan', 'home equity')).toBe('heloc');
  });

  test('maps investment subtypes', () => {
    expect(mapPlaidTypeToSubtype('investment', '401k')).toBe('investment');
    expect(mapPlaidTypeToSubtype('investment', 'ira')).toBe('investment');
    expect(mapPlaidTypeToSubtype('investment', 'brokerage')).toBe('investment');
    expect(mapPlaidTypeToSubtype('investment', 'roth')).toBe('investment');
  });

  test('unknown loan subtype falls back to other_liability', () => {
    expect(mapPlaidTypeToSubtype('loan', 'unknown')).toBe('other_liability');
  });

  test('unknown credit subtype falls back to other_liability', () => {
    expect(mapPlaidTypeToSubtype('credit', 'unknown')).toBe('other_liability');
  });

  test('unknown depository subtype falls back to other_asset', () => {
    expect(mapPlaidTypeToSubtype('depository', 'unknown')).toBe('other_asset');
  });

  test('unknown type falls back to other_asset', () => {
    expect(mapPlaidTypeToSubtype('other', 'something')).toBe('other_asset');
  });

  test('case insensitive matching', () => {
    expect(mapPlaidTypeToSubtype('Depository', 'Checking')).toBe('checking');
    expect(mapPlaidTypeToSubtype('CREDIT', 'Credit Card')).toBe('credit_card');
  });
});

describe('upsertAccountFromPlaid', () => {
  const basePlaidData = {
    plaidAccountId: 'plaid-test-123',
    name: 'Chase Checking',
    mask: '4567',
    plaidType: 'depository',
    plaidSubtype: 'checking',
    balance: 15000,
    currency: 'USD',
    institution: 'Chase',
  };

  test('creates new account when none exists', () => {
    const db = createTestDb();
    const result = upsertAccountFromPlaid(db, basePlaidData);

    expect(result.created).toBe(true);
    expect(result.accountId).toBeGreaterThan(0);

    const account = getAccountById(db, result.accountId);
    expect(account).toBeDefined();
    expect(account!.name).toBe('Chase Checking');
    expect(account!.account_type).toBe('asset');
    expect(account!.account_subtype).toBe('checking');
    expect(account!.institution).toBe('Chase');
    expect(account!.account_number_last4).toBe('4567');
    expect(account!.current_balance).toBe(15000);
    expect(account!.plaid_account_id).toBe('plaid-test-123');
  });

  test('creates initial balance snapshot on new account', () => {
    const db = createTestDb();
    const result = upsertAccountFromPlaid(db, basePlaidData);

    const snapshots = db.prepare(
      'SELECT * FROM balance_snapshots WHERE account_id = @id'
    ).all({ id: result.accountId }) as { balance: number; source: string }[];

    expect(snapshots.length).toBe(1);
    expect(snapshots[0].balance).toBe(15000);
    expect(snapshots[0].source).toBe('plaid');
  });

  test('updates existing account balance', () => {
    const db = createTestDb();
    const first = upsertAccountFromPlaid(db, basePlaidData);
    expect(first.created).toBe(true);

    const second = upsertAccountFromPlaid(db, { ...basePlaidData, balance: 20000 });
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);

    const account = getAccountById(db, second.accountId);
    expect(account!.current_balance).toBe(20000);
  });

  test('maps credit card to liability', () => {
    const db = createTestDb();
    const result = upsertAccountFromPlaid(db, {
      ...basePlaidData,
      plaidAccountId: 'plaid-cc-456',
      name: 'Chase Freedom',
      plaidType: 'credit',
      plaidSubtype: 'credit card',
      balance: 2500,
    });

    const account = getAccountById(db, result.accountId);
    expect(account!.account_type).toBe('liability');
    expect(account!.account_subtype).toBe('credit_card');
  });

  test('maps mortgage to liability', () => {
    const db = createTestDb();
    const result = upsertAccountFromPlaid(db, {
      ...basePlaidData,
      plaidAccountId: 'plaid-mort-789',
      name: 'Home Loan',
      plaidType: 'loan',
      plaidSubtype: 'mortgage',
      balance: 300000,
    });

    const account = getAccountById(db, result.accountId);
    expect(account!.account_type).toBe('liability');
    expect(account!.account_subtype).toBe('mortgage');
  });

  test('looks up by plaid_account_id, not name', () => {
    const db = createTestDb();
    upsertAccountFromPlaid(db, basePlaidData);

    // Same plaid ID, different name — should update, not create
    const result = upsertAccountFromPlaid(db, { ...basePlaidData, name: 'Renamed Account' });
    expect(result.created).toBe(false);

    const allAccounts = db.prepare('SELECT COUNT(*) as cnt FROM accounts').get() as { cnt: number };
    expect(allAccounts.cnt).toBe(1);
  });
});
