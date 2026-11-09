import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { GENESIS_HASH } from '../../ledger/index.js';
import { makeLedger, simple } from './helpers.js';

/** Simulates an attacker with raw file access: drop the append-only guards first. */
function dropGuards(db: Database) {
  for (const t of ['entries', 'lines', 'audit']) {
    db.exec(`DROP TRIGGER ledger_${t}_no_update; DROP TRIGGER ledger_${t}_no_delete;`);
  }
}

function seeded() {
  const ctx = makeLedger();
  const a = ctx.ledger.postJournal(simple('2026-01-02', 'cash', 'capital', 100_000));
  const b = ctx.ledger.postJournal(simple('2026-01-03', 'supplies', 'cash', 2_500));
  ctx.ledger.voidJournal(b.id, '2026-01-04', 'void');
  ctx.ledger.closePeriod('2026-01-31');
  return { ...ctx, a, b };
}

describe('audit chain', () => {
  test('an untouched ledger verifies, chain starts at genesis', () => {
    const { ledger, db } = seeded();
    const v = ledger.verifyAudit();
    expect(v).toEqual({ ok: true, count: 5 + 2 + 1 + 1 });
    const first = db.prepare('SELECT prev_hash FROM ledger_audit WHERE seq = 1').get() as { prev_hash: string };
    expect(first.prev_hash).toBe(GENESIS_HASH);
  });

  test('detects an edited audit payload', () => {
    const { ledger, db } = seeded();
    dropGuards(db);
    db.exec(`UPDATE ledger_audit SET payload = replace(payload, '2500', '2600') WHERE seq = 7`);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.failed_seq).toBe(7);
  });

  test('detects a rewritten row even when its own hash is recomputed', () => {
    const { ledger, db } = seeded();
    dropGuards(db);
    // Attacker edits row 3 and fixes its hash, but row 4's prev_hash no longer links.
    db.exec(`UPDATE ledger_audit SET at = '2020-01-01T00:00:00.000Z', hash = '${'f'.repeat(64)}' WHERE seq = 3`);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.failed_seq).toBe(3);
  });

  test('detects a deleted audit row', () => {
    const { ledger, db } = seeded();
    dropGuards(db);
    db.exec('DELETE FROM ledger_audit WHERE seq = 4');
    expect(ledger.verifyAudit()).toMatchObject({ ok: false, failed_seq: 5 });
  });

  test('detects a truncated tail via missing journal events', () => {
    const { ledger, db } = seeded();
    dropGuards(db);
    db.exec('DELETE FROM ledger_audit WHERE seq >= 7');
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('no audit event');
  });

  test('detects tampering with journal lines behind the audit log', () => {
    const { ledger, db, a } = seeded();
    dropGuards(db);
    db.exec(`UPDATE ledger_lines SET debit_cents = 1 WHERE entry_id = ${a.id} AND line_no = 1`);
    db.exec(`UPDATE ledger_lines SET credit_cents = 1 WHERE entry_id = ${a.id} AND line_no = 2`);
    const v = ledger.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.failed_entry_id).toBe(a.id);
  });

  test('detects an entry inserted without an audit event', () => {
    const { ledger, db } = seeded();
    db.exec(
      `INSERT INTO ledger_entries (date, memo, payload_hash, created_at) VALUES ('2026-02-01', 'ghost', 'x', 'now')`,
    );
    expect(ledger.verifyAudit()).toMatchObject({ ok: false, reason: expect.stringContaining('no audit event') });
  });
});
