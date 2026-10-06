import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateAmortization } from '../tools/net-worth/amortization.js';
import { getNetWorthSummary, getEquitySummary, getLoans } from '../db/net-worth-queries.js';
import { mirrorGetNetWorthSummary, mirrorStartingCash } from '../dashboard/ui/src/store/mirror-networth.js';

// Computed imports: scripts/ is outside tsconfig's rootDir (same pattern as subagent-route-personas.test.ts).
const SCRIPTS = join(import.meta.dir, '..', '..', 'scripts');
const personas = (await import(join(SCRIPTS, 'subagent-route-eval-personas.ts'))) as {
  PERSONAS: readonly string[];
  resolvePersonasDir(): string | null;
  readPersonaRows(dir: string, persona: string): Array<{ date: string; description: string; amount: number; source_file: string; external_id?: string }>;
  buildPersonaFixture(dir: string, persona: string): Promise<{
    serverDb: import('../db/compat-sqlite.js').Database;
    mirror: import('../dashboard/ui/src/store/types.js').SqliteBinding;
  }>;
};
interface BookAccount {
  key: string;
  name: string;
  account_type: 'asset' | 'liability';
  account_subtype: string;
  current_balance: number;
  snapshots: Array<{ date: string; balance: number }>;
  ledger?: { file: string; match?: string; sign: 1 | -1 };
  loan?: { original_principal: number; interest_rate: number; term_months: number; start_date: string };
}
interface Book {
  persona: string;
  accounts: BookAccount[];
}
type Row = { date: string; description: string; amount: number; source_file: string; external_id?: string };
const fx = (await import(join(SCRIPTS, 'subagent-route-eval-fixtures.ts'))) as {
  NOTABLE: Record<string, Array<{ match: string; note: string }>>;
  loadPersonaBook(dir: string, persona: string): Book;
  generatePersonaBook(persona: string, rows: Row[]): Book;
  renderFixturesSummary(books: Book[], rows: Record<string, Row[]>): string;
  writeFixtures(opts: { personasDir: string; outDir: string; summaryPath: string }): void;
};

const { PERSONAS, resolvePersonasDir, readPersonaRows, buildPersonaFixture } = personas;
const DIR = resolvePersonasDir();
const t = DIR && existsSync(DIR) ? test : test.skip;

const FIXTURES_DIR = join(SCRIPTS, 'subagent-route-eval', 'fixtures', 'v3');
const SUMMARY_PATH = join(import.meta.dir, '..', '..', 'specs', 'eval', 'fixtures-v3.md');
const MONTH_ENDS = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'];
const cents = (n: number) => Math.round(n * 100) / 100;

function rowsFor(persona: string) {
  return readPersonaRows(DIR!, persona);
}

