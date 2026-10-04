/**
 * HTTP routes for the human side of the judge: the queue of proposals and what a person does with each one.
 * Mounted from src/dashboard/server.ts.
 *
 *   GET  /api/judgements?status&cursor&limit   any signed-in user (a viewer may look)
 *   POST /api/judgements/:id/accept|reject     admin, browser proof
 *   POST /api/judgements/:id/revoke            admin, browser proof (accepted -> rejected)
 *   POST /api/judgements/bulk {ids, action}    admin, browser proof, at most 10 ids
 *
 * Accepting changes only the judgement's status and review fields (the database triggers allow nothing else);
 * it never touches a human label. Every action leaves a `transport=rest` audit row that says whether an agent had
 * live access at the time, computed here from server state (a request header could simply be left out).
 * A proposal younger than 1 s cannot be accepted: an agent that proposes and then clicks Accept through the page
 * has to wait it out (threat T34).
 */
import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import type { DashboardUser } from './auth.js';
import { apiJudgementView, apiJudgements } from './api.js';
import { requireBrowserProof } from './origin-gate.js';
import { appendRestWriteAudit } from '../mcp/audit.js';
import { dbTimeMs, isAgentPresent, principalHeldGrantSince, userHeldAgentSince } from '../mcp/store.js';
import { describeZodError } from '../mcp/schemas.js';
import { revokeJudgement, setJudgementStatus, type JudgementActionResult } from '../training/annotations.js';

/** Same rule as server.ts `canWrite`: only an admin changes anything. */
const canWrite = (role: string): boolean => role === 'admin';

export interface JudgementRouteContext {
  activeDb: Database;
  currentUser: DashboardUser | null;
  authEnabled: boolean;
  port: number;
  headers: Record<string, string>;
  profile: string;
}

/**
 * How far back "an agent was around" reaches for the review flag: a proposal this young, or a proposer that held a
 * grant created this recently, marks the accept `review_agent_present` even when no grant is live at click time.
 */
export const REVIEW_AGENT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * `review_agent_present` for one accept or reject. The click-time check (`isAgentPresent`) alone is a snapshot: an
 * agent can propose, let its grant lapse (or have it revoked or killed) and click Accept through the page afterwards.
 * So the flag is also set when the proposing principal held any grant created in the last 2 hours, or the proposal
 * itself is under 2 hours old. Residual: a proposal older than 2 hours from a principal whose grants are all older
 * (or purged) is treated as human-reviewed, and the page click itself is still indistinguishable from a person's.
 */
export function reviewAgentPresent(db: Database, id: number, clickTimeLive: boolean, now: number = Date.now()): boolean {
  if (clickTimeLive) return true;
  const row = db.prepare("SELECT principal_id, annotated_at FROM interaction_annotations WHERE id = @id AND source = 'judge'").get({ id }) as
    | { principal_id: string | null; annotated_at: string }
    | undefined;
  if (!row) return false;
  const since = now - REVIEW_AGENT_WINDOW_MS;
  const proposedAt = dbTimeMs(row.annotated_at);
  if (Number.isFinite(proposedAt) && proposedAt > since) return true;
  return row.principal_id ? principalHeldGrantSince(db, row.principal_id, since) : false;
}

/**
 * `agent_present` for a human annotation, which has no proposing principal to look up. Same window rule as
 * `reviewAgentPresent`: true when an agent is live right now (`isAgentPresent`), or this user held any grant (live,
 * expired or revoked) or raised a non-chat operation, or the kill switch was flipped, within the last
 * `REVIEW_AGENT_WINDOW_MS`. So a label written while an agent was around stays flagged after its grant lapses or is
 * killed, and re-sending every label field inside the window does not launder it into a clean human label.
 */
export function annotateAgentPresent(db: Database, userId: number | null, profile: string, now: number = Date.now()): boolean {
  return isAgentPresent(db, userId, profile) || userHeldAgentSince(db, userId, profile, now - REVIEW_AGENT_WINDOW_MS);
}

/** At most this many judgements in one bulk call (the UI also limits it to rows the person has expanded). */
export const BULK_MAX = 10;

