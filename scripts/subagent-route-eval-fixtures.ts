/**
 * Eval tooling (no product code): generates the persona books (accounts, month-end balance snapshots,
 * loans) and the human-readable summary a question writer reads (specs/eval/fixtures-v3.md).
 *
 *   bun scripts/subagent-route-eval-fixtures.ts [<personasDir>]
 *
 * Reads the synthetic persona seed files (never writes there) and writes
 *   scripts/subagent-route-eval/fixtures/v3/<persona>.book.json   (the harness loads these)
 *   specs/eval/fixtures-v3.md                                      (the summary)
 *
 * Every number is synthetic. Cash-like accounts that appear in a persona's transaction file are tied to
 * it: the June 2026 movement of their balance equals what the transactions in that file add up to, so
 * the books and the transactions tell one story. Loan balances come from the product's own amortization
 * schedule. See scripts/subagent-route-eval/fixtures/README.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { calculateAmortization } from '../src/tools/net-worth/amortization.js';
import type { AccountSubtype } from '../src/tools/net-worth/account-types.js';
import { PERSONAS, readPersonaRows, resolvePersonasDir } from './subagent-route-eval-personas.js';
import { DEFAULT_FIXTURES_DIR, loadPersonaBook, type BookAccount, type PersonaBook } from './subagent-route-eval-books.js';

export { loadPersonaBook };
export type { PersonaBook };

export const MONTH_ENDS = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'] as const;
const SPEC_SUMMARY_PATH = join(import.meta.dir, '..', 'specs', 'eval', 'fixtures-v3.md');

type Row = { date: string; description: string; amount: number; source_file: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── Specs ────────────────────────────────────────────────────────────────────

type Balances =
  /** Balance moves in June by sign * (sum of the matching rows of `file`); Jan-Apr are given. */
  | { kind: 'ledger'; file: string; match?: string; sign: 1 | -1; end: number; earlier: [number, number, number, number] }
  | { kind: 'series'; values: [number, number, number, number, number, number] }
  | {
      kind: 'loan';
      original_principal: number;
      rate: number;
      term_months: number;
      start_date: string;
      linked_asset_key?: string;
      notes: string;
    };

interface AccountSpec {
  key: string;
  name: string;
  type: 'asset' | 'liability';
  subtype: AccountSubtype;
  institution: string;
  last4: string;
  notes: string;
  balances: Balances;
}

