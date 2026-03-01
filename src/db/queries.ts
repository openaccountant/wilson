import type { Database } from './compat-sqlite.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TransactionInsert {
  date: string;
  description: string;
  amount: number;
  category?: string;
  category_confidence?: number;
  source_file?: string;
  bank?: string;
  account_last4?: string;
  is_recurring?: number;
  tags?: string;
  notes?: string;
  merchant_name?: string;
  category_detailed?: string;
  external_id?: string;
  payment_channel?: string;
  pending?: number;
  authorized_date?: string;
}

export interface TransactionRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  category_confidence: number | null;
  user_verified: number;
  source_file: string | null;
  bank: string | null;
  account_last4: string | null;
  is_recurring: number;
  tags: string | null;
  notes: string | null;
  merchant_name: string | null;
  category_detailed: string | null;
  external_id: string | null;
  payment_channel: string | null;
  pending: number;
  authorized_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionFilters {
  dateStart?: string;
  dateEnd?: string;
  category?: string;
  minAmount?: number;
  maxAmount?: number;
  merchant?: string;
  isRecurring?: boolean;
}

export interface SpendingSummaryRow {
  category: string;
  total: number;
  count: number;
}

export interface ImportRecord {
  file_path: string;
  file_hash: string;
  bank?: string;
  transaction_count?: number;
  date_range_start?: string;
  date_range_end?: string;
}

export interface ImportRow {
  id: number;
  file_path: string;
  file_hash: string;
  bank: string | null;
  transaction_count: number | null;
  date_range_start: string | null;
  date_range_end: string | null;
  imported_at: string;
}

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Bulk-insert transactions using a prepared statement inside a transaction.
 */
export function insertTransactions(
  db: Database,
  txns: TransactionInsert[]
): number {
  const stmt = db.prepare(`
    INSERT INTO transactions (date, description, amount, category, category_confidence,
      source_file, bank, account_last4, is_recurring, tags, notes,
      merchant_name, category_detailed, external_id, payment_channel, pending, authorized_date)
    VALUES (@date, @description, @amount, @category, @category_confidence,
      @source_file, @bank, @account_last4, @is_recurring, @tags, @notes,
      @merchant_name, @category_detailed, @external_id, @payment_channel, @pending, @authorized_date)
  `);

  const insertMany = db.transaction((items: TransactionInsert[]) => {
    let count = 0;
    for (const txn of items) {
      stmt.run({
        date: txn.date,
        description: txn.description,
        amount: txn.amount,
        category: txn.category ?? null,
        category_confidence: txn.category_confidence ?? null,
        source_file: txn.source_file ?? null,
        bank: txn.bank ?? null,
        account_last4: txn.account_last4 ?? null,
        is_recurring: txn.is_recurring ?? 0,
        tags: txn.tags ?? null,
        notes: txn.notes ?? null,
        merchant_name: txn.merchant_name ?? null,
        category_detailed: txn.category_detailed ?? null,
        external_id: txn.external_id ?? null,
        payment_channel: txn.payment_channel ?? null,
        pending: txn.pending ?? 0,
        authorized_date: txn.authorized_date ?? null,
      });
      count++;
    }
    return count;
  });

  return insertMany(txns);
}

/**
 * Get transactions with optional filters.
 */
export function getTransactions(
  db: Database,
  filters: TransactionFilters = {}
): TransactionRow[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.dateStart) {
    conditions.push('date >= @dateStart');
    params.dateStart = filters.dateStart;
  }
  if (filters.dateEnd) {
    conditions.push('date <= @dateEnd');
    params.dateEnd = filters.dateEnd;
  }
  if (filters.category) {
    conditions.push('category = @category');
    params.category = filters.category;
  }
  if (filters.minAmount !== undefined) {
    conditions.push('amount >= @minAmount');
    params.minAmount = filters.minAmount;
  }
  if (filters.maxAmount !== undefined) {
    conditions.push('amount <= @maxAmount');
    params.maxAmount = filters.maxAmount;
  }
  if (filters.merchant) {
    conditions.push('description LIKE @merchant');
    params.merchant = `%${filters.merchant}%`;
  }
  if (filters.isRecurring !== undefined) {
    conditions.push('is_recurring = @isRecurring');
    params.isRecurring = filters.isRecurring ? 1 : 0;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM transactions ${where} ORDER BY date DESC`;

  return db.prepare(sql).all(params) as TransactionRow[];
}

/**
 * Update a transaction's category and confidence score.
 */
export function updateCategory(
  db: Database,
  id: number,
  category: string,
  confidence: number
): void {
  db.prepare(`
    UPDATE transactions
    SET category = @category,
        category_confidence = @confidence,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({ id, category, confidence });
}

