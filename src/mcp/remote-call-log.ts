/**
 * A small local log of calls Wilson's MCP client makes to REMOTE servers
 * (http / SSE), so the user can see what left the machine and how much of it
 * the egress guard (./egress.ts) stripped.
 *
 * One JSON line per call in ~/.openaccountant/mcp-remote-calls.log (mode
 * 0600): time, server, tool, transport, outcome and redaction counts. Raw
 * arguments and results are NEVER written. When the file passes 1 MB it is
 * moved to `.1` (one generation kept). Writing is best effort: a failure here
 * never fails the tool call.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { EgressKind } from './egress.js';
import type { McpTransportKind } from './config.js';

export type RemoteCallOutcome = 'sent' | 'blocked' | 'error';

export interface RemoteCallRecord {
  server: string;
  tool: string;
  transport?: McpTransportKind;
  outcome: RemoteCallOutcome;
  redactions: number;
  kinds?: Partial<Record<EgressKind, number>>;
  durationMs?: number;
}

const DEFAULT_PATH = join(homedir(), '.openaccountant', 'mcp-remote-calls.log');
const MAX_BYTES = 1024 * 1024;

let logPath = DEFAULT_PATH;

/** Point the log somewhere else (tests). Pass nothing to restore the default. */
export function setRemoteCallLogPath(path?: string): void {
  logPath = path ?? DEFAULT_PATH;
}

export function getRemoteCallLogPath(): string {
  return logPath;
}

/** Append one record. Only the listed fields are written, whatever the caller passes. */
export function recordRemoteCall(record: RemoteCallRecord): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    server: record.server,
    tool: record.tool,
    transport: record.transport,
    outcome: record.outcome,
    redactions: record.redactions,
    kinds: record.kinds && Object.keys(record.kinds).length > 0 ? record.kinds : undefined,
    durationMs: record.durationMs,
  });
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      if (statSync(logPath).size > MAX_BYTES) renameSync(logPath, `${logPath}.1`);
    } catch {
      // No file yet.
    }
    appendFileSync(logPath, `${line}\n`, { mode: 0o600 });
  } catch {
    // Best effort: never fail a tool call over the log.
  }
}