const SPECS: Record<string, AccountSpec[]> = {
  '1-comingled-founder': [
    {
      key: 'checking', name: 'Founder Checking', type: 'asset', subtype: 'checking', institution: 'Northgate Bank', last4: '3301',
      notes: 'One checking account for both personal and business money.',
      balances: { kind: 'ledger', file: '1-comingled-founder/checking.csv', sign: 1, end: 6420.17, earlier: [3880.12, 4410.75, 2950.3, 3720.46] },
    },
    {
      key: 'tax_reserve', name: 'Tax Reserve Savings', type: 'asset', subtype: 'savings', institution: 'Northgate Bank', last4: '3388',
      notes: 'Set aside for estimated taxes. Last topped up in May.',
      balances: { kind: 'series', values: [1900, 2200, 2500, 2800, 3100, 3100] },
    },
    {
      key: 'robo', name: 'Roboinvest Portfolio', type: 'asset', subtype: 'investment', institution: 'Roboinvest', last4: '9012',
      notes: 'Automated investing account. Balance tracked by hand, no transactions.',
      balances: { kind: 'series', values: [7410.55, 7522.1, 7391.27, 7880.34, 8102.18, 8236.9] },
    },
    {
      key: 'brokerage', name: 'Brokerage Account', type: 'asset', subtype: 'investment', institution: 'Summit Brokerage', last4: '4477',
      notes: 'Taxable brokerage account. Balance tracked by hand, no transactions.',
      balances: { kind: 'series', values: [19420, 19905.12, 19488.33, 20577.61, 21011.07, 21305.4] },
    },
    {
      key: 'card', name: 'Founder Charge Card', type: 'liability', subtype: 'credit_card', institution: 'Charter Card Services', last4: '4471',
      notes: 'Charge card used for both personal and business spending. Balance is the amount owed.',
      balances: { kind: 'ledger', file: '1-comingled-founder/card.csv', sign: -1, end: 1284.67, earlier: [412.9, 980.15, 655.3, 1102.45] },
    },
  ],
  '2-new-grad': [
    {
      key: 'checking', name: 'Everyday Checking', type: 'asset', subtype: 'checking', institution: 'Bayfront Bank', last4: '7720',
      notes: 'Only account. Paid every other week.',
      balances: { kind: 'ledger', file: '2-new-grad/checking.csv', sign: 1, end: 1879.14, earlier: [1240.55, 905.2, 1480, 1115.75] },
    },
    {
      key: 'student_loan', name: 'Student Loan', type: 'liability', subtype: 'student_loan', institution: 'Navient', last4: '6150',
      notes: 'Federal-style student loan, paid in two installments of $210 each month.',
      balances: {
        kind: 'loan', original_principal: 38000, rate: 0.058, term_months: 120, start_date: '2025-07-01',
        notes: '10-year plan, first payment July 2025.',
      },
    },
  ],
  '3-dual-income-household': [
    {
      key: 'checking', name: 'Joint Checking', type: 'asset', subtype: 'checking', institution: 'Meridian Trust Bank', last4: '2234',
      notes: 'Both paychecks land here. June 30 balance is the statement ledger balance.',
      balances: { kind: 'ledger', file: '3-dual-income-household/joint-checking.ofx', sign: 1, end: 6588.61, earlier: [1020.35, 860.9, 1475.2, 730.45] },
    },
    {
      key: 'house_fund', name: 'House Fund Savings', type: 'asset', subtype: 'savings', institution: 'Meridian Trust Bank', last4: '2290',
      notes: 'Receives two $500 transfers from joint checking every month.',
      balances: { kind: 'ledger', file: '3-dual-income-household/joint-checking.ofx', match: 'SAVINGS HOUSE FUND', sign: -1, end: 14500, earlier: [9500, 10500, 11500, 12500] },
    },
    {
      key: 'k401', name: 'Joint 401(k)', type: 'asset', subtype: 'investment', institution: 'Harbor Steel Retirement Plan', last4: '5503',
      notes: 'Employer retirement plan. Balance tracked by hand, no transactions.',
      balances: { kind: 'series', values: [88410.22, 90155.8, 87904.35, 92233.1, 94870.66, 96412.3] },
    },
    {
      key: 'home', name: 'Family Home', type: 'asset', subtype: 'real_estate', institution: 'Self-estimated', last4: '0000',
      notes: 'Estimated market value, updated by hand.',
      balances: { kind: 'series', values: [438000, 438000, 440000, 440000, 440000, 440000] },
    },
    {
      key: 'mortgage', name: 'Home Mortgage', type: 'liability', subtype: 'mortgage', institution: 'Lakeview Home Loans', last4: '8841',
      notes: 'Thirty-year fixed mortgage on the family home.',
      balances: {
        kind: 'loan', original_principal: 350000, rate: 0.06, term_months: 360, start_date: '2022-03-01', linked_asset_key: 'home',
        notes: '30-year fixed, first payment March 2022.',
      },
    },
  ],
  '4-near-retiree': [
    {
      key: 'checking', name: 'Retirement Checking', type: 'asset', subtype: 'checking', institution: 'Old Mill Savings', last4: '1188',
      notes: 'Pension and Social Security land here.',
      balances: { kind: 'ledger', file: '4-near-retiree/checking.qif', sign: 1, end: 9860.45, earlier: [7210.88, 7655.4, 8302.15, 7480.62] },
    },
    {
      key: 'brokerage', name: 'Brokerage Account', type: 'asset', subtype: 'investment', institution: 'Summit Brokerage', last4: '6620',
      notes: 'Taxable brokerage account. Balance tracked by hand, no transactions.',
      balances: { kind: 'series', values: [301880.45, 305120.18, 296744.9, 303008.37, 309515.62, 312400.18] },
    },
    {
      key: 'ira', name: 'Rollover IRA', type: 'asset', subtype: 'investment', institution: 'Summit Brokerage', last4: '6631',
      notes: 'Retirement account rolled over from an employer plan. Balance tracked by hand, no transactions.',
      balances: { kind: 'series', values: [421300, 424880.55, 417330.21, 425610.78, 427954.09, 428950.31] },
    },
    {
      key: 'home', name: 'Paid-off Home', type: 'asset', subtype: 'real_estate', institution: 'Self-estimated', last4: '0000',
      notes: 'Estimated market value. No mortgage, which is why the property tax bill is the only housing payment.',
      balances: { kind: 'series', values: [385000, 385000, 385000, 385000, 385000, 385000] },
    },
  ],
  '5-single-parent': [
    {
      key: 'checking', name: 'Community Checking', type: 'asset', subtype: 'checking', institution: 'Eastside Credit Union', last4: '9904',
      notes: 'Only cash account. Starts June overdrawn and goes further negative before the mid-month paycheck.',
      balances: { kind: 'ledger', file: '5-single-parent/checking.csv', sign: 1, end: 577.2, earlier: [140.25, -60.1, 215.8, -120.45] },
    },
    {
      key: 'car', name: 'Used Sedan', type: 'asset', subtype: 'vehicle', institution: 'Self-estimated', last4: '0000',
      notes: 'Estimated resale value, falling a little each month.',
      balances: { kind: 'series', values: [11800, 11650, 11500, 11350, 11200, 11050] },
    },
    {
      key: 'auto_loan', name: 'Auto Loan', type: 'liability', subtype: 'auto_loan', institution: 'CarMax Financial', last4: '3320',
      notes: 'Five-year car loan, one payment of $265 each month.',
      balances: {
        kind: 'loan', original_principal: 13200, rate: 0.075, term_months: 60, start_date: '2024-08-01', linked_asset_key: 'car',
        notes: '60-month loan, first payment August 2024.',
      },
    },
  ],
};

