import type { ParsedTransaction } from './chase.js';

/**
 * Parse an OFX date string to YYYY-MM-DD.
 *
 * OFX dates come in several forms:
 *   YYYYMMDDHHMMSS.XXX[-5:EST]
 *   YYYYMMDDHHMMSS
 *   YYYYMMDD
 * We take the first 8 characters and split into YYYY-MM-DD.
 */
export function parseOfxDate(dateStr: string): string {
  const trimmed = dateStr.trim();
  const base = trimmed.slice(0, 8);
  const year = base.slice(0, 4);
  const month = base.slice(4, 6);
  const day = base.slice(6, 8);
  return `${year}-${month}-${day}`;
}

/**
 * Detect whether a string is OFX content.
 * Returns true if it starts with OFXHEADER: or contains <?OFX or <OFX>.
 */
export function isOfxContent(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith('OFXHEADER:') ||
    trimmed.includes('<?OFX') ||
    trimmed.includes('<OFX>')
  );
}

/**
 * Extract the value of a leaf OFX element from a transaction block.
 *
 * OFX 1.x (SGML) uses `<FIELDNAME>value` with no closing tag.
 * OFX 2.x (XML) uses `<FIELDNAME>value</FIELDNAME>`.
 * This regex handles both: capture everything after `<TAG>` up to the next
 * `<` (start of next tag) or end of string.
 */
function extractField(block: string, fieldName: string): string | undefined {
  const re = new RegExp(`<${fieldName}>([^<\\r\\n]+)`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

/**
 * Try to extract the financial institution name from the OFX header/signon
 * section. Looks for <ORG>value inside a <FI>...</FI> block.
 */
function extractOrg(content: string): string | undefined {
  const fiMatch = content.match(/<FI>([\s\S]*?)<\/FI>/i);
  if (!fiMatch) return undefined;
  return extractField(fiMatch[1], 'ORG');
}

/**
 * Parse OFX 1.x (SGML) or 2.x (XML) content into ParsedTransactions.
 *
 * Extracts all <STMTTRN>...</STMTTRN> blocks and maps each to a
 * ParsedTransaction using the standard field set.
 */
export function parseOfx(content: string): ParsedTransaction[] {
  const _org = extractOrg(content);

  // Extract all STMTTRN blocks
  const blockRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const transactions: ParsedTransaction[] = [];

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(content)) !== null) {
    const block = match[1];

    const trnType = extractField(block, 'TRNTYPE');
    const dtPosted = extractField(block, 'DTPOSTED');
    const trnAmt = extractField(block, 'TRNAMT');
    const fitId = extractField(block, 'FITID');
    const name = extractField(block, 'NAME');
    const memo = extractField(block, 'MEMO');
    const checkNum = extractField(block, 'CHECKNUM');
    const dtUser = extractField(block, 'DTUSER');

    // DTPOSTED and TRNAMT are required to form a valid transaction
    if (!dtPosted || !trnAmt) continue;

    const amount = parseFloat(trnAmt);
    if (isNaN(amount)) continue;

    const date = parseOfxDate(dtPosted);

    // Description: prefer NAME, fall back to MEMO, then 'Unknown'
    const description = name ?? memo ?? 'Unknown';

    // merchant_name: if both NAME and MEMO exist, NAME is the merchant
    const merchant_name = name && memo ? name : undefined;

    const txn: ParsedTransaction = {
      date,
      description,
      amount,
      bank: 'ofx',
      external_id: fitId,
      transaction_type: trnType,
    };

    if (merchant_name) txn.merchant_name = merchant_name;
    if (checkNum) txn.check_number = checkNum;
    if (dtUser) txn.authorized_date = parseOfxDate(dtUser);

    transactions.push(txn);
  }

  return transactions;
}
