/**
 * Idempotent startup fix-up that carries persisted WebMCP tool names over the 0.10.0 rename without a
 * migration (specs/webmcp-tool-naming.md §4.3). v34 is reserved for open-jev, so a v35 would make v34 never run.
 *
 * Imports only `tool-names.ts`, so `src/db` takes no dependency on the catalog.
 *
 *  - Policies: merged most-restrictive-wins into the new name; the old-name row is KEPT as a mirror holding the
 *    same value, so a build that still uses old names, run from another worktree on the same HOME, never loses an Off.
 *  - Live grants (tab and client-token): renamed, or revoked when the same owner already holds a live grant
 *    for the new name. Never two live rows for one owner, and a pending op is never re-pointed at another grant.
 *  - Pending non-chat operations: renamed. Chat rows carry chat tool names that happen to equal retired names.
 *  - The audit log, terminal operations and llm_* tables are never touched.
 *
 * On failure the transaction rolls back and startup continues. That is safe: the policy read fallback keeps old
 * choices in force, old-name grants fail closed (scope_mismatch) and old-name pending ops go stale (policy_off).
 */
import type { Database } from '../db/compat-sqlite.js';
import { RETIRED_TOOL_NAMES, mostRestrictivePolicy } from './tool-names.js';

export interface ToolRenameCounts {
  policies: number;
  grants: number;
  revoked: number;
  operations: number;
}

export interface ToolRenameOptions {
  profile?: string;
  /** Test seam: called before each step; throw to inject a failure. */
  onStep?: (step: string) => void;
  /** Suppress the one-line log (tests). */
  quiet?: boolean;
}

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = @name").get({ name });
}

const NOW = () => new Date().toISOString();

export function applyToolRenames(db: Database, opts: ToolRenameOptions = {}): ToolRenameCounts {
  const counts: ToolRenameCounts = { policies: 0, grants: 0, revoked: 0, operations: 0 };
  const step = (s: string) => opts.onStep?.(s);
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    // Another process holds the write lock: skip this run, the next start retries. Stays closed meanwhile.
    console.error('[mcp] tool name fix-up skipped:', err instanceof Error ? err.message : err);
    return counts;
  }
  try {
    const pairs = Object.entries(RETIRED_TOOL_NAMES).map(([old, r]) => [old, r.name] as const);

    if (hasTable(db, 'mcp_tool_policies')) {
      step('policies');
      for (const [oldName, newName] of pairs) {
        const rows = db
          .prepare('SELECT user_key, policy, updated_at FROM mcp_tool_policies WHERE tool_name = @t')
          .all({ t: oldName }) as Array<{ user_key: number; policy: string; updated_at: string | null }>;
        for (const r of rows) {
          const cur = db
            .prepare('SELECT policy FROM mcp_tool_policies WHERE user_key = @k AND tool_name = @t')
            .get({ k: r.user_key, t: newName }) as { policy: string } | undefined;
          if (!cur) {
            db.prepare("INSERT INTO mcp_tool_policies (user_key, tool_name, policy, updated_at) VALUES (@k, @t, @p, COALESCE(@u, datetime('now')))")
              .run({ k: r.user_key, t: newName, p: r.policy, u: r.updated_at });
            counts.policies++;
            continue;
          }
          const merged = mostRestrictivePolicy(cur.policy, r.policy);
          if (merged !== cur.policy) {
            db.prepare("UPDATE mcp_tool_policies SET policy = @p, updated_at = datetime('now') WHERE user_key = @k AND tool_name = @t")
              .run({ p: merged, k: r.user_key, t: newName });
            counts.policies++;
          }
          if (merged !== r.policy) {
            db.prepare('UPDATE mcp_tool_policies SET policy = @p WHERE user_key = @k AND tool_name = @t')
              .run({ p: merged, k: r.user_key, t: oldName });
            counts.policies++;
          }
        }
      }
    }

    if (hasTable(db, 'mcp_grants')) {
      step('grants');
      const now = NOW();
      for (const [oldName, newName] of pairs) {
        const live = db
          .prepare(
            `SELECT id, session_generation, user_id, profile, origin FROM mcp_grants
             WHERE tool_name = @t AND revoked_at IS NULL AND julianday(expires_at) > julianday(@now)`,
          )
          .all({ t: oldName, now }) as Array<{ id: string; session_generation: string; user_id: number | null; profile: string; origin: string }>;
        for (const g of live) {
          const dup = db
            .prepare(
              `SELECT 1 AS x FROM mcp_grants
               WHERE tool_name = @t AND revoked_at IS NULL AND julianday(expires_at) > julianday(@now)
                 AND session_generation = @sg AND user_id IS @uid AND profile = @profile AND origin = @origin`,
            )
            .get({ t: newName, now, sg: g.session_generation, uid: g.user_id, profile: g.profile, origin: g.origin });
          if (dup) {
            db.prepare("UPDATE mcp_grants SET revoked_at = datetime('now') WHERE id = @id").run({ id: g.id });
            counts.revoked++;
          } else {
            db.prepare('UPDATE mcp_grants SET tool_name = @t WHERE id = @id').run({ t: newName, id: g.id });
            counts.grants++;
          }
        }
      }
    }

    if (hasTable(db, 'mcp_operations')) {
      step('operations');
      for (const [oldName, newName] of pairs) {
        const r = db
          .prepare("UPDATE mcp_operations SET tool_name = @n WHERE tool_name = @o AND status = 'pending' AND source IN ('webmcp', 'http-mcp')")
          .run({ n: newName, o: oldName });
        counts.operations += Number(r.changes ?? 0);
      }
    }

    step('commit');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    console.error('[mcp] tool name fix-up failed (policies stay enforced through the read fallback):', err instanceof Error ? err.message : err);
    return { policies: 0, grants: 0, revoked: 0, operations: 0 };
  }
  if (!opts.quiet && (counts.policies || counts.grants || counts.revoked || counts.operations)) {
    console.log(
      `[mcp] tool names updated (profile=${opts.profile ?? 'default'}): policies=${counts.policies} grants=${counts.grants} revoked=${counts.revoked} operations=${counts.operations}`,
    );
  }
  return counts;
}
