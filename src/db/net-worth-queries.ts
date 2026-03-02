import type { Database } from './compat-sqlite.js';
import type { AccountType, AccountSubtype } from '../tools/net-worth/account-types.js';
import { getAccountTypeForSubtype } from '../tools/net-worth/account-types.js';
import { mapPlaidTypeToSubtype } from '../plaid/account-mapping.js';

// ── Row Types ────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: number;
  name: string;
  account_type: AccountType;
  account_subtype: AccountSubtype;
  institution: string | null;
  account_number_last4: string | null;
  current_balance: number;
  currency: string;
  is_active: number;
  notes: string | null;
  plaid_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountInsert {
  name: string;
  account_type: AccountType;
  account_subtype: AccountSubtype;
  institution?: string;
  account_number_last4?: string;
  current_balance?: number;
  currency?: string;
  notes?: string;
  plaid_account_id?: string;
}

export interface AccountUpdate {
  name?: string;
  institution?: string;
  account_number_last4?: string;
  current_balance?: number;
  notes?: string;
  is_active?: number;
}

export interface BalanceSnapshotRow {
  id: number;
  account_id: number;
  balance: number;
  snapshot_date: string;
  source: string;
  created_at: string;
}

export interface LoanRow {
  id: number;
  account_id: number;
  original_principal: number;
  interest_rate: number;
  term_months: number;
  start_date: string;
  extra_payment: number;
  linked_asset_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoanInsert {
  account_id: number;
  original_principal: number;
  interest_rate: number;
  term_months: number;
  start_date: string;
  extra_payment?: number;
  linked_asset_id?: number;
  notes?: string;
}

export interface LoanUpdate {
  interest_rate?: number;
  extra_payment?: number;
  linked_asset_id?: number | null;
  notes?: string;
}

export interface NetWorthSummary {
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  assetsBySubtype: { subtype: string; total: number; count: number }[];
  liabilitiesBySubtype: { subtype: string; total: number; count: number }[];
  accounts: AccountRow[];
}

export interface NetWorthTrendPoint {
  date: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

export interface EquitySummaryRow {
  assetName: string;
  assetValue: number;
  loanBalance: number;
  equity: number;
  equityPercent: number;
}

// ── Account CRUD ─────────────────────────────────────────────────────────────

export function insertAccount(db: Database, account: AccountInsert): number {
  const result = db.prepare(`
    INSERT INTO accounts (name, account_type, account_subtype, institution,
      account_number_last4, current_balance, currency, notes, plaid_account_id)
    VALUES (@name, @account_type, @account_subtype, @institution,
      @account_number_last4, @current_balance, @currency, @notes, @plaid_account_id)
  `).run({
    name: account.name,
    account_type: account.account_type,
    account_subtype: account.account_subtype,
    institution: account.institution ?? null,
    account_number_last4: account.account_number_last4 ?? null,
    current_balance: account.current_balance ?? 0,
    currency: account.currency ?? 'USD',
    notes: account.notes ?? null,
    plaid_account_id: account.plaid_account_id ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function updateAccount(db: Database, id: number, updates: AccountUpdate): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.name !== undefined) { sets.push('name = @name'); params.name = updates.name; }
  if (updates.institution !== undefined) { sets.push('institution = @institution'); params.institution = updates.institution; }
  if (updates.account_number_last4 !== undefined) { sets.push('account_number_last4 = @account_number_last4'); params.account_number_last4 = updates.account_number_last4; }
  if (updates.current_balance !== undefined) { sets.push('current_balance = @current_balance'); params.current_balance = updates.current_balance; }
  if (updates.notes !== undefined) { sets.push('notes = @notes'); params.notes = updates.notes; }
  if (updates.is_active !== undefined) { sets.push('is_active = @is_active'); params.is_active = updates.is_active; }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  const result = db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return (result as { changes: number }).changes > 0;
}

export function deactivateAccount(db: Database, id: number): boolean {
  return updateAccount(db, id, { is_active: 0 });
}

export function getAccounts(db: Database, filters?: { type?: AccountType; active?: boolean }): AccountRow[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters?.type) {
    conditions.push('account_type = @type');
    params.type = filters.type;
  }
  if (filters?.active !== undefined) {
    conditions.push('is_active = @active');
    params.active = filters.active ? 1 : 0;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM accounts ${where} ORDER BY account_type, account_subtype, name`).all(params) as AccountRow[];
}

export function getAccountById(db: Database, id: number): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = @id').get({ id }) as AccountRow | undefined;
}

export function getAccountByPlaidId(db: Database, plaidId: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE plaid_account_id = @plaidId').get({ plaidId }) as AccountRow | undefined;
}

// ── Plaid Account Upsert ─────────────────────────────────────────────────────

export interface PlaidAccountUpsertData {
  plaidAccountId: string;
  name: string;
  mask: string;
  plaidType: string;
  plaidSubtype: string;
  balance: number;
  currency: string;
  institution: string;
}

/**
 * Upsert an account from Plaid balance data.
 * If an account with the given plaid_account_id exists, update its balance.
 * Otherwise, create a new account with mapped type/subtype.
 */
export function upsertAccountFromPlaid(
  db: Database,
  data: PlaidAccountUpsertData,
): { accountId: number; created: boolean } {
  const existing = getAccountByPlaidId(db, data.plaidAccountId);

  if (existing) {
    updateAccountBalance(db, existing.id, data.balance, 'plaid');
    return { accountId: existing.id, created: false };
  }

  const subtype = mapPlaidTypeToSubtype(data.plaidType, data.plaidSubtype);
  const accountType = getAccountTypeForSubtype(subtype);
  const id = insertAccount(db, {
    name: data.name,
    account_type: accountType,
    account_subtype: subtype,
    institution: data.institution,
    account_number_last4: data.mask,
    current_balance: data.balance,
    currency: data.currency || 'USD',
    plaid_account_id: data.plaidAccountId,
  });

  // Record initial balance snapshot
  insertBalanceSnapshot(db, {
    account_id: id,
    balance: data.balance,
    snapshot_date: new Date().toISOString().slice(0, 10),
    source: 'plaid',
  });

  return { accountId: id, created: true };
}

// ── Balance Management ───────────────────────────────────────────────────────

export function updateAccountBalance(db: Database, id: number, balance: number, source: string = 'manual'): void {
  const today = new Date().toISOString().slice(0, 10);
  const update = db.transaction(() => {
    db.prepare("UPDATE accounts SET current_balance = @balance, updated_at = datetime('now') WHERE id = @id")
      .run({ id, balance });
    insertBalanceSnapshot(db, { account_id: id, balance, snapshot_date: today, source });
  });
  update();
}

export function insertBalanceSnapshot(
  db: Database,
  snapshot: { account_id: number; balance: number; snapshot_date: string; source?: string }
): void {
  db.prepare(`
    INSERT INTO balance_snapshots (account_id, balance, snapshot_date, source)
    VALUES (@account_id, @balance, @snapshot_date, @source)
    ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
      balance = @balance,
      source = @source
  `).run({
    account_id: snapshot.account_id,
    balance: snapshot.balance,
    snapshot_date: snapshot.snapshot_date,
    source: snapshot.source ?? 'manual',
  });
}

// ── Loan CRUD ────────────────────────────────────────────────────────────────

export function insertLoan(db: Database, loan: LoanInsert): number {
  const result = db.prepare(`
    INSERT INTO loans (account_id, original_principal, interest_rate, term_months,
      start_date, extra_payment, linked_asset_id, notes)
    VALUES (@account_id, @original_principal, @interest_rate, @term_months,
      @start_date, @extra_payment, @linked_asset_id, @notes)
  `).run({
    account_id: loan.account_id,
    original_principal: loan.original_principal,
    interest_rate: loan.interest_rate,
    term_months: loan.term_months,
    start_date: loan.start_date,
    extra_payment: loan.extra_payment ?? 0,
    linked_asset_id: loan.linked_asset_id ?? null,
    notes: loan.notes ?? null,
  });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function updateLoan(db: Database, id: number, updates: LoanUpdate): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.interest_rate !== undefined) { sets.push('interest_rate = @interest_rate'); params.interest_rate = updates.interest_rate; }
  if (updates.extra_payment !== undefined) { sets.push('extra_payment = @extra_payment'); params.extra_payment = updates.extra_payment; }
  if (updates.linked_asset_id !== undefined) { sets.push('linked_asset_id = @linked_asset_id'); params.linked_asset_id = updates.linked_asset_id; }
  if (updates.notes !== undefined) { sets.push('notes = @notes'); params.notes = updates.notes; }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  const result = db.prepare(`UPDATE loans SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return (result as { changes: number }).changes > 0;
}

export function getLoanByAccountId(db: Database, accountId: number): LoanRow | undefined {
  return db.prepare('SELECT * FROM loans WHERE account_id = @accountId').get({ accountId }) as LoanRow | undefined;
}

export function getLoans(db: Database): (LoanRow & { account_name: string })[] {
  return db.prepare(`
    SELECT l.*, a.name AS account_name
    FROM loans l
    JOIN accounts a ON a.id = l.account_id
    ORDER BY l.original_principal DESC
  `).all() as (LoanRow & { account_name: string })[];
}

// ── Net Worth Calculations ───────────────────────────────────────────────────

export function getNetWorthSummary(db: Database): NetWorthSummary {
  const accounts = getAccounts(db, { active: true });

  const assetsBySubtype = db.prepare(`
    SELECT account_subtype AS subtype, SUM(current_balance) AS total, COUNT(*) AS count
    FROM accounts WHERE account_type = 'asset' AND is_active = 1
    GROUP BY account_subtype ORDER BY total DESC
  `).all() as { subtype: string; total: number; count: number }[];

  const liabilitiesBySubtype = db.prepare(`
    SELECT account_subtype AS subtype, SUM(current_balance) AS total, COUNT(*) AS count
    FROM accounts WHERE account_type = 'liability' AND is_active = 1
    GROUP BY account_subtype ORDER BY total DESC
  `).all() as { subtype: string; total: number; count: number }[];

  const totalAssets = assetsBySubtype.reduce((sum, r) => sum + r.total, 0);
  const totalLiabilities = liabilitiesBySubtype.reduce((sum, r) => sum + r.total, 0);

  return {
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets - totalLiabilities,
    assetsBySubtype,
    liabilitiesBySubtype,
    accounts,
  };
}

export function getNetWorthTrend(db: Database, months: number = 12): NetWorthTrendPoint[] {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  })();

