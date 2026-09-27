/**
 * Known merchants/categories reference set for the statement-to-dashboard agent
 * trace (Demo tab). Each entry is a merchant string exactly as it appears on
 * statements; the label doubles as the embed text, so row descriptions and
 * reference labels are embedded under the same rule (transactionEmbedText) and
 * their vectors are directly comparable.
 *
 * Categories are Wilson's taxonomy (src/tools/categorize/categories.ts) —
 * deliberately NOT the bank's own CSV Category column values, which the parsers
 * intentionally ignore. That mismatch is part of the demo narrative: Wilson
 * classifies with its own consistent taxonomy.
 *
 * `HARBORVIEW DENTAL GROUP` is intentional: an exact-string entry scores 1.0
 * while the shared-word `HARBORVIEW HOTEL` entry demonstrates partial-overlap
 * ranking below the exact match.
 */
export interface KnownMerchant {
  /** Merchant string as it appears on statements — also the embed text. */
  label: string;
  /** A member of CATEGORIES (src/tools/categorize/categories.ts). */
  category: string;
}

export const KNOWN_MERCHANTS: KnownMerchant[] = [
  { label: 'CORNER MARKET #1247', category: 'Groceries' },
  { label: 'OAK STREET COFFEE', category: 'Dining' },
  { label: 'SUNRISE DINER', category: 'Dining' },
  { label: 'BLUE WAVE SEAFOOD', category: 'Dining' },
  { label: 'THE GILDED FORK', category: 'Dining' },
  { label: 'SEASIDE BAR & GRILL', category: 'Dining' },
  { label: 'MEGAMART ONLINE', category: 'Shopping' },
  { label: 'MEGA ONLINE STORE', category: 'Shopping' },
  { label: 'AIRPORT NEWS & GIFTS', category: 'Shopping' },
  { label: 'HARBORVIEW HOTEL', category: 'Travel' },
  { label: 'HARBORVIEW DENTAL GROUP', category: 'Health' },
  { label: 'FUEL DEPOT', category: 'Transport' },
  { label: 'COASTAL CAB CO', category: 'Transport' },
  { label: 'CITY PARKING AUTHORITY', category: 'Transport' },
  { label: 'CITY ELECTRIC CO AUTOPAY', category: 'Utilities' },
  { label: 'CLOUDVAULT BACKUP', category: 'Utilities' },
  { label: 'MAPLE AVE APARTMENTS RENT', category: 'Home' },
  { label: 'SKYSTREAM PLUS MONTHLY', category: 'Entertainment' },
  { label: 'STREAMFLIX SUBSCRIPTION', category: 'Subscriptions' },
  { label: 'RIVERDALE GYM MONTHLY', category: 'Health' },
  { label: 'PHARMACY PLUS #210', category: 'Health' },
  { label: 'PAYROLL DEPOSIT - ACME CORP', category: 'Income' },
];