/**
 * Get spending grouped by category for a date range.
 */
export function getSpendingSummary(
  db: Database,
  startDate: string,
  endDate: string
): SpendingSummaryRow[] {
  return db.prepare(`
    SELECT
      COALESCE(category, 'Uncategorized') AS category,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE date >= @startDate AND date <= @endDate AND amount < 0
    GROUP BY category
    ORDER BY total ASC
  `).all({ startDate, endDate }) as SpendingSummaryRow[];
}

/**
 * Get all transactions marked as recurring.
 */
export function getRecurringTransactions(
  db: Database
): TransactionRow[] {
  return db.prepare(`
    SELECT * FROM transactions
    WHERE is_recurring = 1
    ORDER BY date DESC
  `).all() as TransactionRow[];
}

/**
 * Check if a file has already been imported by its SHA-256 hash.
 */
export function checkImported(
  db: Database,
  fileHash: string
): ImportRow | undefined {
  return db.prepare(`
    SELECT * FROM imports WHERE file_hash = @fileHash
  `).get({ fileHash }) as ImportRow | undefined;
}

/**
 * Check if a transaction with the given external_id already exists.
 */
export function checkExternalId(
  db: Database,
  externalId: string
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM transactions WHERE external_id = @externalId LIMIT 1
  `).get({ externalId });
  return row != null;
}

/**
 * Record a completed import in the imports table.
 */
export function recordImport(
  db: Database,
  record: ImportRecord
): void {
  db.prepare(`
    INSERT INTO imports (file_path, file_hash, bank, transaction_count, date_range_start, date_range_end)
    VALUES (@file_path, @file_hash, @bank, @transaction_count, @date_range_start, @date_range_end)
  `).run({
    file_path: record.file_path,
    file_hash: record.file_hash,
    bank: record.bank ?? null,
    transaction_count: record.transaction_count ?? null,
    date_range_start: record.date_range_start ?? null,
    date_range_end: record.date_range_end ?? null,
  });
}

/**
 * Get transactions that have not been categorized yet.
 */
export function getUncategorizedTransactions(
  db: Database,
  limit?: number
): TransactionRow[] {
  const sql = limit
    ? 'SELECT * FROM transactions WHERE category IS NULL ORDER BY date DESC LIMIT @limit'
    : 'SELECT * FROM transactions WHERE category IS NULL ORDER BY date DESC';

  return db.prepare(sql).all(limit ? { limit } : {}) as TransactionRow[];
}

// ── P&L queries ──────────────────────────────────────────────────────────────

export interface ProfitLossRow {
  totalIncome: number;
  totalExpenses: number;
  netProfitLoss: number;
  incomeByCategory: SpendingSummaryRow[];
  expensesByCategory: SpendingSummaryRow[];
}

/**
 * Get a profit & loss breakdown for a date range.
 */
export function getProfitLoss(
  db: Database,
  startDate: string,
  endDate: string
): ProfitLossRow {
  const incomeByCategory = db.prepare(`
    SELECT COALESCE(category, 'Uncategorized') AS category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= @startDate AND date <= @endDate AND (amount > 0 OR category = 'Income')
    GROUP BY category ORDER BY total DESC
  `).all({ startDate, endDate }) as SpendingSummaryRow[];

  const expensesByCategory = db.prepare(`
    SELECT COALESCE(category, 'Uncategorized') AS category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= @startDate AND date <= @endDate AND amount < 0
      AND COALESCE(category, '') NOT IN ('Income', 'Transfer')
    GROUP BY category ORDER BY total ASC
  `).all({ startDate, endDate }) as SpendingSummaryRow[];

  const totalIncome = incomeByCategory.reduce((sum, r) => sum + r.total, 0);
  const totalExpenses = expensesByCategory.reduce((sum, r) => sum + r.total, 0);

  return {
    totalIncome,
    totalExpenses,
    netProfitLoss: totalIncome + totalExpenses,
    incomeByCategory,
    expensesByCategory,
  };
}

// ── Savings queries ──────────────────────────────────────────────────────────

export interface MonthlyIncomeExpense {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  savingsRate: number;
}

/**
 * Get monthly income/expense/savings data for the last N months.
 */
export function getMonthlySavingsData(
  db: Database,
  endMonth?: string,
  months: number = 6
): MonthlyIncomeExpense[] {
  const end = endMonth ?? new Date().toISOString().slice(0, 7);
  const [endYear, endMon] = end.split('-').map(Number);
  const endDate = new Date(endYear, endMon, 0).toISOString().slice(0, 10);

  const startDate = (() => {
    const d = new Date(endYear, endMon - months, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();

  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date) AS month,
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS expenses
    FROM transactions WHERE date >= @startDate AND date <= @endDate
    GROUP BY strftime('%Y-%m', date) ORDER BY month
  `).all({ startDate, endDate }) as { month: string; income: number; expenses: number }[];

  return rows.map((r) => {
    const savings = r.income - r.expenses;
    const savingsRate = r.income > 0 ? (savings / r.income) * 100 : 0;
    return { ...r, savings, savingsRate };
  });
}

