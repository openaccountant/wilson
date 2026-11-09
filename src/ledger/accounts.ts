import { appendAudit } from './audit.js';
import { ConflictError, LedgerValidationError, NotFoundError } from './errors.js';
import { withTransaction, type LedgerDatabase } from './storage.js';
import { ACCOUNT_KINDS, normalBalanceOf, type Account, type AccountKind, type NewAccount } from './types.js';

interface AccountRow {
  code: string;
  name: string;
  kind: AccountKind;
  active: number;
}

function toAccount(r: AccountRow): Account {
  return { code: r.code, name: r.name, kind: r.kind, normal_balance: normalBalanceOf(r.kind), active: r.active === 1 };
}

export function getAccount(db: LedgerDatabase, code: string): Account | null {
  const r = db.prepare('SELECT code, name, kind, active FROM ledger_accounts WHERE code = ?').get(code) as
    | AccountRow
    | null
    | undefined;
  return r ? toAccount(r) : null;
}

export function listAccounts(db: LedgerDatabase): Account[] {
  const rows = db.prepare('SELECT code, name, kind, active FROM ledger_accounts ORDER BY code').all() as AccountRow[];
  return rows.map(toAccount);
}

export function createAccount(db: LedgerDatabase, at: string, input: NewAccount): Account {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!code) throw new LedgerValidationError('account code is required');
  if (!name) throw new LedgerValidationError('account name is required');
  if (!ACCOUNT_KINDS.includes(input.kind)) {
    throw new LedgerValidationError(`account kind must be one of ${ACCOUNT_KINDS.join(', ')}`);
  }
  const active = input.active ?? true;
  return withTransaction(db, () => {
    if (getAccount(db, code)) throw new ConflictError(`account ${code} already exists`);
    db.prepare('INSERT INTO ledger_accounts (code, name, kind, active) VALUES (?, ?, ?, ?)').run(
      code,
      name,
      input.kind,
      active ? 1 : 0,
    );
    appendAudit(db, at, 'account_created', { code, name, kind: input.kind, active });
    return getAccount(db, code)!;
  });
}

/** Deactivated accounts keep their history but reject new postings. */
export function setAccountActive(db: LedgerDatabase, at: string, code: string, active: boolean): Account {
  return withTransaction(db, () => {
    const acct = getAccount(db, code);
    if (!acct) throw new NotFoundError(`account ${code}`);
    if (acct.active === active) return acct;
    db.prepare('UPDATE ledger_accounts SET active = ? WHERE code = ?').run(active ? 1 : 0, code);
    appendAudit(db, at, 'account_active_changed', { code, active });
    return { ...acct, active };
  });
}
