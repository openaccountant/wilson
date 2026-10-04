/**
 * Empty or all-zero tool results (specs/DECISIONS.md "Round 3", "Empty results").
 *
 * A result that carries nothing must never be answered locally from a template or a model: a bare
 * "$0.00" reads as a real figure, and an empty window ("October 2026" on June data) is the server
 * agent's to explain. Applies to EVERY read tool.
 *
 * Judged per tool on the MONEY fields only. Counting every number in the payload (as the grounding
 * check does) would let structural numbers such as `horizonMonths: 3` make an all-$0 forecast look
 * non-empty. Unknown shapes are NOT called empty: the template then fails to render and the run
 * hands off as `no-answer`, which is also safe.
 */

import type { ReadToolName } from '../store/mirror-tools.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Accumulates the money values of one result: were any present, was any non-zero. */
class Money {
  seen = false;
  nonzero = false;
  add(v: unknown): void {
    const n = num(v);
    if (n === undefined) return;
    this.seen = true;
    if (n !== 0) this.nonzero = true;
  }
  addRows(rows: unknown, key: string): void {
    if (!Array.isArray(rows)) return;
    for (const r of rows) if (isRecord(r)) this.add(r[key]);
  }
}

/** True when `data` is empty or every money figure in it is zero. */
export function isEmptyResult(tool: ReadToolName, data: unknown): boolean {
  if (data === undefined || data === null) return true;
  if (!isRecord(data)) return false;
  const m = new Money();

  switch (tool) {
    case 'transaction_search': {
      const count = num(data.count);
      if (count !== undefined) return count === 0;
      if (Array.isArray(data.transactions)) return data.transactions.length === 0;
      return false;
    }
    case 'spending_summary': {
      m.add(data.totalSpending);
      m.add(data.transactionCount);
      m.addRows(data.categories, 'total');
      break;
    }
    case 'profit_loss': {
      m.add(data.totalIncome);
      m.add(data.totalExpenses);
      m.add(data.netProfitLoss ?? data.netProfit);
      m.addRows(data.incomeByCategory, 'total');
      m.addRows(data.expensesByCategory, 'total');
      break;
    }
    case 'net_worth': {
      if (typeof data.message === 'string' && num(data.netWorth) === undefined) return true;
      m.add(data.netWorth);
      m.add(data.totalAssets);
      m.add(data.totalLiabilities);
      for (const group of [data.assets, data.liabilities]) {
        m.addRows(group, 'total');
        m.addRows(group, 'balance');
      }
      break;
    }
    case 'forecast': {
      // Round 4: a forecast is only as real as its trailing window. `startingCash` (and the flat
      // `projection` / `horizonEndCash` it implies) is a balance, not evidence of any cash flow: with
      // zero trailing income, expense and net the "forecast" is just today's balance repeated, so it
      // must not make the result look non-empty. A what-if adjustment is data the user asked for.
      for (const k of ['trailingMonthlyIncome', 'trailingMonthlyExpense', 'trailingMonthlyNet', 'adjustedMonthlyNet']) m.add(data[k]);
      m.addRows(data.appliedAdjustments, 'monthlyImpact');
      break;
    }
    default:
      return false;
  }
  return m.seen && !m.nonzero;
}
