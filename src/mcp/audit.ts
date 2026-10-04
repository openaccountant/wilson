/**
 * Audit log for agent tool calls (threat model T14, T32). Every call through
 * `engine.callTool` writes here in a `finally`, reads included, so a user can
 * find out what an agent looked at, not only what it changed. REST export
 * downloads are audited too (`transport = 'rest'`). Other REST reads and the
 * browser mirror's sync pulls are NOT audited.
 *
 * Two kinds of rows:
 *  - signal rows: one per event (allowed, operation_created, approved, ...);
 *  - noise rows: denied/invalid/rate-limited calls, aggregated into one row per
 *    principal, tool, decision and minute with a `count`. A script that
 *    hammers the endpoint with cheap failures therefore cannot push the rows
 *    that recorded an earlier read out of the table.
 *
 * Principals are hashed (`tab:<sha256(sessionGeneration)[:16]>`); a raw
 * sessionGeneration is never stored. `args_preview` is canonical JSON,
 * sanitized and PII-masked, at most 512 characters. The log is never exported.
 */
import { createHash } from 'node:crypto';
import type { Database } from '../db/compat-sqlite.js';
import { currentNameFor, retiredNamesFor } from './tool-names.js';
import { canonicalArgs, maskPii, sanitizeUntrustedText } from './output.js';

export type SignalDecision =
  | 'allowed' | 'operation_created' | 'approved' | 'rejected' | 'committed' | 'stale' | 'expired'
  | 'cancelled' | 'error' | 'rest_export' | 'rest_write';
export type NoiseDecision =
  | 'denied_policy' | 'denied_kill_switch' | 'denied_grant' | 'denied_role' | 'invalid_args' | 'rate_limited';
export type SentinelDecision = 'audit_compacted' | 'audit_evicted' | 'deep_paging';
export type AuditDecision = SignalDecision | NoiseDecision | SentinelDecision;
export type AuditTier = 'signal' | 'noise' | 'summary' | 'sentinel';
export type PrincipalKind = 'tab' | 'client_token' | 'chat' | 'user';

const NOISE: ReadonlySet<string> = new Set<NoiseDecision>([
  'denied_policy', 'denied_kill_switch', 'denied_grant', 'denied_role', 'invalid_args', 'rate_limited',
]);
const SENTINEL: ReadonlySet<string> = new Set<SentinelDecision>(['audit_compacted', 'audit_evicted', 'deep_paging']);

export function tierOf(decision: AuditDecision): AuditTier {
  if (NOISE.has(decision)) return 'noise';
  if (SENTINEL.has(decision)) return 'sentinel';
  return 'signal';
}

export interface AuditInput {
  transport: string;
  principalKind: PrincipalKind;
  principalId: string;
  userId: number | null;
  role: string;
  origin: string;
  toolName: string;
  classification: string;
  decision: AuditDecision;
  operationId?: string | null;
  grantId?: string | null;
  argsPreview?: string | null;
  resultChars?: number | null;
  pageIndex?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  /** Initial `count` (sentinels carry how many rows they stand for). */
  count?: number;
  /** ISO timestamp override (tests, compaction). Defaults to now. */
  ts?: string;
}

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

/** The dashboard chat's one principal. Only server code that really is the chat module may ask for it. */
export const CHAT_PRINCIPAL: Principal = { kind: 'chat', id: 'chat' };

/** Every request that names no authenticated principal shares this one, so cheap unauthenticated noise cannot mint rows. */
export const ANONYMOUS_PRINCIPAL: Principal = { kind: 'user', id: 'anonymous' };

/** The principal for work done as a dashboard user, before any client-chosen session is trusted. */
export function userPrincipal(userId: number | null): Principal {
  return { kind: 'user', id: `user:${userId ?? 'anon'}` };
}

/**
 * Who made a call, without ever storing a credential. A client-supplied
 * session string is ALWAYS hashed and never parsed for a prefix: nothing a
 * client sends can make its rows look like the chat or a client token. The
 * caller states the kind explicitly (`chat` has its own constant above; P0b
 * token resolution passes `client_token` with the token's DB id, not a secret).
 */
export function principalFor(sessionGeneration: string, kind: Exclude<PrincipalKind, 'chat' | 'user'> = 'tab'): Principal {
  return { kind, id: createHash('sha256').update(sessionGeneration).digest('hex').slice(0, 16) };
}