  // Get all snapshots in range, grouped by date and account type
  const rows = db.prepare(`
    SELECT
      bs.snapshot_date AS date,
      a.account_type,
      SUM(bs.balance) AS total
    FROM balance_snapshots bs
    JOIN accounts a ON a.id = bs.account_id
    WHERE bs.snapshot_date >= @startDate AND bs.snapshot_date <= @endDate
      AND a.is_active = 1
    GROUP BY bs.snapshot_date, a.account_type
    ORDER BY bs.snapshot_date
  `).all({ startDate, endDate }) as { date: string; account_type: string; total: number }[];

  // Build date→{assets, liabilities} map
  const dateMap = new Map<string, { assets: number; liabilities: number }>();
  for (const row of rows) {
    if (!dateMap.has(row.date)) {
      dateMap.set(row.date, { assets: 0, liabilities: 0 });
    }
    const entry = dateMap.get(row.date)!;
    if (row.account_type === 'asset') {
      entry.assets = row.total;
    } else {
      entry.liabilities = row.total;
    }
  }

  return Array.from(dateMap.entries()).map(([date, { assets, liabilities }]) => ({
    date,
    totalAssets: assets,
    totalLiabilities: liabilities,
    netWorth: assets - liabilities,
  }));
}

export function getEquitySummary(db: Database): EquitySummaryRow[] {
  const rows = db.prepare(`
    SELECT
      a.name AS assetName,
      a.current_balance AS assetValue,
      la.current_balance AS loanBalance
    FROM loans l
    JOIN accounts la ON la.id = l.account_id
    JOIN accounts a ON a.id = l.linked_asset_id
    WHERE la.is_active = 1 AND a.is_active = 1
    ORDER BY a.current_balance DESC
  `).all() as { assetName: string; assetValue: number; loanBalance: number }[];

  return rows.map((r) => {
    const equity = r.assetValue - r.loanBalance;
    return {
      assetName: r.assetName,
      assetValue: r.assetValue,
      loanBalance: r.loanBalance,
      equity,
      equityPercent: r.assetValue > 0 ? Math.round((equity / r.assetValue) * 100) : 0,
    };
  });
}

// ── Transaction Linking ──────────────────────────────────────────────────────

export function linkTransactionsToAccount(
  db: Database,
  accountId: number,
  criteria: { accountLast4?: string; bank?: string; accountName?: string }
): number {
  const conditions: string[] = ['account_id IS NULL'];
  const params: Record<string, unknown> = { accountId };

  if (criteria.accountLast4) {
    conditions.push('account_last4 = @accountLast4');
    params.accountLast4 = criteria.accountLast4;
  }
  if (criteria.bank) {
    conditions.push('bank = @bank');
    params.bank = criteria.bank;
  }
  if (criteria.accountName) {
    conditions.push('account_name = @accountName');
    params.accountName = criteria.accountName;
  }

  // Must have at least one matching criterion beyond account_id IS NULL
  if (Object.keys(criteria).length === 0) return 0;

  const result = db.prepare(`
    UPDATE transactions SET account_id = @accountId WHERE ${conditions.join(' AND ')}
  `).run(params);
  return (result as { changes: number }).changes;
}

export function getAccountTransactionSummary(
  db: Database,
  accountId: number,
  startDate?: string,
  endDate?: string
): { income: number; expenses: number; net: number; count: number } {
  const conditions = ['account_id = @accountId'];
  const params: Record<string, unknown> = { accountId };

  if (startDate) { conditions.push('date >= @startDate'); params.startDate = startDate; }
  if (endDate) { conditions.push('date <= @endDate'); params.endDate = endDate; }

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS expenses,
      COALESCE(SUM(amount), 0) AS net,
      COUNT(*) AS count
    FROM transactions WHERE ${conditions.join(' AND ')}
  `).get(params) as { income: number; expenses: number; net: number; count: number };

  return row;
}
