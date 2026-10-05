/**
 * Build the categorize fixture set from the demo-cf persona seed files.
 *
 *   bun scripts/structured-output-spike/build-fixtures.ts
 *
 * The seed data carries no category labels (the Chase "Category" column is
 * blank), so `expected` comes from the merchant rules below, a hand-curated
 * reference for these fictional merchants. Rows with no rule get
 * expected = null and are excluded from accuracy scoring. Batches are sampled
 * with a seeded PRNG so the fixture file is reproducible.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const personasDir = join(here, '..', 'demos', 'personas');
const outFile = join(here, '..', '..', 'src', '__tests__', 'fixtures', 'structured-output', 'categorize-batches.json');

interface Row { persona: string; description: string; amount: number; date: string }

const RULES: Array<[RegExp, string]> = [
  [/PAYROLL|CLIENT PAYMT|SOCIAL SECURITY|PENSION|CHILD SUPPORT/i, 'Income'],
  [/TRANSFER TO|EPAYMENT/i, 'Transfer'],
  [/RENT PAYMENT|MORTGAGE|PROPERTY TAX/i, 'Home'],
  [/WHOLE FOODS|TRADER JOE|GROCERY OUTLET|COSTCO/i, 'Groceries'],
  [/CHIPOTLE|RAMEN|CAFE|DINNER/i, 'Dining'],
  [/NETFLIX|ADOBE|APPLE\.COM|COMCAST/i, 'Subscriptions'],
  [/CONED|VERIZON|POWER AND WATER/i, 'Utilities'],
  [/PLANET FITNESS|GYM|CVS|PEDIATRIC|GOLF/i, 'Health'],
  [/TICKETMASTER/i, 'Entertainment'],
  [/DELTA AIR/i, 'Travel'],
  [/UBER|CARMAX/i, 'Transport'],
  [/STAPLES|FEDEX|TARGET|DOLLAR GENERAL/i, 'Shopping'],
  [/STUDENT LOAN|NAVIENT|SCHOOL SUPPLY/i, 'Education'],
  [/INSURANCE|MEDIGAP/i, 'Insurance'],
  [/OVERDRAFT/i, 'Fees & Interest'],
  [/GIFT/i, 'Gifts'],
  [/DAYCARE|CHILDCARE/i, 'Other'],
  [/TAX PMT/i, 'Other'],
];

const toIso = (d: string) => (/^\d\d\/\d\d\/\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(0, 2)}-${d.slice(3, 5)}` : d);

function csvRows(persona: string, file: string, cols: { date: string; desc: string; amount: string }): Row[] {
  const [head, ...lines] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const h = head.split(',');
  return lines.map((l) => {
    const c = l.split(',');
    return { persona, date: toIso(c[h.indexOf(cols.date)]), description: c[h.indexOf(cols.desc)], amount: Number(c[h.indexOf(cols.amount)]) };
  });
}

function qifRows(persona: string, file: string): Row[] {
  const rows: Row[] = [];
  let cur: Partial<Row> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('D')) cur.date = toIso(line.slice(1));
    else if (line.startsWith('T')) cur.amount = Number(line.slice(1).replace(/,/g, ''));
    else if (line.startsWith('P')) cur.description = line.slice(1);
    else if (line.startsWith('^') && cur.description) rows.push({ persona, ...(cur as Omit<Row, 'persona'>) }), (cur = {});
  }
  return rows;
}

function ofxRows(persona: string, file: string): Row[] {
  const txt = readFileSync(file, 'utf8');
  return [...txt.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/g)].map((m) => {
    const f = (t: string) => m[1].match(new RegExp(`<${t}>([^<\\r\\n]+)`))?.[1].trim() ?? '';
    const d = f('DTPOSTED');
    return { persona, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, description: f('NAME'), amount: Number(f('TRNAMT')) };
  });
}

const pool: Row[] = [];
for (const dir of readdirSync(personasDir).filter((d) => /^\d-/.test(d))) {
  const p = join(personasDir, dir);
  for (const f of readdirSync(p)) {
    const path = join(p, f);
    if (f === 'card.csv') pool.push(...csvRows(dir, path, { date: 'Date', desc: 'Description', amount: 'Amount' }));
    else if (f.endsWith('.csv')) pool.push(...csvRows(dir, path, { date: f && readFileSync(path, 'utf8').startsWith('Transaction Date') ? 'Transaction Date' : 'Date', desc: 'Description', amount: 'Amount' }));
    else if (f.endsWith('.qif')) pool.push(...qifRows(dir, path));
    else if (f.endsWith('.ofx')) pool.push(...ofxRows(dir, path));
  }
}

// Card exports (Amex) list charges as positive; wilson's convention is expenses negative.
for (const r of pool) if (r.persona.startsWith('1-') && r.amount > 0 && !/CLIENT PAYMT|PAYROLL/.test(r.description)) r.amount = -r.amount;

const expectedFor = (d: string) => RULES.find(([re]) => re.test(d))?.[1] ?? null;

// mulberry32, seeded so reruns produce identical fixtures
let seed = 168;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const batches = Array.from({ length: 50 }, (_, i) => {
  const size = 5 + Math.floor(rnd() * 11); // 5..15
  // Single-persona batches for the first 25 (mirrors an import), mixed after.
  const personas = [...new Set(pool.map((r) => r.persona))];
  const src = i < 25 ? pool.filter((r) => r.persona === personas[i % personas.length]) : pool;
  const picked = [...src].sort(() => rnd() - 0.5).slice(0, Math.min(size, src.length));
  return {
    id: `batch-${String(i + 1).padStart(2, '0')}`,
    transactions: picked.map((r, j) => ({
      id: 1000 + i * 100 + j,
      description: r.description,
      amount: r.amount,
      date: r.date,
      expected: expectedFor(r.description),
    })),
  };
});

writeFileSync(outFile, JSON.stringify({ source: 'scripts/demos/personas', poolSize: pool.length, batches }, null, 2) + '\n');
const labeled = batches.flatMap((b) => b.transactions).filter((t) => t.expected).length;
console.log(`pool=${pool.length} batches=${batches.length} rows=${batches.flatMap((b) => b.transactions).length} labeled=${labeled}`);
console.log('unlabeled pool descriptions:', [...new Set(pool.filter((r) => !expectedFor(r.description)).map((r) => r.description))]);
