import { assertCents } from './money.js';
import type { LedgerDatabase } from './storage.js';
import { normalBalanceOf, type AccountKind } from './types.js';

export interface AccountActivity {
  code: string;
  name: string;
  kind: AccountKind;
  debits: number;
  credits: number;
}

/** Per-account debit/credit totals over an inclusive date range (accounts with no lines omitted). */
export function accountActivity(db: LedgerDatabase, start: string, end: string): AccountActivity[] {
  const rows = db
    .prepare(
      `SELECT a.code AS code, a.name AS name, a.kind AS kind,
              SUM(l.debit_cents) AS debits, SUM(l.credit_cents) AS credits
         FROM ledger_lines l
         JOIN ledger_entries e ON e.id = l.entry_id
         JOIN ledger_accounts a ON a.code = l.account_code
        WHERE e.date >= ? AND e.date <= ?
        GROUP BY a.code
        ORDER BY a.code`,
    )
    .all(start, end) as AccountActivity[];
  for (const r of rows) {
    assertCents(r.debits, `debits for ${r.code}`);
    assertCents(r.credits, `credits for ${r.code}`);
  }
  return rows;
}

/** Balance on the account's normal side: positive means a normal balance. */
export function normalSideBalance(kind: AccountKind, debits: number, credits: number): number {
  return normalBalanceOf(kind) === 'debit' ? debits - credits : credits - debits;
}

export const BEGINNING = '0000-01-01';
