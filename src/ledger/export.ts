import { listAccounts } from './accounts.js';
import { listEntries } from './journal.js';
import type { LedgerDatabase } from './storage.js';

export const JOURNAL_CSV_HEADER = [
  'entry_id',
  'date',
  'entry_memo',
  'external_id',
  'reverses_entry_id',
  'line_no',
  'account_code',
  'account_name',
  'debit_cents',
  'credit_cents',
  'line_memo',
] as const;

/** RFC 4180 field quoting; also neutralises spreadsheet formula prefixes. */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** General journal as CSV, one row per line, ordered by date then entry id. Amounts are integer cents. */
export function exportJournalCsv(db: LedgerDatabase, start?: string, end?: string): string {
  const names = new Map(listAccounts(db).map((a) => [a.code, a.name]));
  const out: string[] = [JOURNAL_CSV_HEADER.join(',')];
  for (const e of listEntries(db, start, end)) {
    for (const l of e.lines) {
      out.push(
        [
          e.id,
          e.date,
          e.memo,
          e.external_id,
          e.reverses_entry_id,
          l.line_no,
          l.account,
          names.get(l.account) ?? '',
          l.debit_cents,
          l.credit_cents,
          l.memo,
        ]
          .map(csvField)
          .join(','),
      );
    }
  }
  return out.join('\r\n') + '\r\n';
}
