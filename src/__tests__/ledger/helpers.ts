import { Database } from 'bun:sqlite';
import { Ledger } from '../../ledger/index.js';

export function makeLedger(): { db: Database; ledger: Ledger } {
  const db = new Database(':memory:');
  const ledger = new Ledger(db, { now: () => '2026-01-01T00:00:00.000Z' }).init();
  ledger.createAccount({ code: 'cash', name: 'Cash', kind: 'asset' });
  ledger.createAccount({ code: 'card', name: 'Card', kind: 'liability' });
  ledger.createAccount({ code: 'capital', name: 'Capital', kind: 'equity' });
  ledger.createAccount({ code: 'sales', name: 'Sales', kind: 'income' });
  ledger.createAccount({ code: 'supplies', name: 'Supplies', kind: 'expense' });
  return { db, ledger };
}

export function simple(date: string, dr: string, cr: string, cents: number, external_id?: string) {
  return {
    date,
    memo: `${dr}/${cr}`,
    external_id,
    lines: [
      { account: dr, debit_cents: cents },
      { account: cr, credit_cents: cents },
    ],
  };
}

export function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
