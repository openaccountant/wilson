/**
 * Periodic housekeeping for the WebMCP tables: expired grants (after a 7-day
 * grace), expired approval tokens, resolved operations older than 7 days, and
 * the audit log's tiered retention. The dashboard server runs this at startup
 * and every 6 hours.
 *
 * Each sweep is isolated: one failing (say, a table missing in an old
 * database) never stops the others.
 */
import type { Database } from '../db/compat-sqlite.js';
import { cleanExpiredGrants, cleanExpiredApprovalTokens, sweepOperations } from './store.js';
import { sweepAudit, DEFAULT_RETENTION_DAYS, type SweepResult } from './audit.js';
import { getSetting } from '../utils/config.js';

export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MaintenanceResult {
  grants: number;
  approvalTokens: number;
  operations: number;
  audit: SweepResult | null;
}

/** Per-profile `webmcpAuditRetentionDays`, defaulting to 90. The setting needs an active profile, so tolerate its absence. */
function auditRetentionDays(): number {
  try {
    const days = getSetting<number>('webmcpAuditRetentionDays', DEFAULT_RETENTION_DAYS);
    return Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

function attempt<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`[mcp-maintenance] ${label} failed:`, err);
    return fallback;
  }
}

/** Per-profile settings are only readable for the active profile; every other profile is swept with the longest allowed window. */
export interface MaintenanceOptions {
  retentionDays?: number;
}

export function runMcpMaintenance(db: Database, opts: MaintenanceOptions = {}): MaintenanceResult {
  return {
    grants: attempt('cleanExpiredGrants', () => cleanExpiredGrants(db), 0),
    approvalTokens: attempt('cleanExpiredApprovalTokens', () => cleanExpiredApprovalTokens(db), 0),
    operations: attempt('sweepOperations', () => sweepOperations(db), 0),
    audit: attempt('sweepAudit', () => sweepAudit(db, { retentionDays: opts.retentionDays ?? auditRetentionDays() }), null),
  };
}

/** Longest audit retention the setting allows: a profile whose own setting we cannot read is never swept earlier than it asked. */
const MAX_RETENTION_DAYS = 365;

/**
 * Sweep every open profile DB. The active profile uses its own
 * `webmcpAuditRetentionDays`; the others use the maximum window (their
 * setting is not readable until they become active), so retention is never
 * shorter than configured while row caps and expiry still apply everywhere.
 */
export function runMcpMaintenanceAll(dbs: Array<{ profile: string; db: Database }>, activeProfile: string): Map<string, MaintenanceResult> {
  const results = new Map<string, MaintenanceResult>();
  for (const { profile, db } of dbs) {
    const result = attempt(`maintenance(${profile})`, () => runMcpMaintenance(db, profile === activeProfile ? {} : { retentionDays: MAX_RETENTION_DAYS }), null);
    if (result) results.set(profile, result);
  }
  return results;
}
