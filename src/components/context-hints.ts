import { Container, Text } from '@mariozechner/pi-tui';
import type { Database } from '../db/compat-sqlite.js';
import { getTransactionCount, getUncategorizedCount, getBudgetCount } from '../db/queries.js';
import { getPlaidItems } from '../plaid/store.js';
import { theme } from '../theme.js';

/**
 * Single-line contextual hint displayed below the editor.
 * Queries DB state and shows the highest-priority actionable nudge.
 */
export class ContextHintsComponent extends Container {
  private readonly hintsText: Text;

  constructor() {
    super();
    this.hintsText = new Text('', 0, 0);
    this.addChild(this.hintsText);
  }

  refresh(db: Database): void {
    const hint = pickHint(db);
    this.hintsText.setText(hint);
  }
}

function pickHint(db: Database): string {
  // 1. Empty DB
  const txnCount = getTransactionCount(db);
  if (txnCount === 0) {
    return theme.muted('Type ') + theme.primaryLight('/import') + theme.muted(' or drag a CSV to get started');
  }

  // 2. Uncategorized transactions
  const uncatCount = getUncategorizedCount(db);
  if (uncatCount > 0) {
    return theme.muted(`${uncatCount} uncategorized transaction${uncatCount === 1 ? '' : 's'} \u2014 try `) + theme.primaryLight('/categorize');
  }

  // 3. Plaid linked but never synced
  try {
    const items = getPlaidItems();
    const unsynced = items.some((item) => item.cursor === null);
    if (unsynced) {
      return theme.muted('Bank linked but not synced \u2014 try ') + theme.primaryLight('/sync');
    }
  } catch {
    // Plaid store may not exist — skip this hint
  }

  // 4. No budgets set
  const budgetCount = getBudgetCount(db);
  if (budgetCount === 0) {
    return theme.muted('Track spending limits \u2014 try ') + theme.primaryLight('/budget set Dining 200');
  }

  // 5. Default fallback
  return theme.muted('Type a question, ') + theme.primaryLight('/help') + theme.muted(' for commands, or ') + theme.primaryLight('@') + theme.muted(' to reference a file');
}
