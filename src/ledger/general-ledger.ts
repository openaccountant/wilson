import { getAccount, listAccounts } from './accounts.js';
import { accountActivity, BEGINNING, normalSideBalance } from './balances.js';
import { assertRange, dayBefore } from './dates.js';
import { NotFoundError } from './errors.js';
import type { LedgerDatabase } from './storage.js';
import type { Account, GeneralLedger, GeneralLedgerAccount, GeneralLedgerLine } from './types.js';

interface GlRow {
  entry_id: number;
  date: string;
  entry_memo: string;
  line_no: number;
  memo: string | null;
  debit_cents: number;
  credit_cents: number;
}

/**
 * General ledger over an inclusive range: per account, the opening balance
 * before start, each line with a running balance, and the closing balance.
 * Balances are on the account's normal side. Without `account`, every account
 * with an opening balance or activity in range is included.
 */
export function generalLedger(db: LedgerDatabase, start: string, end: string, account?: string): GeneralLedger {
  assertRange(start, end);
  let accounts: Account[];
  if (account !== undefined) {
    const a = getAccount(db, account);
    if (!a) throw new NotFoundError(`account ${account}`);
    accounts = [a];
  } else {
    accounts = listAccounts(db);
  }

  const opening = new Map<string, number>();
  for (const a of accountActivity(db, BEGINNING, dayBefore(start))) {
    opening.set(a.code, normalSideBalance(a.kind, a.debits, a.credits));
  }

  const stmt = db.prepare(
    `SELECT l.entry_id AS entry_id, e.date AS date, e.memo AS entry_memo, l.line_no AS line_no,
            l.memo AS memo, l.debit_cents AS debit_cents, l.credit_cents AS credit_cents
       FROM ledger_lines l
       JOIN ledger_entries e ON e.id = l.entry_id
      WHERE l.account_code = ? AND e.date >= ? AND e.date <= ?
      ORDER BY e.date, e.id, l.line_no`,
  );

  const out: GeneralLedgerAccount[] = [];
  for (const a of accounts) {
    const rows = stmt.all(a.code, start, end) as GlRow[];
    const open = opening.get(a.code) ?? 0;
    if (account === undefined && rows.length === 0 && open === 0) continue;
    let running = open;
    const lines: GeneralLedgerLine[] = rows.map((r) => {
      running += normalSideBalance(a.kind, r.debit_cents, r.credit_cents);
      return { ...r, running_balance_cents: running };
    });
    out.push({
      code: a.code,
      name: a.name,
      kind: a.kind,
      normal_balance: a.normal_balance,
      opening_balance_cents: open,
      lines,
      closing_balance_cents: running,
    });
  }
  return { start, end, accounts: out };
}