/** Story paragraph per persona, neutral wording (what the person is, not how the product reads it). */
const STORIES: Record<string, string> = {
  '1-comingled-founder':
    'A solo founder with a day job and a consulting business who runs both through one checking account and one charge card. Roughly $7,300 comes in each month: $3,100 from the day job and $4,200 from two consulting clients. Savings and investments exist but there is no retirement account yet.',
  '2-new-grad':
    'A recent graduate with a retail job, paid $1,450 every other week, renting a place and paying down a student loan. One checking account, no savings or investments yet.',
  '3-dual-income-household':
    'Two earners (one at a steel company, one in health care) with a young child in daycare. They own a home with a mortgage, move $500 twice a month into a house-fund savings account, and have a 401(k). Roughly $10,900 comes in each month.',
  '4-near-retiree':
    'A retired teacher living on Social Security and a state pension (about $3,900 a month), with a brokerage account, a rollover IRA and a home with no mortgage.',
  '5-single-parent':
    'A single parent working at a medical practice with irregular paychecks, child support, childcare and a car loan. Money is tight: the checking account is overdrawn at times and there are no savings or investments.',
};

/** Caveat appended to a persona's in/out totals when they double count a transfer between its own accounts. */
const TOTALS_NOTE: Record<string, string> = {
  '1-comingled-founder': ' (the $600 card payment is counted on both sides: out of checking, in on the card)',
};

export interface Notable {
  /** Case-insensitive regex tested against the transaction description. */
  match: string;
  note: string;
}