const PREVIEW_MAX_DEPTH = 8;
/** The preview is 512 characters, so a wider container cannot show more; this keeps a million-element array cheap. */
const PREVIEW_MAX_ENTRIES = 32;

/** Sanitize every string (keys included) so masking never runs on JSON-escaped text, where `\t` or `\n` would split a digit run. */
function sanitizeLeaves(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeUntrustedText(value, 512);
  if (depth >= PREVIEW_MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, PREVIEW_MAX_ENTRIES).map((v) => sanitizeLeaves(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, PREVIEW_MAX_ENTRIES)) out[sanitizeUntrustedText(k, 64)] = sanitizeLeaves(v, depth + 1);
    return out;
  }
  return value;
}

/** Canonical JSON of the arguments, sanitized and PII-masked, at most 512 characters. */
export function previewArgs(args: unknown): string {
  if (args === undefined) return '';
  let json: string;
  try {
    json = canonicalArgs(sanitizeLeaves(args));
  } catch {
    json = '[unserializable]';
  }
  // Strings are already clean; this second pass only catches numeric leaves (a card number sent as a number).
  const masked = maskPii(json);
  return masked.length <= 512 ? masked : `${masked.slice(0, 511).trimEnd()}…`;
}

export function appendAudit(db: Database, row: AuditInput): void {
  const ts = row.ts ?? new Date().toISOString();
  const tier = tierOf(row.decision);
  const params = {
    ts,
    tier,
    transport: row.transport,
    principalKind: row.principalKind,
    principalId: row.principalId,
    userId: row.userId,
    role: row.role,
    origin: row.origin,
    toolName: row.toolName,
    classification: row.classification,
    decision: row.decision,
    operationId: row.operationId ?? null,
    grantId: row.grantId ?? null,
    argsPreview: row.argsPreview === undefined || row.argsPreview === null ? null : row.argsPreview.slice(0, 512),
    resultChars: row.resultChars ?? null,
    pageIndex: row.pageIndex ?? null,
    durationMs: row.durationMs ?? null,
    errorCode: row.errorCode ?? null,
    count: row.count ?? 1,
    bucket: tier === 'noise' ? ts.slice(0, 16) : null,
  };
  const insert = `
    INSERT INTO mcp_audit_log (
      ts, tier, transport, principal_kind, principal_id, user_id, role, origin, tool_name, classification,
      decision, operation_id, grant_id, args_preview, result_chars, page_index, duration_ms, error_code, count, bucket
    ) VALUES (
      @ts, @tier, @transport, @principalKind, @principalId, @userId, @role, @origin, @toolName, @classification,
      @decision, @operationId, @grantId, @argsPreview, @resultChars, @pageIndex, @durationMs, @errorCode, @count, @bucket
    )`;
  if (tier === 'noise') {
    db.prepare(`${insert}
      ON CONFLICT(principal_id, tool_name, decision, bucket) WHERE tier = 'noise'
      DO UPDATE SET count = count + excluded.count, ts = excluded.ts`).run(params);
    return;
  }
  db.prepare(insert).run(params);
}

/** The only REST routes the export audit covers. Anything else under /api/export/ is not an export and writes nothing. */
export const EXPORT_AUDIT_ROUTES: ReadonlySet<string> = new Set([
  '/api/export/csv',
  '/api/export/xlsx',
  '/api/export/pnl',
  '/api/export/net-worth',
  '/api/export/training/sft',
  '/api/export/training/dpo',
  '/api/export/training/stats',
]);

/**
 * REST export downloads: transport 'rest', tool_name is the route label (one of
 * `EXPORT_AUDIT_ROUTES`, never raw request text). Repeats by the same principal
 * on the same route within one minute fold into one row's `count`, so a script
 * cannot flood the table and push real rows out. Returns false for a route that
 * is not a known export (nothing written).
 */