const BulkBody = z
  .object({
    ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(BULK_MAX)
      .refine((ids) => new Set(ids).size === ids.length, 'ids must be distinct'),
    action: z.enum(['accept', 'reject']),
  })
  .strict();

function error(status: number, code: string, message: string, headers: Record<string, string>): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

const FAILURE: Record<Extract<JudgementActionResult, { ok: false }>['reason'], { status: number; code: string; message: string }> = {
  not_found: { status: 404, code: 'not_found', message: 'No such judgement.' },
  not_proposed: { status: 409, code: 'not_proposed', message: 'That judgement is no longer waiting for review.' },
  not_accepted: { status: 409, code: 'not_accepted', message: 'Only an accepted judgement can be revoked.' },
  too_fast: { status: 409, code: 'approval_too_fast', message: 'Wait a moment before accepting so you can read it.' },
};

export async function handleJudgementRoute(req: Request, url: URL, path: string, ctx: JudgementRouteContext): Promise<Response | null> {
  const { activeDb, headers } = ctx;

  if (path === '/api/judgements' && req.method === 'GET') {
    const out = apiJudgements(activeDb, url.searchParams);
    if ('error' in out) return error(400, 'invalid_args', String(out.error), headers);
    return Response.json(out, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  }

  const single = path.match(/^\/api\/judgements\/(\d+)\/(accept|reject|revoke)$/);
  const bulk = path === '/api/judgements/bulk';
  if (!((single || bulk) && req.method === 'POST')) return null;

  // Acting on a human's behalf: the dashboard page in a browser, and with auth on the write role.
  const proof = requireBrowserProof(req, ctx.port);
  if (proof) {
    for (const [k, v] of Object.entries(headers)) proof.headers.set(k, v);
    return proof;
  }
  if (ctx.authEnabled && (!ctx.currentUser || !canWrite(ctx.currentUser.role))) {
    return error(403, 'role_forbidden', 'Only an admin can review judgements.', headers);
  }
  const userId = ctx.authEnabled && ctx.currentUser ? ctx.currentUser.id : null;
  const role = ctx.authEnabled && ctx.currentUser ? ctx.currentUser.role : 'admin';
  const agentPresent = isAgentPresent(activeDb, userId, ctx.profile);
  const audit = (route: string, detail: string): void => {
    try {
      appendRestWriteAudit(activeDb, { route, userId, role, origin: req.headers.get('Origin') ?? 'direct', agentPresent, detail });
    } catch (err) {
      console.error('[mcp-audit] failed to audit a judgement action:', err);
    }
  };

  if (single) {
    const id = Number(single[1]);
    const action = single[2] as 'accept' | 'reject' | 'revoke';
    const result = action === 'revoke' ? revokeJudgement(activeDb, id, { reviewedBy: userId }) : setJudgementStatus(activeDb, id, action, { reviewedBy: userId, agentPresent: reviewAgentPresent(activeDb, id, agentPresent) });
    if (!result.ok) {
      const f = FAILURE[result.reason];
      return error(f.status, f.code, f.message, headers);
    }
    audit(`/api/judgements/:id/${action}`, `id=${id}`);
    return Response.json({ judgement: apiJudgementView(result.row) }, { headers });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return error(400, 'invalid_args', 'Request body must be valid JSON', headers);
  }
  const body = BulkBody.safeParse(raw);
  if (!body.success) return error(400, 'invalid_args', describeZodError(body.error), headers);

  const results: Array<{ id: number; ok: boolean; reason?: string }> = [];
  for (const id of body.data.ids) {
    const r = setJudgementStatus(activeDb, id, body.data.action, { reviewedBy: userId, agentPresent: reviewAgentPresent(activeDb, id, agentPresent) });
    results.push(r.ok ? { id, ok: true } : { id, ok: false, reason: r.reason === 'too_fast' ? 'too_fast' : r.reason });
  }
  const done = results.filter((r) => r.ok).map((r) => r.id);
  if (done.length > 0) audit('/api/judgements/bulk', `${body.data.action} ids=${done.join(',')}`);
  return Response.json({ results }, { headers });
}
