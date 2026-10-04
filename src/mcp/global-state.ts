/**
 * Process-global agent-access state, kept OUTSIDE any profile.
 *
 * `getSetting`/`setSetting` (src/utils/config.ts) read the ACTIVE profile's
 * settings.json and throw "No active profile" before one is set. State that
 * must hold across profile switches, or be readable before any profile is
 * active, lives in `~/.openaccountant/agent-access.json` instead and is read
 * and written only through this module. It never calls `getSetting`.
 *
 *  - `dashboardHost`: bind address, read once at startup (a profile switch
 *    cannot change it).
 *  - `enabled`: the global kill switch. Absent means on. `false` exposes no
 *    tool to any agent or MCP client, in every profile.
 *  - `killSwitchEpoch`: ms timestamp of the last kill-switch flip. A grant
 *    created at or before it is dead in every profile, even after the switch
 *    is turned back on (src/mcp/store.ts `validateGrant`).
 *
 * Reads are cached and re-read when the file's mtime changes. A missing
 * file is the empty state, never an error: defaults apply. A file that exists but cannot be parsed fails closed (off).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OA_ROOT } from '../profile/context.js';

export interface GlobalAgentState {
  /** Bind address for the dashboard server. Absent means loopback. `WILSON_DASHBOARD_HOST` overrides it. */
  dashboardHost?: string;
  /** The kill switch. Only an explicit `false` turns agent access off. */
  enabled?: boolean;
  /** Epoch ms of the last kill-switch flip; grants created at or before it are invalid. */
  killSwitchEpoch?: number;
}

/** `~/.openaccountant/agent-access.json`: directly under OA_ROOT, never inside a profile. */
export const DEFAULT_AGENT_ACCESS_FILE = join(OA_ROOT, 'agent-access.json');

let filePath = DEFAULT_AGENT_ACCESS_FILE;
let cache: { mtimeMs: number; size: number; state: GlobalAgentState } | null = null;

/** Point the state at another file (tests), or back at the default with `null`. Drops the cache. */
export function setGlobalStateFile(path: string | null): void {
  filePath = path ?? DEFAULT_AGENT_ACCESS_FILE;
  cache = null;
}

function sanitize(raw: unknown): GlobalAgentState {
  const state: GlobalAgentState = {};
  if (raw && typeof raw === 'object') {
    const obj = raw as { dashboardHost?: unknown; enabled?: unknown; killSwitchEpoch?: unknown };
    if (typeof obj.dashboardHost === 'string' && obj.dashboardHost.trim()) state.dashboardHost = obj.dashboardHost.trim();
    if (typeof obj.enabled === 'boolean') state.enabled = obj.enabled;
    if (typeof obj.killSwitchEpoch === 'number' && Number.isFinite(obj.killSwitchEpoch) && obj.killSwitchEpoch >= 0) {
      state.killSwitchEpoch = obj.killSwitchEpoch;
    }
  }
  return state;
}

export function getGlobalAgentState(): GlobalAgentState {
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(filePath);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    cache = null;
    return {};
  }
  // mtime alone can repeat within one filesystem tick; the size check catches an in-place rewrite that changed length.
  if (cache && cache.mtimeMs === mtimeMs && cache.size === size) return { ...cache.state };
  let state: GlobalAgentState;
  try {
    state = sanitize(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    // The file exists but cannot be read or parsed (truncated by hand, damaged from outside). This is a SAFETY
    // control, so it fails closed: access stays off, and every grant older than the damage is dead, as after a
    // flip. Only a missing file means "never configured". The next write (the switch in Settings) replaces it.
    console.warn(`[agent-access] ${filePath} is unreadable; agent access is off until it is rewritten.`);
    state = { enabled: false, killSwitchEpoch: Math.max(cache?.state.killSwitchEpoch ?? 0, Math.ceil(mtimeMs)) };
  }
  cache = { mtimeMs, size, state };
  return { ...state };
}

/** Merge `patch` into the file. A key set to `undefined` is removed. Written atomically (temp file, then rename). */
export function setGlobalAgentState(patch: Partial<GlobalAgentState>): GlobalAgentState {
  const next: Record<string, unknown> = { ...getGlobalAgentState() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
  cache = null;
  return getGlobalAgentState();
}

export const KILL_SWITCH_MESSAGE = 'Agent access is turned off. Ask the user to turn it on in Settings → Agent access.';

/** False only after an explicit kill-switch flip. Works with no active profile. */
export function isAgentAccessEnabled(): boolean {
  return getGlobalAgentState().enabled !== false;
}

/** Epoch ms of the last kill-switch flip (0 when it was never flipped). */
export function getKillSwitchEpoch(): number {
  return getGlobalAgentState().killSwitchEpoch ?? 0;
}