export function appendRestExportAudit(
  db: Database,
  info: { route: string; userId: number | null; role: string; origin: string; detail?: string }
): boolean {
  if (!EXPORT_AUDIT_ROUTES.has(info.route)) return false;
  // `detail` says what the export may contain (built by the caller from fixed words, never request text). It is part
  // of the fold key, so a default export and one with opt-ins never share a row.
  const detail = info.detail === undefined ? null : info.detail.slice(0, 120);
  const principalId = `user:${info.userId ?? 'anon'}`;
  const ts = new Date().toISOString();
  const folded = db.prepare(`
    UPDATE mcp_audit_log SET count = count + 1, ts = @ts
    WHERE id = (
      SELECT id FROM mcp_audit_log
      WHERE decision = 'rest_export' AND principal_id = @principalId AND tool_name = @route AND args_preview IS @detail AND substr(ts, 1, 16) = @minute
      ORDER BY id DESC LIMIT 1
    )`).run({ ts, principalId, route: info.route, detail, minute: ts.slice(0, 16) }) as { changes: number };
  if (folded.changes > 0) return true;
  appendAudit(db, {
    transport: 'rest',
    principalKind: 'user',
    principalId,
    userId: info.userId,
    role: info.role,
    origin: info.origin.slice(0, 200),
    toolName: info.route,
    classification: 'read',
    decision: 'rest_export',
    argsPreview: detail,
    ts,
  });
  return true;
}

/** The human REST writes an agent could drive through the page. `tool_name` is one of these labels, never raw request text. */
export const REST_WRITE_ROUTES: ReadonlySet<string> = new Set([
  '/api/budgets/:category',
  '/api/goals/:id',
  '/api/reviews/:id/confirm',
  '/api/reviews/:id/correct',
  // P4a: a human label and the judgement queue are what a page-driving agent could click through (T34).
  '/api/interactions/:id/annotate',
  '/api/judgements/:id/accept',
  '/api/judgements/:id/reject',
  '/api/judgements/:id/revoke',
  '/api/judgements/bulk',
]);

/**
 * A human REST write (budget, goal, review confirm/correct): transport 'rest', with `agent_present` computed on
 * the server in `args_preview`. Repeats by the same principal on the same route with the same flag inside one
 * minute fold into one row's `count`, so a script clicking through the page cannot flood the table.
 */
export function appendRestWriteAudit(
  db: Database,
  info: { route: string; userId: number | null; role: string; origin: string; agentPresent: boolean; detail?: string }
): boolean {
  if (!REST_WRITE_ROUTES.has(info.route)) return false;
  const principalId = `user:${info.userId ?? 'anon'}`;
  // `detail` names what was acted on (a judgement id): short, and built by the caller from numbers, never request text.
  const preview = `agent_present=${info.agentPresent}${info.detail ? ` ${info.detail.slice(0, 120)}` : ''}`;
  const ts = new Date().toISOString();
  const folded = db.prepare(`
    UPDATE mcp_audit_log SET count = count + 1, ts = @ts
    WHERE id = (
      SELECT id FROM mcp_audit_log
      WHERE decision = 'rest_write' AND principal_id = @principalId AND tool_name = @route AND args_preview = @preview AND substr(ts, 1, 16) = @minute
      ORDER BY id DESC LIMIT 1
    )`).run({ ts, principalId, route: info.route, preview, minute: ts.slice(0, 16) }) as { changes: number };
  if (folded.changes > 0) return true;
  appendAudit(db, {
    transport: 'rest',
    principalKind: 'user',
    principalId,
    userId: info.userId,
    role: info.role,
    origin: info.origin.slice(0, 200),
    toolName: info.route,
    classification: 'mutating',
    decision: 'rest_write',
    argsPreview: preview,
    ts,
  });
  return true;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  ts: string;
  tier: AuditTier;
  transport: string;
  principal_kind: string;
  principal_id: string;
  user_id: number | null;
  role: string;
  origin: string;
  tool_name: string;
  classification: string;
  decision: string;
  operation_id: string | null;
  args_preview: string | null;
  result_chars: number | null;
  page_index: number | null;
  duration_ms: number | null;
  error_code: string | null;
  count: number;
  bucket: string | null;
  /** Set when the stored `tool_name` is a retired catalog name: its current name. Never set for REST route rows or chat-expiry rows. */
  toolCurrent?: string;
}

export interface ListAuditOptions {
  /** Only rows made by this user (a viewer sees their own). `undefined` = no restriction (admin, or auth off). */
  restrictToUserId?: number | null;
  /** Return rows with `id` below this cursor. */
  cursor?: number;
  limit?: number;
  tool?: string;
  decision?: string;
  transport?: string;
  /** ISO timestamp lower bound. */
  since?: string;
}

