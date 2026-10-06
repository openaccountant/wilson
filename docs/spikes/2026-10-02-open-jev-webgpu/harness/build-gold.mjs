// Builds gold/categorize.json and gold/route.json. Persona data is SYNTHETIC (fictional merchants).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
// Synthetic persona CSVs. Override with OA_PERSONAS_DIR; the default is <repo root>/scripts/demos/personas
// (this file lives at docs/spikes/<spike>/harness/, four levels below the repo root).
const P = process.env.OA_PERSONAS_DIR ?? resolve(import.meta.dirname, '../../../../scripts/demos/personas');
if (!existsSync(P)) {
  console.error(`persona fixtures not found at ${P}; set OA_PERSONAS_DIR to the synthetic scripts/demos/personas directory`);
  process.exit(1);
}
const iso = (mdy) => { const [m, d, y] = mdy.split('/'); return `${y}-${m}-${d}`; };
const rows = [];
const csv = (file, persona, cols, flip = false) => {
  const lines = readFileSync(`${P}/${file}`, 'utf8').trim().split('\n').slice(1);
  for (const l of lines) {
    const f = l.split(','); // no quoted commas in these fixtures
    const get = (k) => f[cols[k]];
    let amt = Number(get('amount'));
    if (flip) amt = -amt; // Amex-shaped card: positive = charge; wilson: negative = expense
    rows.push({ persona, file, description: get('description'), amount: amt, date: iso(get('date')) });
  }
};
csv('1-comingled-founder/checking.csv', 1, { date: 0, description: 2, amount: 5 });
csv('1-comingled-founder/card.csv', 1, { date: 0, description: 1, amount: 3 }, true);
csv('2-new-grad/checking.csv', 2, { date: 0, description: 1, amount: 2 });
csv('5-single-parent/checking.csv', 5, { date: 0, description: 1, amount: 2 });
// QIF
for (const blk of readFileSync(`${P}/4-near-retiree/checking.qif`, 'utf8').split('^')) {
  const g = (c) => (blk.split('\n').find((l) => l.startsWith(c)) ?? '').slice(1).trim();
  if (g('D')) rows.push({ persona: 4, file: '4-near-retiree/checking.qif', description: g('P'), amount: Number(g('T')), date: iso(g('D')) });
}
// OFX
for (const m of readFileSync(`${P}/3-dual-income-household/joint-checking.ofx`, 'utf8').matchAll(/<DTPOSTED>(\d{4})(\d{2})(\d{2})[\s\S]*?<TRNAMT>([-\d.]+)[\s\S]*?<NAME>([^\n<]+)/g))
  rows.push({ persona: 3, file: '3-dual-income-household/joint-checking.ofx', description: m[5].trim(), amount: Number(m[4]), date: `${m[1]}-${m[2]}-${m[3]}` });

// Obvious-label map (substring -> wilson category). Rows matching nothing are left out on purpose
// (ambiguous: student loan, daycare, golf club, tax payments, auto loan, FedEx, property tax).
const LABELS = [
  ['PAYROLL DEP', 'Income'], ['CLIENT PAYMT', 'Income'], ['SOCIAL SECURITY', 'Income'], ['PENSION DISBURSEMENT', 'Income'], ['CHILD SUPPORT', 'Income'],
  ['RENT PAYMENT', 'Home'], ['MORTGAGE PAYMENT', 'Home'],
  ['WHOLE FOODS', 'Groceries'], ["TRADER JOE", 'Groceries'], ['GROCERY OUTLET', 'Groceries'], ['COSTCO', 'Groceries'],
  ['CHIPOTLE', 'Dining'], ['RAMEN HOUSE', 'Dining'], ['UNION SQUARE CAFE', 'Dining'],
  ['ADOBE CREATIVE', 'Subscriptions'], ['NETFLIX', 'Subscriptions'], ['APPLE.COM/BILL', 'Subscriptions'],
  ['CONED', 'Utilities'], ['VERIZON', 'Utilities'], ['COMCAST', 'Utilities'], ['CITY POWER AND WATER', 'Utilities'],
  ['GYM MEMBERSHIP', 'Health'], ['PLANET FITNESS', 'Health'], ['CVS PHARMACY', 'Health'], ['PEDIATRIC CO-PAY', 'Health'],
  ['TICKETMASTER', 'Entertainment'], ['DELTA AIR', 'Travel'], ['UBER TRIP', 'Transport'],
  ['STATE FARM', 'Insurance'], ['MEDIGAP', 'Insurance'], ['OVERDRAFT FEE', 'Fees & Interest'],
  ['TRANSFER TO CREDIT CARD', 'Transfer'], ['TRANSFER TO SAVINGS', 'Transfer'], ['AMEX EPAYMENT', 'Transfer'],
  ['STAPLES', 'Shopping'], ['TARGET', 'Shopping'], ['DOLLAR GENERAL', 'Shopping'],
  ['SCHOOL SUPPLY FEE', 'Education'], ['GRANDKIDS GIFT', 'Gifts'], ['UNKNOWN MERCHANT', 'Other'],
];
const gold = [];
for (const r of rows) {
  const hit = LABELS.find(([k]) => r.description.toUpperCase().includes(k));
  if (hit) gold.push({ ...r, expected: hit[1] });
}
const cnt = {}; const capped = [];
for (const g of gold) { cnt[g.expected] = (cnt[g.expected] ?? 0) + 1; if (cnt[g.expected] <= 6) capped.push(g); }
gold.length = 0; gold.push(...capped);
const skipped = rows.filter((r) => !LABELS.some(([k]) => r.description.toUpperCase().includes(k))).map((r) => r.description);
mkdirSync('gold', { recursive: true });
writeFileSync('gold/categorize.json', JSON.stringify(gold, null, 1));
const dist = {}; for (const g of gold) dist[g.expected] = (dist[g.expected] ?? 0) + 1;
console.log('parsed', rows.length, 'gold', gold.length, dist, '\nskipped:', skipped);

