import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Ledger, type AccountKind, type JournalLineInput } from '../../ledger/index.js';

/** Small deterministic PRNG so failures are reproducible from the seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: AccountKind[] = ['asset', 'asset', 'liability', 'equity', 'income', 'income', 'expense', 'expense'];

function randomLedger(seed: number) {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const ledger = new Ledger(new Database(':memory:'), { now: () => '2026-01-01T00:00:00.000Z' }).init();
  const codes = KINDS.map((kind, i) => {
    const code = `${kind}-${i}`;
    ledger.createAccount({ code, name: code, kind });
    return code;
  });

  const posted: number[] = [];
  const entries = int(20, 60);
  for (let n = 0; n < entries; n++) {
    const date = `${int(2024, 2026)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
    // Random debit amounts, then split the same total across random credit lines.
    const debits = Array.from({ length: int(1, 3) }, () => int(1, 5_000_000));
    const total = debits.reduce((s, d) => s + d, 0);
    const creditCount = int(1, 3);
    const credits: number[] = [];
    let remaining = total;
    for (let c = 0; c < creditCount - 1 && remaining > 1; c++) {
      const part = int(1, remaining - 1);
      credits.push(part);
      remaining -= part;
    }
    credits.push(remaining);
    const pick = () => codes[int(0, codes.length - 1)]!;
    const lines: JournalLineInput[] = [
      ...debits.map((d) => ({ account: pick(), debit_cents: d })),
      ...credits.map((c) => ({ account: pick(), credit_cents: c })),
    ];
    const e = ledger.postJournal({ date, memo: `r${n}`, lines });
    posted.push(e.id);
    if (rnd() < 0.15) {
      const victim = posted[int(0, posted.length - 1)]!;
      const orig = ledger.getEntry(victim)!;
      if (orig.reversed_by_entry_id === null && orig.reverses_entry_id === null) {
        ledger.voidJournal(victim, '2026-12-31', 'random void');
      }
    }
  }
  return { ledger, int };
}

const SEEDS = Array.from({ length: 25 }, (_, i) => 1000 + i * 7919);

describe('property: random balanced journals', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: TB balances, BS equation holds, GL agrees with TB, audit verifies`, () => {
      const { ledger, int } = randomLedger(seed);
      for (const asOf of ['2024-06-30', '2024-12-31', '2025-07-15', '2026-12-31']) {
        const tb = ledger.trialBalance(asOf);
        expect(tb.total_debit_cents).toBe(tb.total_credit_cents);
        expect(tb.balanced).toBe(true);
        for (const r of tb.rows) {
          expect(Number.isSafeInteger(r.debit_balance_cents)).toBe(true);
          expect(Number.isSafeInteger(r.credit_balance_cents)).toBe(true);
        }

        const bs = ledger.balanceSheet(asOf);
        expect(bs.total_assets_cents).toBe(bs.total_liabilities_cents + bs.total_equity_cents);
        expect(bs.balanced).toBe(true);

        // Current-year earnings equal the P&L for the fiscal year to date.
        const pl = ledger.profitLoss(`${asOf.slice(0, 4)}-01-01`, asOf);
        expect(bs.current_year_earnings_cents).toBe(pl.net_income_cents);
      }

      // GL closing balances agree with TB balances for every account.
      const end = '2026-12-31';
      const start = `${int(2024, 2026)}-0${int(1, 9)}-01`;
      const gl = ledger.generalLedger(start, end);
      const tb = ledger.trialBalance(end);
      for (const acct of gl.accounts) {
        const row = tb.rows.find((r) => r.code === acct.code)!;
        const net = row.debit_balance_cents - row.credit_balance_cents;
        expect(acct.closing_balance_cents).toBe(acct.normal_balance === 'debit' ? net : -net);
        const last = acct.lines.at(-1);
        if (last) expect(last.running_balance_cents).toBe(acct.closing_balance_cents);
      }

      expect(ledger.verifyAudit().ok).toBe(true);
    });
  }
});