/**
 * A row that provably belongs to the WebMCP catalog (not a REST route label and not a chat card): a tool-call
 * transport, or a REST lifecycle row whose operation came from a tab or /mcp. The expiry sweep also writes
 * `transport='rest'` rows for expired CHAT cards named tax_flag / edit_transaction, which must never be mapped.
 * A REST row whose operation was purged is ambiguous, so it is not mapped.
 */
const CATALOG_ROW_SQL = `(transport IN ('imperative','declarative','page','http-mcp') OR (transport = 'rest' AND operation_id IN (SELECT id FROM mcp_operations WHERE source IN ('webmcp','http-mcp'))))`;

const AUDIT_COLUMNS =
  'id, ts, tier, transport, principal_kind, principal_id, user_id, role, origin, tool_name, classification, decision, operation_id, args_preview, result_chars, page_index, duration_ms, error_code, count, bucket';

/** Newest first. `grant_id` is deliberately not returned. */
export function listAudit(db: Database, opts: ListAuditOptions = {}): { entries: AuditEntry[]; nextCursor?: number } {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.restrictToUserId !== undefined) {
    where.push('user_id IS @restrictUser');
    params.restrictUser = opts.restrictToUserId;
  }
  if (opts.cursor !== undefined) {
    where.push('id < @cursor');
    params.cursor = opts.cursor;
  }
  if (opts.tool) {
    // A current name also matches its retired names, but only on rows that are provably catalog rows.
    const retired = retiredNamesFor(opts.tool);
    if (retired.length > 0) {
      where.push(`(tool_name = @tool OR (tool_name IN (${retired.map((_, i) => `@retired${i}`).join(', ')}) AND ${CATALOG_ROW_SQL}))`);
      retired.forEach((n, i) => { params[`retired${i}`] = n; });
    } else {
      where.push('tool_name = @tool');
    }
    params.tool = opts.tool;
  }
  if (opts.decision) {
    where.push('decision = @decision');
    params.decision = opts.decision;
  }
  if (opts.transport) {
    where.push('transport = @transport');
    params.transport = opts.transport;
  }
  if (opts.since) {
    where.push('ts >= @since');
    params.since = opts.since;
  }
  const rows = db.prepare(`
    SELECT ${AUDIT_COLUMNS}, ${CATALOG_ROW_SQL} AS catalog_row FROM mcp_audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT @fetch
  `).all({ ...params, fetch: limit + 1 }) as Array<AuditEntry & { catalog_row?: number }>;
  const entries: AuditEntry[] = rows.slice(0, limit).map(({ catalog_row, ...entry }) => {
    const current = catalog_row ? currentNameFor(entry.tool_name) : undefined;
    return current ? { ...entry, toolCurrent: current } : entry;
  });
  return {
    entries,
    ...(rows.length > limit ? { nextCursor: entries[entries.length - 1].id } : {}),
  };
}

// ── Retention ────────────────────────────────────────────────────────────────

export const AUDIT_SOFT_CAP = 100_000;
export const AUDIT_HARD_CEILING = 250_000;
export const DEFAULT_RETENTION_DAYS = 90;

export interface SweepOptions {
  /** Per-profile setting `webmcpAuditRetentionDays`; clamped to 7-365. */
  retentionDays?: number;
  maxRows?: number;
  hardCeiling?: number;
  /** Epoch ms override for tests. */
  now?: number;
}

export interface SweepResult {
  expired: number;
  noiseEvicted: number;
  compacted: number;
  evicted: number;
}

function totalRows(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM mcp_audit_log').get() as { n: number }).n;
}

function writeSentinel(db: Database, decision: SentinelDecision, count: number, detail: string, ts: string): void {
  appendAudit(db, {
    transport: 'rest',
    principalKind: 'user',
    principalId: 'system',
    userId: null,
    role: 'admin',
    origin: 'server',
    toolName: 'audit',
    classification: 'read',
    decision,
    argsPreview: detail,
    count,
    ts,
  });
}

/**
 * Tiered retention:
 *  1. rows older than the retention window go, all tiers;
 *  2. over the soft cap, noise rows are deleted oldest first;
 *  3. if signal rows alone still exceed the cap, signal rows older than 24 h
 *     are compacted into hourly summaries (rows from the last 24 h are never
 *     touched);
 *  4. only if the table still exceeds the hard ceiling are the oldest rows
 *     deleted.
 * Every compaction or eviction leaves a sentinel row with the counts.
 */
