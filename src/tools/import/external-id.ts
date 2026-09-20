import { createHash } from 'crypto';

/**
 * Compute a per-row external_id for transactions that don't have one.
 * Shared by the CLI file-import pipeline and the dashboard /api/import endpoint
 * so the same statement dedups across both paths. Do not change the derivation
 * in one place without the other.
 */
export function computeExternalId(t: { date: string; description: string; amount: number }): string {
  return `csv-${createHash('sha256').update(`${t.date}|${t.description}|${t.amount}`).digest('hex').slice(0, 16)}`;
}