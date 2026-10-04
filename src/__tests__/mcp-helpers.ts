import type { Database } from '../db/compat-sqlite.js';
import { grantLocalAccess, type RequestScope } from '../mcp/engine.js';
import { createUser } from '../dashboard/auth.js';
import { mintClientToken } from '../mcp/client-tokens.js';

/** A fresh browser-tab scope. Each call gets its own random session generation (UUID v4). */
export function testScope(overrides: Partial<RequestScope> = {}): RequestScope {
  return {
    role: 'admin',
    userId: null,
    profile: 'test',
    origin: 'http://localhost:3141',
    sessionGeneration: crypto.randomUUID(),
    ...overrides,
  };
}

/** Grant tools to a scope and return `{ toolName: grantId }`. Throws if the grant is refused. */
export function grantTools(db: Database, scope: RequestScope, tools: string[]): Record<string, string> {
  const result = grantLocalAccess(db, scope, tools);
  if (!result.ok) throw new Error(`grant refused: ${result.error}`);
  return Object.fromEntries(result.grants.map((g) => [g.tool_name, g.id]));
}

export function firstTxnId(db: Database): number {
  return (db.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: number }).id;
}

export function count(db: Database, table: string, where = '1=1'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

/** Create a dashboard user directly (bypasses the HTTP login flow). */
export async function makeUser(db: Database, username: string, role: 'admin' | 'viewer') {
  return createUser(db, username, 'password123', role);
}

/**
 * Headers a browser page on the dashboard's own origin sends: an allowlisted
 * Origin and `Sec-Fetch-Site: same-origin`. P0b refuses grant, approve and
 * client-token routes without them (`requireBrowserProof`).
 */
export function browserHeaders(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Origin: new URL(base).origin, 'Sec-Fetch-Site': 'same-origin', ...extra };
}

/** `fetch` as the dashboard page would call it: browser headers added unless the caller set them. */
export function bfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const defaults = browserHeaders(new URL(url).origin);
  for (const [k, v] of Object.entries(defaults)) if (!headers.has(k)) headers.set(k, v);
  return fetch(url, { ...init, headers });
}

/** Mint a `/mcp` client token directly (the route path is covered in mcp-client-tokens.test.ts). Throws if refused. */
export function mintTestToken(
  db: Database,
  tools: string[],
  opts: { userId?: number | null; role?: 'admin' | 'viewer'; authEnabled?: boolean; name?: string; expiresInDays?: number; profile?: string } = {}
): { token: string; id: string } {
  const result = mintClientToken(
    db,
    { userId: opts.userId ?? null, role: opts.role ?? 'admin', profile: opts.profile ?? 'test', authEnabled: opts.authEnabled ?? false },
    { name: opts.name ?? 'test client', tools, expiresInDays: opts.expiresInDays }
  );
  if (!result.ok) throw new Error(`mint refused: ${result.error}`);
  return { token: result.token, id: result.meta.id };
}