export function sweepAudit(db: Database, opts: SweepOptions = {}): SweepResult {
  const now = opts.now ?? Date.now();
  const retentionDays = Math.max(7, Math.min(365, Math.floor(opts.retentionDays ?? DEFAULT_RETENTION_DAYS)));
  const maxRows = opts.maxRows ?? AUDIT_SOFT_CAP;
  const hardCeiling = opts.hardCeiling ?? AUDIT_HARD_CEILING;
  const nowIso = new Date(now).toISOString();
  const result: SweepResult = { expired: 0, noiseEvicted: 0, compacted: 0, evicted: 0 };

  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  result.expired = (db.prepare('DELETE FROM mcp_audit_log WHERE ts < @cutoff').run({ cutoff }) as { changes: number }).changes;

  let total = totalRows(db);
  if (total > maxRows) {
    const excess = total - maxRows;
    result.noiseEvicted = (db.prepare(`
      DELETE FROM mcp_audit_log WHERE id IN (
        SELECT id FROM mcp_audit_log WHERE tier = 'noise' ORDER BY id ASC LIMIT @excess
      )`).run({ excess }) as { changes: number }).changes;
    total = totalRows(db);
    if (result.noiseEvicted > 0) {
      writeSentinel(db, 'audit_evicted', result.noiseEvicted, `deleted ${result.noiseEvicted} oldest noise rows to stay under ${maxRows}`, nowIso);
      total = totalRows(db);
    }
  }

  if (total > maxRows) {
    const dayAgo = new Date(now - 86_400_000).toISOString();
    const groups = db.prepare(`
      SELECT principal_kind, principal_id, user_id, role, origin, transport, tool_name, classification, decision,
             substr(ts, 1, 13) AS hour, SUM(count) AS n, SUM(COALESCE(result_chars, 0)) AS chars, MIN(ts) AS first_ts
      FROM mcp_audit_log
      WHERE tier = 'signal' AND ts < @dayAgo
      GROUP BY principal_kind, principal_id, user_id, role, origin, transport, tool_name, classification, decision, substr(ts, 1, 13)
    `).all({ dayAgo }) as Array<{
      principal_kind: string; principal_id: string; user_id: number | null; role: string; origin: string;
      transport: string; tool_name: string; classification: string; decision: string; hour: string;
      n: number; chars: number; first_ts: string;
    }>;
    if (groups.length > 0) {
      const compact = db.transaction(() => {
        const removed = (db.prepare("DELETE FROM mcp_audit_log WHERE tier = 'signal' AND ts < @dayAgo").run({ dayAgo }) as { changes: number }).changes;
        const insert = db.prepare(`
          INSERT INTO mcp_audit_log (
            ts, tier, transport, principal_kind, principal_id, user_id, role, origin, tool_name, classification,
            decision, result_chars, count, bucket
          ) VALUES (
            @ts, 'summary', @transport, @principalKind, @principalId, @userId, @role, @origin, @toolName, @classification,
            @decision, @chars, @n, @hour
          )`);
        for (const g of groups) {
          insert.run({
            ts: g.first_ts, transport: g.transport, principalKind: g.principal_kind, principalId: g.principal_id,
            userId: g.user_id, role: g.role, origin: g.origin, toolName: g.tool_name, classification: g.classification,
            decision: g.decision, chars: g.chars, n: g.n, hour: g.hour,
          });
        }
        return removed;
      });
      result.compacted = compact();
      writeSentinel(db, 'audit_compacted', result.compacted, `compacted ${result.compacted} signal rows older than 24h into ${groups.length} hourly summaries`, nowIso);
    }
    total = totalRows(db);
  }

  if (total > hardCeiling) {
    const excess = total - hardCeiling;
    result.evicted = (db.prepare(`
      DELETE FROM mcp_audit_log WHERE id IN (
        SELECT id FROM mcp_audit_log WHERE tier != 'sentinel' ORDER BY id ASC LIMIT @excess
      )`).run({ excess }) as { changes: number }).changes;
    writeSentinel(db, 'audit_evicted', result.evicted, `deleted the ${result.evicted} oldest rows to stay under ${hardCeiling}`, nowIso);
  }

  return result;
}
