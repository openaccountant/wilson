/**
 * The ONE list of category labels that never earn a palette hue. Shared by
 * the session palette (charts/palette.ts — these never take a slot) and the
 * spending drill (lib/drill.ts — these draw neutral grey), so a label is grey
 * everywhere and never consumes one of the 7 slots.
 *
 * Zero imports: bun tests and both UI bundles load it.
 */

/** Labels with no spending identity: blank/Uncategorized and catch-alls. */
export const UNCLASSIFIED_LABELS: readonly string[] = Object.freeze([
  'Uncategorized',
  'Unclassified',
  'Uncategorised',
  'Other',
]);

/** Payment-method pseudo-categories some banks export as the category. */
export const PAYMENT_METHOD_LABELS: readonly string[] = Object.freeze([
  'Debit',
  'Credit',
  'Check',
  'Venmo',
  'PayPal',
  'Deposit',
]);

const NEUTRAL_SET = new Set([...UNCLASSIFIED_LABELS, ...PAYMENT_METHOD_LABELS].map((l) => l.toLowerCase()));

/** True for NULL / blank and every label in the shared neutral list (case-insensitive, trimmed). */
export function isNeutralLabel(label: string | null | undefined): boolean {
  const l = (label ?? '').trim().toLowerCase();
  return l === '' || NEUTRAL_SET.has(l);
}
