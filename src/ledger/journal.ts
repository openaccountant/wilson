import { getAccount } from './accounts.js';
import { appendAudit } from './audit.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { assertIsoDate } from './dates.js';
import {
  AlreadyVoidedError,
  ConflictError,
  InactiveAccountError,
  LedgerValidationError,
  NotFoundError,
  UnbalancedEntryError,
} from './errors.js';
import { addCents, assertCents, assertNonNegativeCents } from './money.js';
import { assertDateOpen } from './periods.js';
import { withTransaction, type LedgerDatabase } from './storage.js';
import type { JournalEntry, JournalLine, PostJournalInput } from './types.js';

interface EntryRow {
  id: number;
  date: string;
  memo: string;
  external_id: string | null;
  payload_hash: string;
  reverses_entry_id: number | null;
  created_at: string;
}

interface LineRow {
  entry_id: number;
  line_no: number;
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  memo: string | null;
}

interface NormalizedEntry {
  date: string;
  memo: string;
  external_id: string | null;
  reverses_entry_id: number | null;
  lines: JournalLine[];
}

/** Hash of the economically meaningful content of an entry (used for replay and integrity checks). */
export function entryPayloadHash(e: NormalizedEntry): string {
  return sha256Hex(
    canonicalJson({
      date: e.date,
      memo: e.memo,
      external_id: e.external_id,
      reverses_entry_id: e.reverses_entry_id,
      lines: e.lines.map((l) => [l.line_no, l.account, l.debit_cents, l.credit_cents, l.memo]),
    }),
  );
}

/** Validates shape, money and balance. Pure: does not touch the database. */
export function normalizeJournalInput(input: PostJournalInput): NormalizedEntry {
  if (!input || typeof input !== 'object') throw new LedgerValidationError('journal input is required');
  assertIsoDate(input.date, 'date');
  if (typeof input.memo !== 'string') throw new LedgerValidationError('memo must be a string');
  if (input.external_id !== undefined && (typeof input.external_id !== 'string' || input.external_id === '')) {
    throw new LedgerValidationError('external_id must be a non-empty string when provided');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new LedgerValidationError('a journal entry needs at least two lines');
  }
  let debits = 0;
  let credits = 0;
  const lines = input.lines.map((l, i): JournalLine => {
    const where = `lines[${i}]`;
    if (!l || typeof l.account !== 'string' || l.account === '') {
      throw new LedgerValidationError(`${where}.account is required`);
    }
    // Only an omitted side means zero; null or any other non-number is invalid money.
    const debit = l.debit_cents === undefined ? 0 : l.debit_cents;
    const credit = l.credit_cents === undefined ? 0 : l.credit_cents;
    assertNonNegativeCents(debit, `${where}.debit_cents`);
    assertNonNegativeCents(credit, `${where}.credit_cents`);
    if ((debit > 0) === (credit > 0)) {
      throw new LedgerValidationError(`${where} must have exactly one of debit_cents or credit_cents greater than zero`);
    }
    if (l.memo !== undefined && typeof l.memo !== 'string') {
      throw new LedgerValidationError(`${where}.memo must be a string`);
    }
    debits = addCents(debits, debit, 'total debits');
    credits = addCents(credits, credit, 'total credits');
    return { line_no: i + 1, account: l.account, debit_cents: debit, credit_cents: credit, memo: l.memo ?? null };
  });
  if (debits !== credits) throw new UnbalancedEntryError(debits, credits);
  return { date: input.date, memo: input.memo, external_id: input.external_id ?? null, reverses_entry_id: null, lines };
}

export function getEntry(db: LedgerDatabase, id: number): JournalEntry | null {
  const row = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id) as EntryRow | null | undefined;
  return row ? hydrate(db, row) : null;
}

export function getEntryByExternalId(db: LedgerDatabase, externalId: string): JournalEntry | null {
  const row = db.prepare('SELECT * FROM ledger_entries WHERE external_id = ?').get(externalId) as
    | EntryRow
    | null
    | undefined;
  return row ? hydrate(db, row) : null;
}

/** Entries ordered by (date, id), optionally limited to an inclusive date range. */
export function listEntries(db: LedgerDatabase, start?: string, end?: string): JournalEntry[] {
  const rows = db
    .prepare('SELECT * FROM ledger_entries WHERE date >= ? AND date <= ? ORDER BY date, id')
    .all(start ?? '0000-01-01', end ?? '9999-12-31') as EntryRow[];
  return rows.map((r) => hydrate(db, r));
}

function hydrate(db: LedgerDatabase, row: EntryRow): JournalEntry {
  const lines = db.prepare('SELECT * FROM ledger_lines WHERE entry_id = ? ORDER BY line_no').all(row.id) as LineRow[];
  const rev = db.prepare('SELECT id FROM ledger_entries WHERE reverses_entry_id = ?').get(row.id) as
    | { id: number }
    | null
    | undefined;
  return {
    id: row.id,
    date: row.date,
    memo: row.memo,
    external_id: row.external_id,
    reverses_entry_id: row.reverses_entry_id,
    reversed_by_entry_id: rev?.id ?? null,
    created_at: row.created_at,
    lines: lines.map((l) => ({
      line_no: l.line_no,
      account: l.account_code,
      debit_cents: l.debit_cents,
      credit_cents: l.credit_cents,
      memo: l.memo,
    })),
  };
}

