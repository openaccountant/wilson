import { Container, Text } from '@mariozechner/pi-tui';
import type { Database } from '../db/compat-sqlite.js';
import {
  getTransactionCount,
  getUncategorizedCount,
  getBudgetCount,
  getBudgetVsActual,
  getSpendingSummary,
  getMonthlySavingsData,
  getLastImportDate,
} from '../db/queries.js';
import { getPlaidItems } from '../plaid/store.js';
import { theme } from '../theme.js';

// ── Time helpers ─────────────────────────────────────────────────────────────

function daysAgo(isoDateString: string): number {
  const then = new Date(isoDateString);
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDaysAgo(days: number): string {
  if (days <= 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return '1 week ago';
  return `${weeks} weeks ago`;
}

// ── Data-driven hint builders ────────────────────────────────────────────────

function buildBudgetOverspendHints(db: Database): string[] {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rows = getBudgetVsActual(db, month);
  const hints: string[] = [];
  for (const row of rows) {
    if (row.over) {
      hints.push(
        theme.muted(`${row.category} is `) +
        theme.accent(`${row.percent_used}%`) +
        theme.muted(' of budget this month')
      );
    }
  }
  return hints;
}

function buildSpendingChangeHints(db: Database): string[] {
  const now = new Date();
  const thisStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const thisEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}-01`;
  const lastEnd = new Date(lastMonthDate.getFullYear(), lastMonthDate.getMonth() + 1, 0).toISOString().slice(0, 10);

  const thisSummary = getSpendingSummary(db, thisStart, thisEnd);
  const lastSummary = getSpendingSummary(db, lastStart, lastEnd);

  const lastMap = new Map(lastSummary.map((r) => [r.category, r.total]));
  const hints: string[] = [];

  for (const row of thisSummary) {
    if (row.category === 'Uncategorized') continue;
    const lastTotal = lastMap.get(row.category);
    if (lastTotal && lastTotal < 0 && row.total < 0) {
      const change = Math.round(((Math.abs(row.total) - Math.abs(lastTotal)) / Math.abs(lastTotal)) * 100);
      if (change >= 25) {
        hints.push(
          theme.muted(`${row.category} `) +
          theme.accent(`up ${change}%`) +
          theme.muted(' vs last month')
        );
      }
    }
  }
  return hints;
}

function buildSavingsHint(db: Database): string[] {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
  const data = getMonthlySavingsData(db, endMonth, 1);
  if (data.length === 0) return [];
  const row = data[0];
  if (row.income <= 0) return [];
  const rate = Math.round(row.savingsRate);
  return [
    theme.muted('Saved ') +
    theme.accent(`${rate}%`) +
    theme.muted(' of income last month'),
  ];
}

// ── Hint collection ──────────────────────────────────────────────────────────

export function collectHints(db: Database): string[] {
  const hints: string[] = [];
  const txnCount = getTransactionCount(db);

  // ── Onboarding hints ──────────────────────────────────────────────────────

  // 1. Empty DB
  if (txnCount === 0) {
    hints.push(
      theme.muted('Type ') + theme.accent('/import') + theme.muted(' or drag a CSV to get started')
    );
    // With empty DB, only show import + fallback
    hints.push(
      theme.muted('Type a question, ') + theme.accent('/help') + theme.muted(' for commands, or ') + theme.accent('@') + theme.muted(' to reference a file')
    );
    return hints;
  }

  // 2. Uncategorized transactions
  const uncatCount = getUncategorizedCount(db);
  if (uncatCount > 0) {
    hints.push(
      theme.muted(`${uncatCount} uncategorized transaction${uncatCount === 1 ? '' : 's'} \u2014 try `) +
      theme.accent('/categorize')
    );
  }

  // 3. Plaid linked but never synced
  try {
    const items = getPlaidItems();
    const unsynced = items.some((item) => item.cursor === null);
    if (unsynced) {
      hints.push(
        theme.muted('Bank linked but not synced \u2014 try ') + theme.accent('/sync')
      );
    }
  } catch {
    // Plaid store may not exist — skip this hint
  }

  // 4. No budgets set
  const budgetCount = getBudgetCount(db);
  if (budgetCount === 0) {
    hints.push(
      theme.muted('Track spending limits \u2014 try ') + theme.accent('/budget set Dining 200')
    );
  }

  // ── Time-aware hints ──────────────────────────────────────────────────────

  // 5. Last import staleness
  const lastImport = getLastImportDate(db);
  if (lastImport) {
    const days = daysAgo(lastImport);
    if (days >= 7) {
      hints.push(
        theme.muted(`Last import was ${formatDaysAgo(days)} \u2014 try `) + theme.accent('/import')
      );
    }
  }

  // 6. Plaid last sync staleness
  try {
    const items = getPlaidItems();
    for (const item of items) {
      if (item.cursor !== null && item.linkedAt) {
        const days = daysAgo(item.linkedAt);
        if (days >= 7) {
          hints.push(
            theme.muted(`Last sync was ${formatDaysAgo(days)} \u2014 try `) + theme.accent('/sync')
          );
          break; // One sync hint is enough
        }
      }
    }
  } catch {
    // Plaid store may not exist
  }

  // ── Data-driven insights ──────────────────────────────────────────────────

  // 7. Budget overspend
  hints.push(...buildBudgetOverspendHints(db));

  // 8. Month-over-month spending spike
  hints.push(...buildSpendingChangeHints(db));

  // 9. Savings rate
  hints.push(...buildSavingsHint(db));

  // ── Fallback ──────────────────────────────────────────────────────────────

  // 10. Always present
  hints.push(
    theme.muted('Type a question, ') + theme.accent('/help') + theme.muted(' for commands, or ') + theme.accent('@') + theme.muted(' to reference a file')
  );

  return hints;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Single-line contextual hint displayed below the editor.
 * Collects all applicable hints and rotates through them on each refresh.
 */
export class ContextHintsComponent extends Container {
  private readonly hintsText: Text;
  private hints: string[] = [];
  private hintIndex: number = 0;
  private lastPoolKey: string = '';

  constructor() {
    super();
    this.hintsText = new Text('', 0, 0);
    this.addChild(this.hintsText);
  }

  refresh(db: Database): void {
    const newHints = collectHints(db);
    const poolKey = newHints.join('\n');

    // Reset index if the hint pool changed
    if (poolKey !== this.lastPoolKey) {
      this.hintIndex = 0;
      this.lastPoolKey = poolKey;
    }

    this.hints = newHints;
    this.hintsText.setText(this.hints[this.hintIndex % this.hints.length]);
    this.hintIndex++;
  }
}