// ── Rule queries ─────────────────────────────────────────────────────────────

export interface RuleRow {
  id: number;
  pattern: string;
  category: string;
  priority: number;
  is_regex: number;
  created_at: string;
  updated_at: string;
}

export function addRule(
  db: Database,
  pattern: string,
  category: string,
  priority: number = 0,
  isRegex: boolean = false
): number {
  const result = db.prepare(`
    INSERT INTO categorization_rules (pattern, category, priority, is_regex)
    VALUES (@pattern, @category, @priority, @is_regex)
  `).run({ pattern, category, priority, is_regex: isRegex ? 1 : 0 });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function updateRule(
  db: Database,
  id: number,
  updates: { pattern?: string; category?: string; priority?: number; is_regex?: boolean }
): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };

  if (updates.pattern !== undefined) { sets.push('pattern = @pattern'); params.pattern = updates.pattern; }
  if (updates.category !== undefined) { sets.push('category = @category'); params.category = updates.category; }
  if (updates.priority !== undefined) { sets.push('priority = @priority'); params.priority = updates.priority; }
  if (updates.is_regex !== undefined) { sets.push('is_regex = @is_regex'); params.is_regex = updates.is_regex ? 1 : 0; }

  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  const result = db.prepare(`UPDATE categorization_rules SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return (result as { changes: number }).changes > 0;
}

export function deleteRule(db: Database, id: number): boolean {
  const result = db.prepare('DELETE FROM categorization_rules WHERE id = @id').run({ id });
  return (result as { changes: number }).changes > 0;
}

export function getRules(db: Database): RuleRow[] {
  return db.prepare('SELECT * FROM categorization_rules ORDER BY priority DESC, id ASC').all() as RuleRow[];
}

export function matchRule(db: Database, description: string): { category: string; ruleId: number } | null {
  const rules = getRules(db);
  for (const rule of rules) {
    if (rule.is_regex) {
      try {
        if (new RegExp(rule.pattern, 'i').test(description)) {
          return { category: rule.category, ruleId: rule.id };
        }
      } catch {
        continue;
      }
    } else {
      // Glob-style: convert * to .*, case-insensitive
      const escaped = rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`, 'i').test(description)) {
        return { category: rule.category, ruleId: rule.id };
      }
    }
  }
  return null;
}

// ── Tax deduction queries ────────────────────────────────────────────────────

export interface TaxDeductionRow {
  id: number;
  transaction_id: number;
  irs_category: string;
  tax_year: number;
  notes: string | null;
  created_at: string;
}

export interface TaxSummaryRow {
  irs_category: string;
  total: number;
  count: number;
}

