import type { Database } from '../db/compat-sqlite.js';
import { getBudgetVsActual } from '../db/queries.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  type: string;
  severity: AlertSeverity;
  message: string;
  category?: string;
  amount?: number;
}

/** Formats a non-negative dollar amount with `digits` decimals, including the '$'. */
export type AlertMoneyFormatter = (amount: number, digits: 0 | 2) => string;

/** The historical CLI/report text: '$1035', '$1234.56' (no separators). */
export const plainAlertMoney: AlertMoneyFormatter = (amount, digits) => `$${amount.toFixed(digits)}`;

/** Dashboard text: thousands separators — '$1,035', '$1,234.56'. */
export const groupedAlertMoney: AlertMoneyFormatter = (amount, digits) =>
  `$${amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export interface CheckAlertsOptions {
  /** Money formatter for alert messages; defaults to the historical plain form. */
  formatMoney?: AlertMoneyFormatter;
}

/**
 * Check all alert conditions and return active alerts.
 * All alerts are computed in real-time from existing data — no new tables needed.
 *
 * CLI, reports and the agent prompt call this with no options and keep the
 * historical message text byte-for-byte; the dashboard passes
 * groupedAlertMoney for thousands separators.
 */
export function checkAlerts(db: Database, opts: CheckAlertsOptions = {}): Alert[] {
  const fmt = opts.formatMoney ?? plainAlertMoney;
  const alerts: Alert[] = [];
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Budget alerts
  try {
    const budgets = getBudgetVsActual(db, currentMonth);
    for (const b of budgets) {
      if (b.percent_used >= 100) {
        alerts.push({
          type: 'budget_exceeded',
          severity: 'critical',
          message: `${b.category} budget exceeded by ${fmt(Math.abs(b.remaining), 0)} (${b.percent_used}% used)`,
          category: b.category,
          amount: Math.abs(b.remaining),
        });
      } else if (b.percent_used >= 80) {
        alerts.push({
          type: 'budget_warning',
          severity: 'warning',
          message: `${b.category} budget at ${b.percent_used}% — ${fmt(b.remaining, 0)} remaining`,
          category: b.category,
          amount: b.remaining,
        });
      }
    }
  } catch {
    // Budget check may fail if table doesn't exist yet
  }

  // Spending spike: any transaction in last 7 days > 2.5x merchant average
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const spikes = db.prepare(`
      SELECT t.description, t.amount, t.date, stats.avg_amount
      FROM transactions t
      JOIN (
        SELECT description, AVG(amount) AS avg_amount, COUNT(*) AS cnt
        FROM transactions WHERE amount < 0
        GROUP BY description HAVING cnt >= 3
      ) stats ON t.description = stats.description
      WHERE t.date >= @sevenDaysAgo AND t.amount < 0
        AND ABS(t.amount) > ABS(stats.avg_amount) * 2.5
      ORDER BY ABS(t.amount) DESC LIMIT 5
    `).all({ sevenDaysAgo }) as { description: string; amount: number; date: string; avg_amount: number }[];

    for (const s of spikes) {
      const multiplier = (Math.abs(s.amount) / Math.abs(s.avg_amount)).toFixed(1);
      alerts.push({
        type: 'spending_spike',
        severity: 'warning',
        message: `${s.description}: ${fmt(Math.abs(s.amount), 2)} on ${s.date} (${multiplier}x avg of ${fmt(Math.abs(s.avg_amount), 2)})`,
        amount: Math.abs(s.amount),
      });
    }
  } catch {
    // Spike detection is best-effort
  }

  // New recurring: any new recurring charge in last 30 days
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const newRecurring = db.prepare(`
      SELECT description, amount, MIN(date) AS first_date
      FROM transactions
      WHERE is_recurring = 1 AND date >= @thirtyDaysAgo
      GROUP BY description
      HAVING COUNT(*) = 1
      ORDER BY date DESC LIMIT 5
    `).all({ thirtyDaysAgo }) as { description: string; amount: number; first_date: string }[];

    for (const r of newRecurring) {
      alerts.push({
        type: 'new_recurring',
        severity: 'info',
        message: `New recurring charge: ${r.description} ${fmt(Math.abs(r.amount), 2)}/mo`,
        amount: Math.abs(r.amount),
      });
    }
  } catch {
    // Best-effort
  }

  return alerts;
}
