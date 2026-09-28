import { detectFormat, type BankType } from './detect-bank.js';
import { parseChaseCSV } from './parsers/chase.js';
import { parseAmexCSV } from './parsers/amex.js';
import { parseBofA } from './parsers/bofa.js';
import { parseGenericCSV } from './parsers/generic.js';
import { parseOfx } from './parsers/ofx.js';
import { parseQif } from './parsers/qif.js';
import type { ParsedTransaction } from './parsers/chase.js';

export type { ParsedTransaction, BankType };

/**
 * Browser-safe helpers shared by the dashboard's statement importer (the UI
 * bundles this module via the @import-tools alias) and covered by bun tests.
 *
 * Keep this module free of Node built-ins and DB imports: the UI's tsc program
 * and vite build compile it for the browser. Anything Node-flavoured
 * (createHash, bun:sqlite, ...) must stay out — the ui build breaks loudly if
 * it ever creeps in, which is the guardrail.
 */

/** Result of parsing statement text client-side — everything the preview shows. */
export interface ParsedStatement {
  format: 'csv' | 'ofx' | 'qif';
  bank: BankType;
  transactions: ParsedTransaction[];
  dateRange: { start: string; end: string };
  /** Net total of the statement (sum of signed amounts). */
  total: number;
}

/**
 * Parse raw statement text (CSV/OFX/QIF) in the browser.
 *
 * Byte-faithful to steps 3–4 of importSingleFile in csv-import.ts — same
 * detectFormat, same parser switch (minus the CLI's `bank` override flag) — so
 * the preview always agrees with the CLI on which parser runs. Throws when a
 * parser rejects the content; callers must also treat an empty transactions
 * array as a parse failure. Nothing here touches the network.
 */
export function parseStatementContent(content: string): ParsedStatement {
  const detected = detectFormat(content);
  const bank: BankType = detected.bank ?? 'generic';

  let transactions: ParsedTransaction[];
  switch (detected.format) {
    case 'ofx':
      transactions = parseOfx(content);
      break;
    case 'qif':
      transactions = parseQif(content);
      break;
    case 'csv':
      switch (bank) {
        case 'chase':
          transactions = parseChaseCSV(content);
          break;
        case 'amex':
          transactions = parseAmexCSV(content);
          break;
        case 'bofa':
        case 'bofa-cc':
          transactions = parseBofA(content);
          break;
        default:
          transactions = parseGenericCSV(content);
          break;
      }
      break;
    default:
      transactions = parseGenericCSV(content);
      break;
  }

  const dates = transactions.map((t) => t.date).sort();
  return {
    format: detected.format,
    bank,
    transactions,
    dateRange: { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '' },
    total: transactions.reduce((sum, t) => sum + t.amount, 0),
  };
}

/**
 * SHA-256 hex digest of a string via WebCrypto — byte-identical to the CLI
 * pipeline's `createHash('sha256').update(content).digest('hex')` over the same
 * string (csv-import.ts), so a file hashed in the browser dedups against one
 * imported via the CLI or the API. Always hash the exact decoded text that was
 * parsed and previewed.
 *
 * globalThis.crypto.subtle exists in browsers and in Bun (tests run it natively).
 * Note: Blob.text()/TextDecoder strip a leading UTF-8 BOM where Node's
 * readFileSync keeps it — such files only differ in file-hash dedup across
 * paths; row-level external_id dedup still prevents duplicate transactions.
 */
export async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Minimal auth-status shape the UI fetches from GET /api/auth/status. */
export interface CommitAuthStatus {
  authEnabled?: boolean;
  user?: { role?: string } | null;
}

/**
 * Whether the signed-in user may commit an import — mirrors the /api/import RBAC
 * (admin-only when auth is enabled, open otherwise; server.ts canWrite). A
 * not-yet-loaded auth status is treated as open (standalone-demo default); if
 * auth is actually on, the server still rejects the POST with 401/403 and the
 * dialog surfaces the error.
 */
export function canCommitImport(
  auth: CommitAuthStatus | null | undefined,
): boolean {
  if (!auth?.authEnabled) return true;
  return auth.user?.role === 'admin';
}