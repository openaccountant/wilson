import { canonicalJson, sha256Hex } from './canonical.js';
import type { LedgerDatabase } from './storage.js';

export const GENESIS_HASH = '0'.repeat(64);

export type AuditEventType =
  | 'account_created'
  | 'account_active_changed'
  | 'journal_posted'
  | 'journal_voided'
  | 'period_closed';

export interface AuditRow {
  seq: number;
  at: string;
  type: AuditEventType;
  payload: string;
  prev_hash: string;
  hash: string;
}

/** hash = sha256(prev_hash + canonical JSON of {seq, at, type, payload}). */
export function computeAuditHash(prevHash: string, seq: number, at: string, type: string, payload: unknown): string {
  return sha256Hex(prevHash + canonicalJson({ seq, at, type, payload }));
}

/** Append one hash-chained event. Call inside the same transaction as the change it records. */
export function appendAudit(db: LedgerDatabase, at: string, type: AuditEventType, payload: unknown): AuditRow {
  const last = db.prepare('SELECT seq, hash FROM ledger_audit ORDER BY seq DESC LIMIT 1').get() as
    | { seq: number; hash: string }
    | null
    | undefined;
  const seq = last ? last.seq + 1 : 1;
  const prevHash = last ? last.hash : GENESIS_HASH;
  const payloadJson = canonicalJson(payload);
  const hash = computeAuditHash(prevHash, seq, at, type, payload);
  db.prepare('INSERT INTO ledger_audit (seq, at, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)').run(
    seq,
    at,
    type,
    payloadJson,
    prevHash,
    hash,
  );
  return { seq, at, type, payload: payloadJson, prev_hash: prevHash, hash };
}

export function readAudit(db: LedgerDatabase): AuditRow[] {
  return db.prepare('SELECT seq, at, type, payload, prev_hash, hash FROM ledger_audit ORDER BY seq').all() as AuditRow[];
}

export type ChainCheck = { ok: true; count: number } | { ok: false; count: number; failed_seq: number; reason: string };

/** Walks the chain: contiguous seqs, prev links, and recomputed hashes. */
export function verifyChain(rows: AuditRow[]): ChainCheck {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const fail = (reason: string): ChainCheck => ({ ok: false, count: rows.length, failed_seq: r.seq, reason });
    if (r.seq !== i + 1) return fail(`sequence gap: expected seq ${i + 1}`);
    if (r.prev_hash !== prev) return fail('prev_hash does not link to previous row');
    let payload: unknown;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      return fail('payload is not valid JSON');
    }
    if (canonicalJson(payload) !== r.payload) return fail('payload is not in canonical form');
    if (computeAuditHash(r.prev_hash, r.seq, r.at, r.type, payload) !== r.hash) return fail('hash mismatch');
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
