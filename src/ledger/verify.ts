import { readAudit, verifyChain, type AuditRow } from './audit.js';
import { storedEntryHash } from './journal.js';
import type { LedgerDatabase } from './storage.js';
import type { AuditVerification } from './types.js';

/**
 * Verifies the audit hash chain, then cross-checks the mutable-looking tables
 * against it:
 * - every journal entry's stored rows must still hash to the value recorded
 *   when it was posted, and every entry has exactly one audit event (and vice versa);
 * - the chart of accounts must equal the replay of account events (code, name,
 *   kind, active), so no account was added, removed or re-classified out of band;
 * - the period-close table must hold exactly the audited period_closed dates.
 */
export function verifyAudit(db: LedgerDatabase): AuditVerification {
  const rows = readAudit(db);
  const chain = verifyChain(rows);
  if (!chain.ok) return { ok: false, count: chain.count, failed_seq: chain.failed_seq, reason: chain.reason };

  const audited = new Map<number, string>();
  for (const r of rows) {
    if (r.type !== 'journal_posted' && r.type !== 'journal_voided') continue;
    const p = JSON.parse(r.payload) as { entry_id: number; payload_hash: string };
    if (audited.has(p.entry_id)) {
      return { ok: false, count: rows.length, failed_seq: r.seq, reason: `duplicate audit event for entry ${p.entry_id}` };
    }
    audited.set(p.entry_id, p.payload_hash);
  }

  const ids = (db.prepare('SELECT id FROM ledger_entries ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  for (const id of ids) {
    const auditedHash = audited.get(id);
    const fail = (reason: string): AuditVerification => ({ ok: false, count: rows.length, failed_entry_id: id, reason });
    if (auditedHash === undefined) return fail(`entry ${id} has no audit event`);
    const h = storedEntryHash(db, id)!;
    if (h.stored !== auditedHash) return fail(`entry ${id} payload_hash differs from audit`);
    if (h.recomputed !== auditedHash) return fail(`entry ${id} rows no longer match audited content`);
    audited.delete(id);
  }
  const orphan = audited.keys().next();
  if (!orphan.done) {
    return { ok: false, count: rows.length, failed_entry_id: orphan.value, reason: `audited entry ${orphan.value} is missing` };
  }

  const accountsReason = reconcileAccounts(db, rows);
  if (accountsReason) return { ok: false, count: rows.length, reason: accountsReason };
  const closesReason = reconcilePeriodCloses(db, rows);
  if (closesReason) return { ok: false, count: rows.length, reason: closesReason };
  return { ok: true, count: rows.length };
}

interface AccountState {
  name: string;
  kind: string;
  active: boolean;
}

function reconcileAccounts(db: LedgerDatabase, rows: AuditRow[]): string | null {
  const expected = new Map<string, AccountState>();
  for (const r of rows) {
    if (r.type === 'account_created') {
      const p = JSON.parse(r.payload) as { code: string; name: string; kind: string; active: boolean };
      if (expected.has(p.code)) return `account ${p.code} was created twice in the audit log`;
      expected.set(p.code, { name: p.name, kind: p.kind, active: p.active });
    } else if (r.type === 'account_active_changed') {
      const p = JSON.parse(r.payload) as { code: string; active: boolean };
      const a = expected.get(p.code);
      if (!a) return `audit changes account ${p.code} before it was created`;
      a.active = p.active;
    }
  }
  const actual = db.prepare('SELECT code, name, kind, active FROM ledger_accounts ORDER BY code').all() as {
    code: string;
    name: string;
    kind: string;
    active: number;
  }[];
  for (const a of actual) {
    const e = expected.get(a.code);
    if (!e) return `account ${a.code} has no account_created audit event`;
    if (a.kind !== e.kind) return `account ${a.code} kind is ${a.kind}, audit says ${e.kind}`;
    if (a.name !== e.name) return `account ${a.code} name differs from audit`;
    if ((a.active === 1) !== e.active) return `account ${a.code} active flag differs from audit`;
    expected.delete(a.code);
  }
  const missing = expected.keys().next();
  if (!missing.done) return `audited account ${missing.value} is missing`;
  return null;
}

function reconcilePeriodCloses(db: LedgerDatabase, rows: AuditRow[]): string | null {
  const audited = new Set<string>();
  for (const r of rows) {
    if (r.type === 'period_closed') audited.add((JSON.parse(r.payload) as { end_date: string }).end_date);
  }
  const actual = db.prepare('SELECT end_date FROM ledger_period_closes ORDER BY end_date').all() as { end_date: string }[];
  for (const c of actual) {
    if (!audited.has(c.end_date)) return `period close ${c.end_date} has no period_closed audit event`;
    audited.delete(c.end_date);
  }
  const missing = audited.values().next();
  if (!missing.done) return `audited period close ${missing.value} is missing`;
  return null;
}