export function flagTaxDeduction(
  db: Database,
  transactionId: number,
  irsCategory: string,
  taxYear: number,
  notes?: string
): number {
  const result = db.prepare(`
    INSERT INTO tax_deductions (transaction_id, irs_category, tax_year, notes)
    VALUES (@transactionId, @irsCategory, @taxYear, @notes)
    ON CONFLICT(transaction_id) DO UPDATE SET
      irs_category = @irsCategory,
      tax_year = @taxYear,
      notes = @notes
  `).run({ transactionId, irsCategory, taxYear, notes: notes ?? null });
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export function unflagTaxDeduction(db: Database, transactionId: number): boolean {
  const result = db.prepare('DELETE FROM tax_deductions WHERE transaction_id = @transactionId').run({ transactionId });
  return (result as { changes: number }).changes > 0;
}

export function getTaxDeductions(
  db: Database,
  taxYear: number,
  irsCategory?: string
): (TaxDeductionRow & { date: string; description: string; amount: number })[] {
  const conditions = ['td.tax_year = @taxYear'];
  const params: Record<string, unknown> = { taxYear };
  if (irsCategory) {
    conditions.push('td.irs_category = @irsCategory');
    params.irsCategory = irsCategory;
  }
  return db.prepare(`
    SELECT td.*, t.date, t.description, t.amount
    FROM tax_deductions td
    JOIN transactions t ON t.id = td.transaction_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.date DESC
  `).all(params) as (TaxDeductionRow & { date: string; description: string; amount: number })[];
}

export function getTaxSummary(db: Database, taxYear: number): TaxSummaryRow[] {
  return db.prepare(`
    SELECT td.irs_category, SUM(ABS(t.amount)) AS total, COUNT(*) AS count
    FROM tax_deductions td
    JOIN transactions t ON t.id = td.transaction_id
    WHERE td.tax_year = @taxYear
    GROUP BY td.irs_category
    ORDER BY total DESC
  `).all({ taxYear }) as TaxSummaryRow[];
}

// ── Budget queries ───────────────────────────────────────────────────────────

export interface BudgetRow {
  id: number;
  category: string;
  monthly_limit: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetVsActualRow {
  category: string;
  monthly_limit: number;
  actual: number;
  remaining: number;
  percent_used: number;
  over: boolean;
}

/**
 * Set or update a budget limit for a category.
 */
export function setBudget(
  db: Database,
  category: string,
  monthlyLimit: number
): void {
  db.prepare(`
    INSERT INTO budgets (category, monthly_limit)
    VALUES (@category, @monthlyLimit)
    ON CONFLICT(category) DO UPDATE SET
      monthly_limit = @monthlyLimit,
      updated_at = datetime('now')
  `).run({ category, monthlyLimit });
}

/**
 * Remove a budget limit for a category.
 */
export function clearBudget(db: Database, category: string): boolean {
  const result = db.prepare('DELETE FROM budgets WHERE category = @category').run({ category });
  return (result as { changes: number }).changes > 0;
}

/**
 * Get all budget limits.
 */
export function getBudgets(db: Database): BudgetRow[] {
  return db.prepare('SELECT * FROM budgets ORDER BY category').all() as BudgetRow[];
}

/**
 * Compare budgets vs actual spending for a given month (YYYY-MM).
 */
export function getBudgetVsActual(
  db: Database,
  month: string
): BudgetVsActualRow[] {
  const startDate = `${month}-01`;
  // Compute end of month
  const [year, mon] = month.split('-').map(Number);
  const endDate = new Date(year, mon, 0).toISOString().slice(0, 10);

  const budgets = getBudgets(db);
  if (budgets.length === 0) return [];

  const results: BudgetVsActualRow[] = [];

  for (const budget of budgets) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(ABS(amount)), 0) AS actual
      FROM transactions
      WHERE category = @category
        AND date >= @startDate
        AND date <= @endDate
        AND amount < 0
    `).get({ category: budget.category, startDate, endDate }) as { actual: number };

    const actual = row.actual;
    const remaining = budget.monthly_limit - actual;
    const percentUsed = budget.monthly_limit > 0 ? Math.round((actual / budget.monthly_limit) * 100) : 0;

    results.push({
      category: budget.category,
      monthly_limit: budget.monthly_limit,
      actual,
      remaining,
      percent_used: percentUsed,
      over: actual > budget.monthly_limit,
    });
  }

  return results;
}