// Tool-route questions. expected in: transaction_search spending_summary profit_loss net_worth forecast none
const Q = [
  ['Show me every Whole Foods charge last month', 'transaction_search'],
  ['Find all transactions over $200 in June', 'transaction_search'],
  ['When did I last pay Comcast?', 'transaction_search'],
  ['List my Uber rides this year', 'transaction_search'],
  ['Did I get charged twice by Adobe?', 'transaction_search'],
  ['Search for anything from Ticketmaster', 'transaction_search'],
  ['Where did my money go this month?', 'spending_summary'],
  ['Break down my spending by category for the quarter', 'spending_summary'],
  ['How much did I spend on dining compared to last month?', 'spending_summary'],
  ['What are my biggest expense categories this year?', 'spending_summary'],
  ['Am I spending more on groceries than before?', 'spending_summary'],
  ['Give me a profit and loss for last quarter', 'profit_loss'],
  ['How much did my business make versus spend in May?', 'profit_loss'],
  ['Income vs expenses for the year so far', 'profit_loss'],
  ['Did I come out ahead last month?', 'profit_loss'],
  ['P&L by category for this month', 'profit_loss'],
  ['What is my net worth?', 'net_worth'],
  ['Show my net worth trend over the last 12 months', 'net_worth'],
  ['Give me my balance sheet with assets and liabilities', 'net_worth'],
  ['Am I worth more than I was six months ago?', 'net_worth'],
  ['What will my savings look like in three months?', 'forecast'],
  ['If I cancel Netflix, how much will I save by year end?', 'forecast'],
  ['Project my cash flow for the next six months', 'forecast'],
  ['What if I cut dining out by $100 a month?', 'forecast'],
  ['Will I have enough cash by September at my current pace?', 'forecast'],
  ['Recategorize that Starbucks charge as Dining', 'none'],
  ['Hi, what can you do?', 'none'],
  ['Explain what a Roth IRA is', 'none'],
  ['Delete the duplicate Adobe transaction', 'none'],
  ['Import my new bank statement', 'none'],
  ['Help me write an email to my accountant', 'none'],
  ['Flag this charge as tax deductible', 'none'],
  ['How much did I pay in total to Costco this year?', 'transaction_search'],
  ['Pull up my rent payments from the last three months', 'transaction_search'],
  ['What did I spend per category in the last 30 days?', 'spending_summary'],
  ['Which category grew the most compared to the previous period?', 'spending_summary'],
  ['Show income minus expenses for the previous quarter', 'profit_loss'],
  ['What was my profit last year?', 'profit_loss'],
  ['How have my assets and debts changed over the past year?', 'net_worth'],
  ['What do my total assets minus liabilities come to?', 'net_worth'],
  ['Estimate my savings at the end of the year if I keep spending like this', 'forecast'],
  ['Change my budget goal to $500 a month', 'none'],
];
writeFileSync('gold/route.json', JSON.stringify(Q.map(([q, e]) => ({ question: q, expected: e })), null, 1));
console.log('route', Q.length);
