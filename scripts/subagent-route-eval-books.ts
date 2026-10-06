/**
 * Eval tooling (no product code): the per-persona "book" (accounts, month-end balance snapshots,
 * loans) that sits next to the persona transaction seeds. A book is a checked-in JSON file generated
 * by scripts/subagent-route-eval-fixtures.ts; this module only loads one and writes it into a db with
 * the product's own insertAccount / insertBalanceSnapshot / insertLoan. Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../src/db/compat-sqlite.js';
import { insertAccount, insertBalanceSnapshot, insertLoan } from '../src/db/net-worth-queries.js';
import type { AccountSubtype } from '../src/tools/net-worth/account-types.js';

export interface BookLoan {
  original_principal: number;
  /** Decimal fraction (0.06 = 6%), the unit the product stores in loans.interest_rate. */
  interest_rate: number;
  term_months: number;
  /** First payment month, YYYY-MM-01. */
  start_date: string;
  extra_payment: number;
  /** Key of the asset account this loan finances, when there is one. */
  linked_asset_key?: string;
  notes?: string;
}

export interface BookAccount {
  key: string;
  name: string;
  account_type: 'asset' | 'liability';
  account_subtype: AccountSubtype;
  institution: string;
  account_number_last4: string;
  /** Equals the last snapshot (2026-06-30). Liabilities are amounts owed (positive). */
  current_balance: number;
  notes: string;
  /** Present when the June movement of this balance is fixed by the persona's transaction file. */
  ledger?: { file: string; match?: string; sign: 1 | -1 };
  loan?: BookLoan;
  snapshots: Array<{ date: string; balance: number }>;
}

export interface PersonaBook {
  persona: string;
  as_of: string;
  transaction_months: string[];
  accounts: BookAccount[];
}

export const DEFAULT_FIXTURES_DIR = join(import.meta.dir, 'subagent-route-eval', 'fixtures', 'v3');

export function loadPersonaBook(fixturesDir: string, persona: string): PersonaBook {
  return JSON.parse(readFileSync(join(fixturesDir, `${persona}.book.json`), 'utf8')) as PersonaBook;
}

/** Insert every account (assets first in file order, so loans can link), its snapshots and its loan. */
export function applyPersonaBook(db: Database, book: PersonaBook): void {
  const ids = new Map<string, number>();
  for (const a of book.accounts) {
    ids.set(
      a.key,
      insertAccount(db, {
        name: a.name,
        account_type: a.account_type,
        account_subtype: a.account_subtype,
        institution: a.institution,
        account_number_last4: a.account_number_last4,
        current_balance: a.current_balance,
        notes: a.notes,
      }),
    );
  }
  for (const a of book.accounts) {
    const id = ids.get(a.key)!;
    for (const s of a.snapshots) insertBalanceSnapshot(db, { account_id: id, balance: s.balance, snapshot_date: s.date, source: 'manual' });
    if (a.loan) {
      const linked = a.loan.linked_asset_key ? ids.get(a.loan.linked_asset_key) : undefined;
      if (a.loan.linked_asset_key && linked === undefined) throw new Error(`loan ${a.key} links unknown asset ${a.loan.linked_asset_key}`);
      insertLoan(db, {
        account_id: id,
        original_principal: a.loan.original_principal,
        interest_rate: a.loan.interest_rate,
        term_months: a.loan.term_months,
        start_date: a.loan.start_date,
        extra_payment: a.loan.extra_payment,
        linked_asset_id: linked,
        notes: a.loan.notes,
      });
    }
  }
}
