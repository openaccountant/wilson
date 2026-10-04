/**
 * Parse a bank-export amount string into a number.
 *
 * Strips `$`, thousands separators and whitespace, and treats an amount in
 * parentheses as negative: "-1,234.56" -> -1234.56, "$2,000.00" -> 2000,
 * "(45.00)" -> -45. Returns NaN when the string holds no number.
 */
export function parseAmount(raw: string): number {
  let s = raw.replace(/[$,\s]/g, '');
  let negate = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    s = paren[1];
    negate = true;
  }
  const n = parseFloat(s);
  return negate ? -n : n;
}