describe('persona books (accounts, balance snapshots, loans)', () => {
  t('every persona has a checked-in book with six month-end snapshots per account', () => {
    for (const p of PERSONAS) {
      const book = fx.loadPersonaBook(FIXTURES_DIR, p);
      expect(book.persona).toBe(p);
      expect(book.accounts.length).toBeGreaterThan(0);
      for (const a of book.accounts) {
        expect(a.snapshots.map((s) => s.date)).toEqual(MONTH_ENDS);
        expect(a.current_balance).toBe(a.snapshots[a.snapshots.length - 1].balance);
        expect(['asset', 'liability']).toContain(a.account_type);
      }
    }
  });

  t('generating from the seeds reproduces the checked-in books and summary byte for byte', () => {
    for (const p of PERSONAS) {
      const generated = fx.generatePersonaBook(p, rowsFor(p));
      expect(JSON.parse(JSON.stringify(generated))).toEqual(fx.loadPersonaBook(FIXTURES_DIR, p));
    }
    const books = PERSONAS.map((p) => fx.loadPersonaBook(FIXTURES_DIR, p));
    const rows = Object.fromEntries(PERSONAS.map((p) => [p, rowsFor(p)]));
    expect(fx.renderFixturesSummary(books, rows)).toBe(readFileSync(SUMMARY_PATH, 'utf8'));
  });

  t('ledger-backed accounts move in June by exactly the persona transactions', () => {
    for (const p of PERSONAS) {
      const book = fx.loadPersonaBook(FIXTURES_DIR, p);
      const rows = rowsFor(p);
      for (const a of book.accounts.filter((x) => x.ledger)) {
        const l = a.ledger!;
        const re = l.match ? new RegExp(l.match, 'i') : null;
        const net = rows
          .filter((r) => r.source_file === l.file && (!re || re.test(r.description)))
          .reduce((s, r) => s + r.amount, 0);
        const june = a.snapshots[5].balance;
        const may = a.snapshots[4].balance;
        expect(cents(june - may)).toBe(cents(l.sign * net));
      }
    }
  });

  t('stated statement balances are honored (BofA running balance, OFX ledger balance)', () => {
    const grad = fx.loadPersonaBook(FIXTURES_DIR, '2-new-grad');
    const gradChecking = grad.accounts.find((a) => a.account_subtype === 'checking')!;
    expect(gradChecking.snapshots[5].balance).toBe(1879.14); // last "Running Bal." in the file
    expect(gradChecking.snapshots[4].balance).toBe(800); // 2250.00 after the 06/02 payroll, minus 1450.00
    const hh = fx.loadPersonaBook(FIXTURES_DIR, '3-dual-income-household');
    expect(hh.accounts.find((a) => a.account_subtype === 'checking')!.snapshots[5].balance).toBe(6588.61); // LEDGERBAL
  });

  t('loan balances follow the amortization schedule and payments match the June transactions', () => {
    const expectedMonthly: Record<string, { match: RegExp; perMonth: number }> = {
      '2-new-grad': { match: /NAVIENT/, perMonth: 2 },
      '3-dual-income-household': { match: /MORTGAGE/, perMonth: 1 },
      '5-single-parent': { match: /AUTO LOAN/, perMonth: 1 },
    };
    let seen = 0;
    for (const p of PERSONAS) {
      const book = fx.loadPersonaBook(FIXTURES_DIR, p);
      for (const a of book.accounts.filter((x) => x.loan)) {
        seen++;
        const loan = a.loan!;
        expect(a.account_type).toBe('liability');
        expect(loan.interest_rate).toBeLessThan(1); // stored as a decimal fraction like the product tool
        const sched = calculateAmortization({
          principal: loan.original_principal,
          annualRate: loan.interest_rate,
          termMonths: loan.term_months,
          startDate: loan.start_date,
        });
        a.snapshots.forEach((s, i) => {
          const [y, m] = MONTH_ENDS[i].split('-').map(Number);
          const [sy, sm] = loan.start_date.split('-').map(Number);
          const paid = (y - sy) * 12 + (m - sm) + 1;
          expect(s.balance).toBe(sched.payments[paid - 1].balance);
        });
        const e = expectedMonthly[p];
        const juneTotal = rowsFor(p)
          .filter((r) => e.match.test(r.description))
          .reduce((s, r) => s + -r.amount, 0);
        expect(Math.abs(juneTotal - sched.monthlyPayment) / juneTotal).toBeLessThan(0.02);
      }
    }
    expect(seen).toBe(3);
  });

  t('personas match their stories', () => {
    const sub = (p: string) => fx.loadPersonaBook(FIXTURES_DIR, p).accounts.map((a) => a.account_subtype);
    // 1: life + business + balance-only investments, a card, no retirement account, no loans
    expect(sub('1-comingled-founder').filter((s) => s === 'investment')).toHaveLength(2);
    expect(sub('1-comingled-founder')).toContain('credit_card');
    expect(fx.loadPersonaBook(FIXTURES_DIR, '1-comingled-founder').accounts.some((a) => a.loan)).toBe(false);
    // 2: only checking plus the student loan
    expect(sub('2-new-grad').sort()).toEqual(['checking', 'student_loan']);
    // 3: joint checking, house-fund savings, 401k, home and mortgage
    expect(sub('3-dual-income-household').sort()).toEqual(['checking', 'investment', 'mortgage', 'real_estate', 'savings']);
    // 4: mortgage-free home, brokerage and retirement, no liabilities at all
    const near = fx.loadPersonaBook(FIXTURES_DIR, '4-near-retiree');
    expect(near.accounts.some((a) => a.account_type === 'liability')).toBe(false);
    expect(sub('4-near-retiree')).toContain('real_estate');
    expect(sub('4-near-retiree').filter((s) => s === 'investment')).toHaveLength(2);
    // 5: car loan with the car, nothing else
    expect(sub('5-single-parent').sort()).toEqual(['auto_loan', 'checking', 'vehicle']);
  });

  t('the single parent is overdrawn at some point in June', () => {
    const book = fx.loadPersonaBook(FIXTURES_DIR, '5-single-parent');
    const chk = book.accounts.find((a) => a.account_subtype === 'checking')!;
    const rows = rowsFor('5-single-parent').slice().sort((a, b) => a.date.localeCompare(b.date));
    let bal = chk.snapshots[4].balance;
    let min = bal;
    for (const r of rows) {
      bal += r.amount;
      min = Math.min(min, bal);
    }
    expect(min).toBeLessThan(0);
    expect(cents(bal)).toBe(chk.snapshots[5].balance);
  });

  t('unknown persona throws', () => {
    expect(() => fx.generatePersonaBook('nope', [])).toThrow();
  });
});