/** Notable transactions per persona: the note says why it matters; the matching rows are listed under it. */
export const NOTABLE: Record<string, Notable[]> = {
  '1-comingled-founder': [
    { match: 'ADOBE CREATIVE CLOUD', note: 'Two identical charges on the same day, possibly a double billing.' },
    { match: 'CLIENT PAYMT', note: 'Consulting income from two clients lands in the same checking account as personal pay.' },
    { match: 'PAYROLL DEP', note: 'Day-job paycheck (personal income).' },
    { match: 'STATE QUARTERLY TAX PMT', note: 'Estimated quarterly tax payment, the second-largest outflow after rent.' },
    { match: 'TRANSFER TO CREDIT CARD|AMEX EPAYMENT', note: 'The card payment shows up twice: leaving checking and as a credit on the card.' },
    { match: 'UNION SQUARE|DELTA AIR|STAPLES|FEDEX', note: 'Business-looking card charges (client dinner, conference travel, office supplies, shipping) mixed in with personal ones.' },
  ],
  '2-new-grad': [
    { match: 'PAYROLL DEP', note: 'Two paychecks of $1,450, two weeks apart.' },
    { match: 'NAVIENT', note: 'Student loan paid in two installments of $210.' },
    { match: 'TICKETMASTER', note: 'One-off concert ticket, the largest discretionary purchase of the month.' },
    { match: 'RENT PAYMENT', note: 'Rent, the largest outflow.' },
  ],
  '3-dual-income-household': [
    { match: 'PAYROLL DEP', note: 'Two employers, each paying twice a month.' },
    { match: 'MORTGAGE', note: 'Mortgage payment, the largest outflow.' },
    { match: 'SUNSHINE DAYCARE', note: 'Daycare, the second-largest outflow.' },
    { match: 'TRANSFER TO SAVINGS HOUSE FUND', note: 'Two $500 transfers into the house-fund savings account.' },
    { match: 'COSTCO|WHOLE FOODS', note: 'The two big grocery runs.' },
  ],
  '4-near-retiree': [
    { match: 'SOCIAL SECURITY|PENSION', note: 'The only two income lines, together $3,900.' },
    { match: 'UNKNOWN MERCHANT', note: 'An unrecognized, uncategorized $412.60 charge from an unknown merchant (international-looking).' },
    { match: 'PROPERTY TAX', note: 'Property tax installment, the only housing payment since the home has no mortgage.' },
    { match: 'MEDIGAP|CVS', note: 'Health costs: Medigap premium and a pharmacy purchase.' },
    { match: 'GOLF CLUB', note: 'Monthly golf club dues.' },
  ],
  '5-single-parent': [
    { match: 'OVERDRAFT FEE', note: 'A $35 overdraft fee on 06/14, the account was negative when it hit.' },
    { match: 'PAYROLL DEP', note: 'Four paychecks of different sizes ($780, $612, $845, $598), irregular hours.' },
    { match: 'CHILD SUPPORT', note: 'Child support received, $400.' },
    { match: 'AUTO LOAN', note: 'Car loan payment, $265.' },
    { match: 'SUNRISE CHILDCARE', note: 'Childcare, the second-largest outflow after rent.' },
    { match: 'PEDIATRIC|SCHOOL SUPPLY', note: 'Child-related one-offs: a co-pay and a school fee.' },
  ],
};

// ── Generation ───────────────────────────────────────────────────────────────

/** Number of loan payments made by a month end, first payment in the start_date month. */
function paymentsMade(startDate: string, monthEnd: string): number {
  const [sy, sm] = startDate.split('-').map(Number);
  const [y, m] = monthEnd.split('-').map(Number);
  return (y - sy) * 12 + (m - sm) + 1;
}

function buildAccount(persona: string, spec: AccountSpec, rows: Row[]): BookAccount {
  const base = {
    key: spec.key,
    name: spec.name,
    account_type: spec.type,
    account_subtype: spec.subtype,
    institution: spec.institution,
    account_number_last4: spec.last4,
  };
  const b = spec.balances;
  let balances: number[];
  let ledger: BookAccount['ledger'];
  let loan: BookAccount['loan'];
  if (b.kind === 'series') {
    balances = [...b.values];
  } else if (b.kind === 'ledger') {
    const re = b.match ? new RegExp(b.match, 'i') : null;
    const net = rows.filter((r) => r.source_file === b.file && (!re || re.test(r.description))).reduce((s, r) => s + r.amount, 0);
    if (!rows.some((r) => r.source_file === b.file)) throw new Error(`${persona}: no rows from ${b.file}`);
    balances = [...b.earlier, round2(b.end - b.sign * net), b.end];
    ledger = { file: b.file, ...(b.match ? { match: b.match } : {}), sign: b.sign };
  } else {
    const sched = calculateAmortization({ principal: b.original_principal, annualRate: b.rate, termMonths: b.term_months, startDate: b.start_date });
    balances = MONTH_ENDS.map((d) => sched.payments[paymentsMade(b.start_date, d) - 1].balance);
    loan = {
      original_principal: b.original_principal,
      interest_rate: b.rate,
      term_months: b.term_months,
      start_date: b.start_date,
      extra_payment: 0,
      ...(b.linked_asset_key ? { linked_asset_key: b.linked_asset_key } : {}),
      notes: b.notes,
    };
  }
  const snapshots = MONTH_ENDS.map((date, i) => ({ date, balance: round2(balances[i]) }));
  return {
    ...base,
    current_balance: snapshots[snapshots.length - 1].balance,
    notes: spec.notes,
    ...(ledger ? { ledger } : {}),
    ...(loan ? { loan } : {}),
    snapshots,
  };
}

