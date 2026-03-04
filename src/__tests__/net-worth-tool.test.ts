import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { createTestDb } from './helpers.js';
import { insertAccount } from '../db/net-worth-queries.js';
import { initNetWorthTool, netWorthTool } from '../tools/net-worth/net-worth.js';
import * as licenseModule from '../licensing/license.js';

describe('net-worth tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initNetWorthTool(db);
  });

  describe('summary action', () => {
    test('with no accounts returns no accounts message', async () => {
      const result = JSON.parse(await netWorthTool.func({ action: 'summary' })).data;
      expect(result.message).toContain('No accounts');
    });

    test('with accounts returns netWorth breakdown', async () => {
      insertAccount(db, {
        name: 'Savings',
        account_type: 'asset',
        account_subtype: 'savings',
        current_balance: 25000,
      });
      insertAccount(db, {
        name: 'Credit Card',
        account_type: 'liability',
        account_subtype: 'credit_card',
        current_balance: 3000,
      });

      const result = JSON.parse(await netWorthTool.func({ action: 'summary' })).data;
      expect(result.netWorth).toBe(22000);
      expect(result.totalAssets).toBe(25000);
      expect(result.totalLiabilities).toBe(3000);
      expect(result.assets).toBeDefined();
      expect(result.liabilities).toBeDefined();
    });
  });

  describe('trend action', () => {
    test('without license returns error', async () => {
      const spy = spyOn(licenseModule, 'hasLicense').mockReturnValue(false);
      const result = JSON.parse(await netWorthTool.func({ action: 'trend' })).data;
      expect(result.error).toContain('Pro feature');
      spy.mockRestore();
    });

    test('with license and no snapshots returns no snapshots message', async () => {
      const spy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);
      const result = JSON.parse(await netWorthTool.func({ action: 'trend' })).data;
      expect(result.message).toContain('No balance snapshots');
      spy.mockRestore();
    });

    test('with license and snapshots returns trend data', async () => {
      const spy = spyOn(licenseModule, 'hasLicense').mockReturnValue(true);

      // Insert an account and snapshot
      const acctId = insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 10000,
      });

      const today = new Date().toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO balance_snapshots (account_id, balance, snapshot_date, source) VALUES (@accountId, @balance, @date, @source)"
      ).run({ accountId: acctId, balance: 10000, date: today, source: 'manual' });

      const result = JSON.parse(await netWorthTool.func({ action: 'trend', months: 12 })).data;
      expect(result.trend).toBeDefined();
      expect(result.months).toBeGreaterThanOrEqual(1);
      spy.mockRestore();
    });
  });

  describe('balance_sheet action', () => {
    test('with no accounts returns no accounts message', async () => {
      const result = JSON.parse(await netWorthTool.func({ action: 'balance_sheet' })).data;
      expect(result.message).toContain('No accounts');
    });

    test('with accounts returns full listing', async () => {
      insertAccount(db, {
        name: 'Checking',
        account_type: 'asset',
        account_subtype: 'checking',
        current_balance: 5000,
        institution: 'Chase',
      });
      insertAccount(db, {
        name: 'Mortgage',
        account_type: 'liability',
        account_subtype: 'mortgage',
        current_balance: 200000,
        institution: 'Wells Fargo',
      });

      const result = JSON.parse(await netWorthTool.func({ action: 'balance_sheet' })).data;
      expect(result.netWorth).toBe(-195000);
      expect(result.assets).toHaveLength(1);
      expect(result.liabilities).toHaveLength(1);
      expect(result.assets[0].name).toBe('Checking');
      expect(result.assets[0].institution).toBe('Chase');
      expect(result.totalAssets).toBe(5000);
      expect(result.totalLiabilities).toBe(200000);
    });
  });
});
