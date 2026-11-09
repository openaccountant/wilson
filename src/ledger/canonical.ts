import { sha256Hex } from './sha256.js';

export { sha256Hex };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Deterministic JSON: object keys sorted, no whitespace, undefined keys dropped.
 * Used for audit hashing and idempotency payload comparison.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}