export function generatePersonaBook(persona: string, rows: Row[]): PersonaBook {
  const specs = SPECS[persona];
  if (!specs) throw new Error(`unknown persona ${persona}`);
  return {
    persona,
    as_of: MONTH_ENDS[MONTH_ENDS.length - 1],
    transaction_months: ['2026-06'],
    accounts: specs.map((s) => buildAccount(persona, s, rows)),
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

function money(n: number): string {
  const v = Math.abs(round2(n));
  const [i, f] = v.toFixed(2).split('.');
  return `${n < 0 && v !== 0 ? '-' : ''}$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}

const CASH = new Set(['checking', 'savings', 'cash']);

function totals(book: PersonaBook) {
  const assets = round2(book.accounts.filter((a) => a.account_type === 'asset').reduce((s, a) => s + a.current_balance, 0));
  const liabilities = round2(book.accounts.filter((a) => a.account_type === 'liability').reduce((s, a) => s + a.current_balance, 0));
  const cash = round2(book.accounts.filter((a) => a.account_type === 'asset' && CASH.has(a.account_subtype)).reduce((s, a) => s + a.current_balance, 0));
  return { assets, liabilities, netWorth: round2(assets - liabilities), cash };
}

function mdDate(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

const KIND: Record<string, string> = {
  checking: 'Checking', savings: 'Savings', investment: 'Investment', real_estate: 'Real estate', vehicle: 'Vehicle',
  mortgage: 'Mortgage', auto_loan: 'Auto loan', student_loan: 'Student loan', credit_card: 'Credit card',
};

function personaSection(book: PersonaBook, rows: Row[]): string {
  const p = book.persona;
  const t = totals(book);
  const out: string[] = [];
  out.push(`### ${p}`, '', STORIES[p], '');

  out.push('#### Accounts', '');
  out.push('| Account | Kind | Asset or debt | Institution | 05/31 | 06/30 (current) |', '|---|---|---|---|---:|---:|');
  for (const a of book.accounts) {
    out.push(`| ${a.name} | ${KIND[a.account_subtype] ?? a.account_subtype} | ${a.account_type === 'asset' ? 'Asset' : 'Debt (amount owed)'} | ${a.institution} | ${money(a.snapshots[4].balance)} | ${money(a.current_balance)} |`);
  }
  out.push('');
  out.push(`Totals at 06/30: assets ${money(t.assets)}, debts ${money(t.liabilities)}, **net worth ${money(t.netWorth)}**. Cash on hand (checking and savings): ${money(t.cash)}.`, '');
  for (const a of book.accounts) out.push(`- ${a.name}: ${a.notes}`);
  out.push('');

  const loans = book.accounts.filter((a) => a.loan);
  if (loans.length) {
    out.push('Loans:', '');
    for (const a of loans) {
      const l = a.loan!;
      const sched = calculateAmortization({ principal: l.original_principal, annualRate: l.interest_rate, termMonths: l.term_months, startDate: l.start_date });
      const linked = l.linked_asset_key ? book.accounts.find((x) => x.key === l.linked_asset_key)! : null;
      out.push(
        `- ${a.name}: borrowed ${money(l.original_principal)} at ${(l.interest_rate * 100).toFixed(2)}% over ${l.term_months} months, first payment ${l.start_date.slice(0, 7)}; scheduled payment ${money(sched.monthlyPayment)} a month; owed ${money(a.current_balance)} at 06/30.` +
          (linked ? ` Finances ${linked.name} (worth ${money(linked.current_balance)}, equity ${money(round2(linked.current_balance - a.current_balance))}).` : ''),
      );
    }
    out.push('');
  } else {
    out.push('Loans: none.', '');
  }

  out.push('Month-end balances (amounts owed for debts):', '');
  out.push(`| Account | ${MONTH_ENDS.map((d) => d.slice(5).replace('-', '/')).join(' | ')} |`, `|---|${MONTH_ENDS.map(() => '---:').join('|')}|`);
  for (const a of book.accounts) out.push(`| ${a.name} | ${a.snapshots.map((s) => money(s.balance)).join(' | ')} |`);
  out.push('');

  const income = round2(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const spend = round2(rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
  const dates = rows.map((r) => r.date).sort();
  out.push('#### Months covered', '');
  out.push(`- Transactions: June 2026 only (${mdDate(dates[0])} to ${mdDate(dates[dates.length - 1])}), ${rows.length} rows, ${money(income)} in and ${money(spend)} out${TOTALS_NOTE[p] ?? ''}. There is no transaction history before or after June 2026.`);
  out.push(`- Balances: one snapshot per account at each month end from January through June 2026 (${MONTH_ENDS.length} per account). Current balances are the 06/30 snapshots.`);
  const checking = book.accounts.find((a) => a.account_subtype === 'checking' && a.ledger);
  if (p === '5-single-parent' && checking) {
    let bal = checking.snapshots[4].balance;
    let min = { bal, date: 'start of month' };
    for (const r of rows.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      bal = round2(bal + r.amount);
      if (bal < min.bal) min = { bal, date: mdDate(r.date) };
    }
    out.push(`- Checking runs from ${money(checking.snapshots[4].balance)} on 05/31 down to a low of ${money(min.bal)} (after the ${min.date} entry) and ends June at ${money(checking.current_balance)}.`);
  }
  out.push('');

  out.push('#### Notable transactions', '');
  for (const n of NOTABLE[p]) {
    const re = new RegExp(n.match, 'i');
    const hit = rows.filter((r) => re.test(r.description));
    out.push(`- ${n.note}`);
    for (const r of hit) out.push(`  - ${mdDate(r.date)} ${r.description}: ${money(r.amount)}`);
  }
  out.push('');
  return out.join('\n');
}

export function renderFixturesSummary(books: PersonaBook[], rowsByPersona: Record<string, Row[]>): string {
  const out: string[] = [];
  out.push(
    '# Eval fixtures v3',
    '',
    'Synthetic people used to write and answer questions about a personal-finance book. Everything here is made up. Each person has a few accounts, a month-end balance history and the transactions of one month. This page describes exactly what is in each book so a question can be written from it alone.',
    '',
    '## Conventions',
    '',
    '- Dates are June 2026 for transactions. Balances are as of 06/30/2026 unless a column says otherwise.',
    '- Transaction amounts: money out (spending, payments, fees) is negative, money in (pay, refunds) is positive. A charge on a credit card is also stored negative, and a payment to the card is positive.',
    '- Debt balances (credit card, mortgage, loans) are amounts owed, shown as positive numbers. Net worth is assets minus debts.',
    '- "Cash on hand" means checking plus savings (plus physical cash, none here). Investments, homes and vehicles are not cash.',
    '- Each checking-style account moves during June by exactly what its transactions add up to, so the 05/31 and 06/30 balances agree with the transaction list.',
    '- Months before June have balances only, no transactions.',
    '',
    '## Overview',
    '',
    '| Person | Accounts | Assets | Debts | Net worth | Cash on hand |',
    '|---|---:|---:|---:|---:|---:|',
  );
  for (const b of books) {
    const t = totals(b);
    out.push(`| ${b.persona} | ${b.accounts.length} | ${money(t.assets)} | ${money(t.liabilities)} | ${money(t.netWorth)} | ${money(t.cash)} |`);
  }
  out.push('', '## Personas', '');
  for (const b of books) out.push(personaSection(b, rowsByPersona[b.persona]));
  return out.join('\n').replace(/\n+$/, '\n');
}

// ── Writing ──────────────────────────────────────────────────────────────────

export function writeFixtures(opts: { personasDir: string; outDir: string; summaryPath: string }): void {
  const seeds = resolve(opts.personasDir);
  const out = resolve(opts.outDir);
  const rel = relative(seeds, out);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new Error(`refusing to write inside the seed directory ${seeds}`);
  const rowsByPersona: Record<string, Row[]> = {};
  const books: PersonaBook[] = [];
  mkdirSync(out, { recursive: true });
  for (const p of PERSONAS) {
    const rows = readPersonaRows(opts.personasDir, p) as Row[];
    rowsByPersona[p] = rows;
    const book = generatePersonaBook(p, rows);
    books.push(book);
    writeFileSync(join(out, `${p}.book.json`), JSON.stringify(book, null, 2) + '\n');
  }
  mkdirSync(dirname(opts.summaryPath), { recursive: true });
  writeFileSync(opts.summaryPath, renderFixturesSummary(books, rowsByPersona));
}

if (import.meta.main) {
  const dir = process.argv[2] ?? resolvePersonasDir();
  if (!dir) throw new Error('no personas dir: pass one or set OA_PERSONAS_DIR');
  writeFixtures({ personasDir: dir, outDir: DEFAULT_FIXTURES_DIR, summaryPath: SPEC_SUMMARY_PATH });
  console.log(`wrote books to ${DEFAULT_FIXTURES_DIR} and ${SPEC_SUMMARY_PATH}`);
}
