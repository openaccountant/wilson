import { createSign, randomBytes } from 'crypto';
import { logger } from '../utils/logger.js';
import type { CoinbaseConnection } from './store.js';

// ── Constants ────────────────────────────────────────────────────────────────

const COINBASE_API = 'https://api.coinbase.com/v2';

const OA_API_URL =
  process.env.OA_API_URL ?? 'https://openaccountant-api.workers.dev';

// ── Errors ───────────────────────────────────────────────────────────────────

export class CoinbaseError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CoinbaseError';
  }
}

// ── Retry ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof CoinbaseError ? err.statusCode : 0;
      if (status < 500 || attempt === maxRetries) throw err;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  throw new Error('unreachable');
}

// ── Credential Detection ─────────────────────────────────────────────────────

export function hasLocalCoinbaseCreds(): boolean {
  return !!(process.env.COINBASE_KEY_NAME && process.env.COINBASE_PRIVATE_KEY);
}

// ── JWT Generation (ES256) ──────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert a DER-encoded ECDSA signature to IEEE P1363 fixed-size format (r || s).
 */
function derToP1363(der: Buffer, componentLen: number): Buffer {
  // DER: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 2; // skip SEQUENCE tag + length
  if (der[1] & 0x80) offset += (der[1] & 0x7f); // handle multi-byte length

  // Read r
  offset++; // skip 0x02
  const rLen = der[offset++];
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;

  // Read s
  offset++; // skip 0x02
  const sLen = der[offset++];
  const s = der.subarray(offset, offset + sLen);

  // Pad or trim to componentLen bytes
  const result = Buffer.alloc(componentLen * 2);
  const rPad = componentLen - r.length;
  if (rPad >= 0) {
    r.copy(result, rPad);
  } else {
    // r has a leading zero byte for sign, skip it
    r.copy(result, 0, -rPad);
  }
  const sPad = componentLen - s.length;
  if (sPad >= 0) {
    s.copy(result, componentLen + sPad);
  } else {
    s.copy(result, componentLen, -sPad);
  }

  return result;
}

/**
 * Generate a short-lived ES256 JWT for Coinbase CDP API authentication.
 * Each request gets a fresh JWT (valid for 120 seconds).
 */
export function generateJWT(
  keyName: string,
  privateKey: string,
  method: string,
  host: string,
  path: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const uri = `${method} ${host}${path}`;

  const header = {
    alg: 'ES256',
    kid: keyName,
    nonce,
    typ: 'JWT',
  };

  const payload = {
    sub: keyName,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: now,
    exp: now + 120,
    uris: [uri],
  };

  const segments = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(payload))),
  ];
  const signingInput = segments.join('.');

  // Normalize PEM: ensure proper line breaks
  const normalizedKey = privateKey.includes('\\n')
    ? privateKey.replace(/\\n/g, '\n')
    : privateKey;

  const sign = createSign('SHA256');
  sign.update(signingInput);
  const derSig = sign.sign(normalizedKey);

  // Convert DER-encoded ECDSA signature to fixed-size IEEE P1363 format (r || s, 32 bytes each)
  const p1363Sig = derToP1363(derSig, 32);

  return `${signingInput}.${base64url(p1363Sig)}`;
}

// ── Proxy Fetch ──────────────────────────────────────────────────────────────

async function proxyFetch(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { getLicenseInfo } = await import('../licensing/license.js');
  const license = getLicenseInfo();
  if (!license?.key) {
    throw new Error('No license key found. Run /license to activate.');
  }

  const res = await fetch(`${OA_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${license.key}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new CoinbaseError(
      (data.error as string) ?? `Proxy request failed (${res.status})`,
      res.status,
    );
  }
  return data;
}

// ── Direct Coinbase API ──────────────────────────────────────────────────────

async function coinbaseGet(
  url: string,
  keyName: string,
  privateKey: string,
): Promise<unknown> {
  const parsed = new URL(url);
  const jwt = generateJWT(keyName, privateKey, 'GET', parsed.host, parsed.pathname);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'CB-VERSION': '2024-01-01',
    },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const errors = data.errors as Array<{ message: string }> | undefined;
    throw new CoinbaseError(
      errors?.[0]?.message ?? `Coinbase API error (${res.status})`,
      res.status,
    );
  }
  return data;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CoinbaseAccountData {
  id: string;
  name: string;
  type: string;
  currency: { code: string };
  balance: { amount: string; currency: string };
  native_balance: { amount: string; currency: string };
}

/**
 * List all Coinbase accounts.
 */
export async function getAccounts(
  conn: CoinbaseConnection,
  useProxy = false,
): Promise<CoinbaseAccountData[]> {
  if (useProxy) {
    const data = (await withRetry(() =>
      proxyFetch('/coinbase/accounts', {
        key_name: conn.keyName,
      }),
    )) as { data: CoinbaseAccountData[] };
    logger.info('coinbase:accounts', { count: data.data.length });
    return data.data;
  }

  const data = (await withRetry(() =>
    coinbaseGet(`${COINBASE_API}/accounts`, conn.keyName, conn.privateKey),
  )) as { data: CoinbaseAccountData[] };
  logger.info('coinbase:accounts', { count: data.data.length });
  return data.data;
}

export interface CoinbaseTransaction {
  id: string;
  type: string;
  status: string;
  amount: { amount: string; currency: string };
  native_amount: { amount: string; currency: string };
  description: string | null;
  created_at: string;
  updated_at: string;
  network?: { status: string };
  details?: { title: string; subtitle?: string };
}

/**
 * Get transaction history for a specific account.
 */
export async function getTransactions(
  conn: CoinbaseConnection,
  accountId: string,
  useProxy = false,
): Promise<CoinbaseTransaction[]> {
  if (useProxy) {
    const data = (await withRetry(() =>
      proxyFetch(`/coinbase/accounts/${accountId}/transactions`, {
        key_name: conn.keyName,
      }),
    )) as { data: CoinbaseTransaction[] };
    logger.info('coinbase:transactions', { accountId, count: data.data.length });
    return data.data;
  }

  const data = (await withRetry(() =>
    coinbaseGet(
      `${COINBASE_API}/accounts/${accountId}/transactions`,
      conn.keyName,
      conn.privateKey,
    ),
  )) as { data: CoinbaseTransaction[] };
  logger.info('coinbase:transactions', { accountId, count: data.data.length });
  return data.data;
}

/**
 * Validate a Coinbase CDP API key by fetching accounts.
 * Returns the accounts on success, throws on failure.
 */
export async function validateCoinbaseKey(
  keyName: string,
  privateKey: string,
): Promise<CoinbaseAccountData[]> {
  const tempConn: CoinbaseConnection = {
    keyName,
    privateKey,
    accounts: [],
    linkedAt: '',
    lastSyncedAt: null,
  };
  return getAccounts(tempConn, false);
}