/** Recomputes an entry's payload hash from its stored rows. */
export function storedEntryHash(db: LedgerDatabase, id: number): { stored: string; recomputed: string } | null {
  const row = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id) as EntryRow | null | undefined;
  if (!row) return null;
  const e = hydrate(db, row);
  return { stored: row.payload_hash, recomputed: entryPayloadHash(e) };
}

function insertEntry(db: LedgerDatabase, at: string, e: NormalizedEntry): { id: number; hash: string } {
  const hash = entryPayloadHash(e);
  const r = db
    .prepare(
      'INSERT INTO ledger_entries (date, memo, external_id, payload_hash, reverses_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    )
    .get(e.date, e.memo, e.external_id, hash, e.reverses_entry_id, at) as { id: number };
  const ins = db.prepare(
    'INSERT INTO ledger_lines (entry_id, line_no, account_code, debit_cents, credit_cents, memo) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const l of e.lines) ins.run(r.id, l.line_no, l.account, l.debit_cents, l.credit_cents, l.memo);
  return { id: r.id, hash };
}

/**
 * Refuses an entry that would push the ledger-wide debit (= credit) total past
 * Number.MAX_SAFE_INTEGER. Every report figure (per-account sums, balances,
 * trial-balance totals, net income, equity) is bounded by that total, so this
 * one check keeps all of them exact. It must hold before insert: the ledger is
 * append-only, so an overflow could never be undone (a void only adds more).
 */
function assertTotalsStaySafe(db: LedgerDatabase, lines: JournalLine[]): void {
  const r = db.prepare('SELECT COALESCE(SUM(debit_cents), 0) AS d, COALESCE(SUM(credit_cents), 0) AS c FROM ledger_lines').get() as {
    d: number;
    c: number;
  };
  let d = r.d;
  let c = r.c;
  assertCents(d, 'ledger total debits');
  assertCents(c, 'ledger total credits');
  for (const l of lines) {
    d = addCents(d, l.debit_cents, 'ledger total debits');
    c = addCents(c, l.credit_cents, 'ledger total credits');
  }
}

function assertAccountsPostable(db: LedgerDatabase, lines: JournalLine[]): void {
  for (const l of lines) {
    const acct = getAccount(db, l.account);
    if (!acct) throw new NotFoundError(`account ${l.account}`);
    if (!acct.active) throw new InactiveAccountError(l.account);
  }
}

/**
 * Posts a balanced entry atomically. With external_id, a replay of an identical
 * payload returns the original entry; a differing payload throws ConflictError.
 */
export function postJournal(db: LedgerDatabase, at: string, input: PostJournalInput): JournalEntry {
  const e = normalizeJournalInput(input);
  return withTransaction(db, () => {
    if (e.external_id !== null) {
      const existing = db.prepare('SELECT * FROM ledger_entries WHERE external_id = ?').get(e.external_id) as
        | EntryRow
        | null
        | undefined;
      if (existing) {
        if (existing.payload_hash === entryPayloadHash(e)) return hydrate(db, existing);
        throw new ConflictError(`external_id ${e.external_id} was already posted with a different payload`);
      }
    }
    assertDateOpen(db, e.date);
    assertAccountsPostable(db, e.lines);
    assertTotalsStaySafe(db, e.lines);
    const { id, hash } = insertEntry(db, at, e);
    appendAudit(db, at, 'journal_posted', {
      entry_id: id,
      payload_hash: hash,
      date: e.date,
      memo: e.memo,
      external_id: e.external_id,
      lines: e.lines,
    });
    return getEntry(db, id)!;
  });
}

/**
 * Voids an entry by appending a reversing entry (debits and credits swapped)
 * linked to the original. The original rows are never modified.
 */
export function voidJournal(db: LedgerDatabase, at: string, entryId: number, date: string, memo: string): JournalEntry {
  if (!Number.isSafeInteger(entryId)) throw new LedgerValidationError('entry_id must be an integer');
  assertIsoDate(date, 'date');
  if (typeof memo !== 'string') throw new LedgerValidationError('memo must be a string');
  return withTransaction(db, () => {
    const original = getEntry(db, entryId);
    if (!original) throw new NotFoundError(`journal entry ${entryId}`);
    if (original.reverses_entry_id !== null) {
      throw new LedgerValidationError(`journal entry ${entryId} is itself a reversal and cannot be voided`);
    }
    if (original.reversed_by_entry_id !== null) throw new AlreadyVoidedError(entryId);
    if (date < original.date) {
      throw new LedgerValidationError(`void date ${date} is before the original entry date ${original.date}`);
    }
    assertDateOpen(db, date);
    const reversal: NormalizedEntry = {
      date,
      memo,
      external_id: null,
      reverses_entry_id: entryId,
      lines: original.lines.map((l) => ({ ...l, debit_cents: l.credit_cents, credit_cents: l.debit_cents })),
    };
    assertTotalsStaySafe(db, reversal.lines);
    const { id, hash } = insertEntry(db, at, reversal);
    appendAudit(db, at, 'journal_voided', {
      entry_id: id,
      payload_hash: hash,
      reverses_entry_id: entryId,
      date,
      memo,
      lines: reversal.lines,
    });
    return getEntry(db, id)!;
  });
}