describe('applying a book to a fixture', () => {
  t('server db and mirror hold the accounts, snapshots and loans, and net worth matches the book', async () => {
    for (const p of PERSONAS) {
      const book = fx.loadPersonaBook(FIXTURES_DIR, p);
      const { serverDb, mirror } = await buildPersonaFixture(DIR!, p);
      const server = getNetWorthSummary(serverDb);
      const assets = cents(book.accounts.filter((a) => a.account_type === 'asset').reduce((s, a) => s + a.current_balance, 0));
      const liabilities = cents(book.accounts.filter((a) => a.account_type === 'liability').reduce((s, a) => s + a.current_balance, 0));
      expect(cents(server.totalAssets)).toBe(assets);
      expect(cents(server.totalLiabilities)).toBe(liabilities);
      expect(server.accounts).toHaveLength(book.accounts.length);

      const m = await mirrorGetNetWorthSummary(mirror);
      expect(cents(m.netWorth)).toBe(cents(assets - liabilities));
      const cash = book.accounts
        .filter((a) => a.account_type === 'asset' && ['checking', 'savings', 'cash'].includes(a.account_subtype))
        .reduce((s, a) => s + a.current_balance, 0);
      expect(cents(await mirrorStartingCash(mirror))).toBe(cents(cash));

      const snaps = (serverDb.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get() as { n: number }).n;
      expect(snaps).toBe(book.accounts.length * 6);
      const mirrorSnaps = (await mirror.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get()) as { n: number };
      expect(mirrorSnaps.n).toBe(snaps);
      expect(getLoans(serverDb)).toHaveLength(book.accounts.filter((a) => a.loan).length);
      const mirrorLoans = (await mirror.prepare('SELECT COUNT(*) AS n FROM loans').get()) as { n: number };
      expect(mirrorLoans.n).toBe(book.accounts.filter((a) => a.loan).length);
    }
  });

  t('loans link to their asset so equity is reported (home, car), and the near-retiree has no loans', async () => {
    const hh = await buildPersonaFixture(DIR!, '3-dual-income-household');
    const eq = getEquitySummary(hh.serverDb);
    expect(eq).toHaveLength(1);
    expect(eq[0].assetName).toMatch(/home/i);
    expect(eq[0].equity).toBeGreaterThan(0);
    const car = await buildPersonaFixture(DIR!, '5-single-parent');
    expect(getEquitySummary(car.serverDb)).toHaveLength(1);
    const near = await buildPersonaFixture(DIR!, '4-near-retiree');
    expect(getLoans(near.serverDb)).toHaveLength(0);
  });

  t('transactions are unchanged by the accounts (row counts stay as in Round 2)', async () => {
    const counts: Record<string, number> = {
      '1-comingled-founder': 21,
      '2-new-grad': 13,
      '3-dual-income-household': 13,
      '4-near-retiree': 11,
      '5-single-parent': 14,
    };
    for (const p of PERSONAS) {
      const { serverDb } = await buildPersonaFixture(DIR!, p);
      expect((serverDb.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(counts[p]);
    }
  });
});

describe('duplicate external ids (-dup2 approach)', () => {
  t('the second identical row gets -dup2 and the first keeps the product id', () => {
    const adobe = rowsFor('1-comingled-founder').filter((r) => r.description === 'ADOBE CREATIVE CLOUD');
    expect(adobe).toHaveLength(2);
    expect(adobe[1].external_id).toBe(`${adobe[0].external_id}-dup2`);
    expect(adobe[0].external_id).not.toMatch(/-dup/);
  });

  test('the fixture README documents the approach', () => {
    const readme = readFileSync(join(FIXTURES_DIR, '..', 'README.md'), 'utf8');
    expect(readme).toContain('-dup2');
    expect(readme).toContain('external_id');
    expect(readme).toContain('date|description|amount');
  });
});

describe('fixtures summary for the question writer', () => {
  test('is checked in and covers every persona with the required sections', () => {
    const md = readFileSync(SUMMARY_PATH, 'utf8');
    for (const p of PERSONAS) expect(md).toContain(p);
    expect((md.match(/^#### Accounts/gm) ?? []).length).toBe(5);
    expect((md.match(/^#### Months covered/gm) ?? []).length).toBe(5);
    expect((md.match(/^#### Notable transactions/gm) ?? []).length).toBe(5);
  });

  test('is free of product vocabulary (tool names, router, rules, expected answers)', () => {
    const md = readFileSync(SUMMARY_PATH, 'utf8');
    for (const banned of [
      'net_worth', 'forecast_', 'transaction_search', 'tool_', 'router', 'handoff', 'hand off',
      'answerNotes', 'MUTATION', 'expect', 'precision', 'held-out', 'heldout', 'template',
    ]) {
      expect(md.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  t('every notable-transaction rule matches at least one seed row', () => {
    for (const p of PERSONAS) {
      const rows = rowsFor(p);
      for (const n of fx.NOTABLE[p]) {
        expect(rows.some((r) => new RegExp(n.match, 'i').test(r.description))).toBe(true);
      }
    }
  });
});

describe('writeFixtures', () => {
  t('refuses to write inside the seed directory', () => {
    expect(() => fx.writeFixtures({ personasDir: DIR!, outDir: join(DIR!, 'oops'), summaryPath: join(tmpdir(), 'x.md') })).toThrow(/seed/i);
  });

  t('writes one book per persona plus the summary, deterministically', () => {
    const out = mkdtempSync(join(tmpdir(), 'oa-fixtures-'));
    const summary = join(out, 'fixtures-v3.md');
    fx.writeFixtures({ personasDir: DIR!, outDir: join(out, 'v3'), summaryPath: summary });
    for (const p of PERSONAS) {
      expect(readFileSync(join(out, 'v3', `${p}.book.json`), 'utf8')).toBe(readFileSync(join(FIXTURES_DIR, `${p}.book.json`), 'utf8'));
    }
    expect(readFileSync(summary, 'utf8')).toBe(readFileSync(SUMMARY_PATH, 'utf8'));
  });
});
