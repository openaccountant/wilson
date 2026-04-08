import { describe, expect, test } from 'bun:test';
import { createTestDb } from './helpers.js';
import { initLinkTransactionsTool, linkTransactionsTool } from '../tools/net-worth/link-transactions.js';
import { insertAccount, getAccountById } from '../db/net-worth-queries.js';
import { insertTransactions } from '../db/queries.js';
import type { Database } from '../db/compat-sqlite.js';

describe('link_transactions tool', () => {
  function setup() {
    const db = createTestDb();
    initLinkTransactionsTool(db);
    return db;
  }

  function parse(result: string) {
    return JSON.parse(result).data;
  }

  /** Insert an account and return its ID. */
  function addAccount(db: Database, name: string, opts?: { last4?: string; institution?: string }) {
    return insertAccount(db, {
      name,
      account_type: 'liability',
      account_subtype: 'credit_card',
      institution: opts?.institution ?? undefined,
      account_number_last4: opts?.last4 ?? undefined,
    });
  }

  /** Insert unlinked transactions with the given attributes. */
  function addTxns(db: Database, txns: { bank?: string; last4?: string; accountName?: string; count?: number }) {
    const n = txns.count ?? 3;
    const items = Array.from({ length: n }, (_, i) => ({
      date: `2026-02-${String(10 + i).padStart(2, '0')}`,
      description: `Purchase ${i + 1}`,
      amount: -(20 + i * 10),
      category: 'Shopping',
      bank: txns.bank,
      account_last4: txns.last4,
      account_name: txns.accountName,
    }));
    insertTransactions(db, items);
  }

  // ── Lookup by account ID ─────────────────────────────────────────────────

  test('link by accountId and bank', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Amex Gold', { institution: 'American Express' });
    addTxns(db, { bank: 'amex' });

    const result = await linkTransactionsTool.func({
      accountId,
      bank: 'amex',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
    expect(data.message).toContain('Amex Gold');
  });

  test('link by accountId and accountLast4', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Chase Checking', { last4: '4567' });
    addTxns(db, { last4: '4567' });

    const result = await linkTransactionsTool.func({
      accountId,
      accountLast4: '4567',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
    expect(data.message).toContain('Chase Checking');
  });

  test('link by accountId and accountName', async () => {
    const db = setup();
    const accountId = addAccount(db, 'BofA Savings');
    addTxns(db, { accountName: 'BofA Savings' });

    const result = await linkTransactionsTool.func({
      accountId,
      accountName: 'BofA Savings',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
  });

  // ── Lookup by name (lookupName) ──────────────────────────────────────────

  test('resolve account by lookupName when accountId omitted', async () => {
    const db = setup();
    addAccount(db, 'Amex Gold');
    addTxns(db, { bank: 'amex' });

    const result = await linkTransactionsTool.func({
      lookupName: 'Amex Gold',
      bank: 'amex',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
    expect(data.message).toContain('Amex Gold');
  });

  test('resolve account by lookupName case-insensitively', async () => {
    const db = setup();
    addAccount(db, 'Chase Checking');
    addTxns(db, { bank: 'chase' });

    const result = await linkTransactionsTool.func({
      lookupName: 'chase checking',
      bank: 'chase',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
    expect(data.message).toContain('Chase Checking');
  });

  test('resolve account by lookupName when accountId is wrong', async () => {
    const db = setup();
    addAccount(db, 'Amex Gold');
    addTxns(db, { bank: 'amex' });

    const result = await linkTransactionsTool.func({
      accountId: 9999,
      lookupName: 'Amex Gold',
      bank: 'amex',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
    expect(data.message).toContain('Amex Gold');
  });

  // ── Fallback to accountName for account lookup ───────────────────────────

  test('resolve account from accountName when no accountId or lookupName', async () => {
    const db = setup();
    addAccount(db, 'BofA Credit');
    addTxns(db, { accountName: 'BofA Credit' });

    const result = await linkTransactionsTool.func({
      accountName: 'BofA Credit',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
    expect(data.message).toContain('BofA Credit');
  });

  test('accountName fallback is case-insensitive', async () => {
    const db = setup();
    addAccount(db, 'My Visa');
    addTxns(db, { accountName: 'My Visa' });

    const result = await linkTransactionsTool.func({
      accountName: 'my visa',
    });

    const data = parse(result);
    expect(data.linked).toBe(3);
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  test('error when account not found by any method', async () => {
    setup();

    const result = await linkTransactionsTool.func({
      accountId: 9999,
      bank: 'amex',
    });

    const data = parse(result);
    expect(data.error).toContain('Account not found');
  });

  test('error includes hint when name was provided', async () => {
    setup();

    const result = await linkTransactionsTool.func({
      lookupName: 'Nonexistent Account',
      bank: 'amex',
    });

    const data = parse(result);
    expect(data.error).toContain('Account not found');
    expect(data.error).toContain('account_manage list');
  });

  test('error when no matching criteria provided', async () => {
    const db = setup();
    addAccount(db, 'Test Account');

    const accounts = db.prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number };

    const result = await linkTransactionsTool.func({
      accountId: accounts.id,
    });

    const data = parse(result);
    expect(data.error).toContain('At least one matching criterion');
  });

  // ── Dry run ──────────────────────────────────────────────────────────────

  test('dry run reports match count without modifying', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Test Card');
    addTxns(db, { bank: 'test', count: 5 });

    const result = await linkTransactionsTool.func({
      accountId,
      bank: 'test',
      dryRun: true,
    });

    const data = parse(result);
    expect(data.dryRun).toBe(true);
    expect(data.matchCount).toBe(5);
    expect(data.message).toContain('5 unlinked transactions');

    // Verify nothing was actually linked
    const unlinked = db.prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE bank = 'test' AND account_id IS NULL"
    ).get() as { count: number };
    expect(unlinked.count).toBe(5);
  });

  test('dry run with lookupName', async () => {
    const db = setup();
    addAccount(db, 'My Card');
    addTxns(db, { bank: 'mybank', count: 2 });

    const result = await linkTransactionsTool.func({
      lookupName: 'My Card',
      bank: 'mybank',
      dryRun: true,
    });

    const data = parse(result);
    expect(data.dryRun).toBe(true);
    expect(data.matchCount).toBe(2);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  test('only links unlinked transactions (account_id IS NULL)', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Card A');
    const otherId = addAccount(db, 'Card B');
    addTxns(db, { bank: 'testbank', count: 4 });

    // Pre-link 2 of the 4 to a different account (subquery avoids LIMIT in UPDATE which isn't supported on all SQLite builds)
    db.prepare(
      "UPDATE transactions SET account_id = @otherId WHERE id IN (SELECT id FROM transactions WHERE bank = 'testbank' AND account_id IS NULL LIMIT 2)"
    ).run({ otherId });

    const result = await linkTransactionsTool.func({
      accountId,
      bank: 'testbank',
    });

    const data = parse(result);
    expect(data.linked).toBe(2);
  });

  test('returns 0 linked when no transactions match', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Empty Card');
    addTxns(db, { bank: 'other_bank' });

    const result = await linkTransactionsTool.func({
      accountId,
      bank: 'nonexistent_bank',
    });

    const data = parse(result);
    expect(data.linked).toBe(0);
  });

  test('deactivated account not found by lookupName', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Closed Card');
    db.prepare('UPDATE accounts SET is_active = 0 WHERE id = @id').run({ id: accountId });
    addTxns(db, { bank: 'closed' });

    const result = await linkTransactionsTool.func({
      lookupName: 'Closed Card',
      bank: 'closed',
    });

    const data = parse(result);
    expect(data.error).toContain('Account not found');
  });

  test('multiple criteria narrows matching transactions', async () => {
    const db = setup();
    const accountId = addAccount(db, 'Specific Card');

    // Insert txns with bank=amex
    addTxns(db, { bank: 'amex', count: 3 });
    // Insert txns with bank=amex AND last4=1234
    insertTransactions(db, [
      { date: '2026-03-01', description: 'Target Purchase', amount: -50, bank: 'amex', account_last4: '1234' },
      { date: '2026-03-02', description: 'Target Purchase 2', amount: -75, bank: 'amex', account_last4: '1234' },
    ]);

    const result = await linkTransactionsTool.func({
      accountId,
      bank: 'amex',
      accountLast4: '1234',
    });

    const data = parse(result);
    // Only the 2 transactions matching BOTH bank=amex AND last4=1234
    expect(data.linked).toBe(2);
  });
});
