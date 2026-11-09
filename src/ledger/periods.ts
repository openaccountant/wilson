import { appendAudit } from './audit.js';
import { assertIsoDate } from './dates.js';
import { LedgerValidationError, PeriodLockedError } from './errors.js';
import { withTransaction, type LedgerDatabase } from './storage.js';

/** End dates recorded by period_closed audit events, in audit order. */
export function auditedCloseDates(db: LedgerDatabase): string[] {
  const rows = db.prepare(`SELECT payload FROM ledger_audit WHERE type = 'period_closed' ORDER BY seq`).all() as {
    payload: string;
  }[];
  return rows.map((r) => (JSON.parse(r.payload) as { end_date: string }).end_date);
}

/**
 * Latest closed period end date, or null when nothing is closed. Takes the
 * later of the period-close table and the append-only audit log, so removing
 * a close row cannot reopen a period.
 */
export function lockedThrough(db: LedgerDatabase): string | null {
  const r = db.prepare('SELECT MAX(end_date) AS d FROM ledger_period_closes').get() as { d: string | null } | null;
  let locked = r?.d ?? null;
  for (const d of auditedCloseDates(db)) if (locked === null || d > locked) locked = d;
  return locked;
}

/** Throws PeriodLockedError when date <= the latest closed period end. */
export function assertDateOpen(db: LedgerDatabase, date: string): void {
  const locked = lockedThrough(db);
  if (locked !== null && date <= locked) throw new PeriodLockedError(date, locked);
}

/**
 * Closes every date up to and including endDate. Closing the current lock date
 * again is a no-op; closes only move forward.
 */
export function closePeriod(db: LedgerDatabase, at: string, endDate: string): string {
  assertIsoDate(endDate, 'end_date');
  return withTransaction(db, () => {
    const locked = lockedThrough(db);
    if (locked === endDate) return endDate;
    if (locked !== null && endDate < locked) {
      throw new LedgerValidationError(`cannot close ${endDate}: periods are already closed through ${locked}`);
    }
    db.prepare('INSERT INTO ledger_period_closes (end_date, closed_at) VALUES (?, ?)').run(endDate, at);
    appendAudit(db, at, 'period_closed', { end_date: endDate });
    return endDate;
  });
}
