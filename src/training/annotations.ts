/**
 * Versioned annotations for LLM interactions: human labels, judge proposals, and what may be exported.
 *
 * Rows are never edited (the v33 triggers only let `status`, `reviewed_by` and `reviewed_at` change, along
 * allow-listed transitions):
 *  - a human re-rating INSERTS a new `human` / `accepted` version and supersedes the old one;
 *  - a judge agent only ever INSERTS `judge` / `proposed` rows; a human accepts, rejects, or later revokes them;
 *  - accepting a judge row changes only its status and review fields: it never copies into or alters a human row.
 *
 * Export policy (binding, spec section U): the default export is HUMAN labels only. Accepted judge rows, human
 * ratings made while an agent had live access, and prompts that contain the browser subagent's handoff block
 * each need their own explicit per-export opt-in. Proposed, rejected (including revoked) and superseded rows are
 * never exported. A current human row always shadows judge rows for its interaction, even when the default
 * export leaves that human row out (agent-present): what a person has said wins over what an agent proposed.
 *
 * Server-only. Nothing here imports from src/mcp except the pure audit-preview helper.
 */
import { retiredNamesFor } from '../mcp/tool-names.js';
import type { Database } from '../db/compat-sqlite.js';
import { previewArgs } from '../mcp/audit.js';
import { HANDOFF_BLOCK_HEADER_PREFIX } from './handoff-block.js';

export type AnnotationSource = 'human' | 'judge';
export type AnnotationStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';
export type AnnotationCreatedVia = 'dashboard' | 'dashboard_agent_present' | 'webmcp' | 'declarative' | 'http-mcp';
export type Preference = 'chosen' | 'rejected' | 'neutral';

export interface AnnotationRow {
  id: number;
  interaction_id: number;
  rating: number | null;
  preference: Preference | null;
  pair_id: string | null;
  tags: string | null;
  notes: string | null;
  annotated_at: string;
  source: AnnotationSource;
  status: AnnotationStatus;
  version: number;
  supersedes_id: number | null;
  judge_model: string | null;
  rationale: string | null;
  criteria_json: string | null;
  rubric_version: string | null;
  created_via: AnnotationCreatedVia;
  principal_id: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  /** 1 when a person reviewed this judge row while an agent had live access, 0 when not, null before review. */
  review_agent_present: number | null;
}

/** An instant in ms from either of the formats the database holds (`datetime('now')` or ISO). */
function dbTime(value: string | null | undefined): number {
  if (!value) return NaN;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`).getTime();
}

const lastId = (res: unknown): number => Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);

// ── Human labels ─────────────────────────────────────────────────────────────

export function currentHuman(db: Database, interactionId: number): AnnotationRow | null {
  return (
    (db
      .prepare("SELECT * FROM interaction_annotations WHERE interaction_id = @interactionId AND source = 'human' AND status = 'accepted'")
      .get({ interactionId }) as AnnotationRow | undefined) ?? null
  );
}

/** Fields a human may set. `undefined` keeps the current value, `null` clears it. */
export interface HumanPatch {
  rating?: number | null;
  preference?: Preference | null;
  pairId?: string | null;
  tags?: string[] | null;
  notes?: string | null;
}

/**
 * Write a new human version in one transaction: the current row becomes `superseded`, and a new `accepted`
 * row carries the previous fields merged with the patch. The caller has already checked that the interaction exists.
 * `createdVia` is a floor, not a promise: an inherited agent-present label keeps `dashboard_agent_present`.
 */
export function writeHumanVersion(
  db: Database,
  interactionId: number,
  patch: HumanPatch,
  opts: { createdVia: 'dashboard' | 'dashboard_agent_present' }
): AnnotationRow {
  const write = db.transaction((): number => {
    const prev = currentHuman(db, interactionId);
    // Provenance follows the label. A label an agent had a hand in (`dashboard_agent_present`) stays flagged until a
    // person supplies every label field this version carries: a later edit of tags or notes, or a Save that does not
    // re-send the rating, must not turn an agent-written rating into a clean human one.
    const inheritsAgentLabel =
      prev?.created_via === 'dashboard_agent_present' &&
      ((patch.rating === undefined && prev.rating !== null) ||
        (patch.preference === undefined && prev.preference !== null) ||
        (patch.pairId === undefined && prev.pair_id !== null));
    const createdVia = inheritsAgentLabel ? 'dashboard_agent_present' : opts.createdVia;
    if (prev) db.prepare("UPDATE interaction_annotations SET status = 'superseded' WHERE id = @id").run({ id: prev.id });
    const pick = <K extends keyof HumanPatch>(key: K, fallback: unknown): unknown => (patch[key] === undefined ? fallback : patch[key]);
    const tags = patch.tags === undefined ? (prev?.tags ?? null) : patch.tags === null ? null : JSON.stringify(patch.tags);
    const res = db.prepare(`
      INSERT INTO interaction_annotations
        (interaction_id, rating, preference, pair_id, tags, notes, source, status, version, supersedes_id, created_via)
      VALUES (@interactionId, @rating, @preference, @pairId, @tags, @notes, 'human', 'accepted', @version, @supersedesId, @createdVia)
    `).run({
      interactionId,
      rating: pick('rating', prev?.rating ?? null),
      preference: pick('preference', prev?.preference ?? null),
      pairId: pick('pairId', prev?.pair_id ?? null),
      tags,
      notes: pick('notes', prev?.notes ?? null),
      version: (prev?.version ?? 0) + 1,
      supersedesId: prev?.id ?? null,
      createdVia,
    });
    return lastId(res);
  });
  const id = write();
  return db.prepare('SELECT * FROM interaction_annotations WHERE id = @id').get({ id }) as AnnotationRow;
}

/** Every version a human wrote for one interaction plus every judge row, newest first. */
export function annotationHistory(db: Database, interactionId: number): AnnotationRow[] {
  return db
    .prepare('SELECT * FROM interaction_annotations WHERE interaction_id = @interactionId ORDER BY id DESC')
    .all({ interactionId }) as AnnotationRow[];
}

// ── Judge proposals ──────────────────────────────────────────────────────────

export interface ProposalItem {
  interactionId: number;
  rating: number;
  preference?: Preference;
  rationale: string;
  criteria?: Record<string, number>;
  tags?: string[];
}

export interface InsertProposalsInput {
  /** The audit principal of the proposing agent (tab hash or token id). Part of the dedupe key. */
  principalId: string;
  createdVia: 'webmcp' | 'declarative' | 'http-mcp';
  judgeModel: string;
  rubricVersion: string;
  items: ProposalItem[];
  /** Cap on judge rows inserted per UTC day for this profile. Omitted means no cap (tests). */
  dailyLimit?: number;
  now?: Date;
}

export type ProposalSkipReason = 'not_found' | 'duplicate';

export type InsertProposalsResult =
  | { ok: true; created: number; ids: number[]; skipped: Array<{ interactionId: number; reason: ProposalSkipReason }> }
  | { ok: false; reason: 'daily_limit'; limit: number; used: number };

const startOfUtcDay = (now: Date): string => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Judge rows already inserted today (UTC), every status: superseding does not refund the quota. */
export function judgeRowsToday(db: Database, now: Date = new Date()): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM interaction_annotations WHERE source = 'judge' AND annotated_at >= @since")
    .get({ since: startOfUtcDay(now) }) as { n: number };
  return row.n;
}

/**
 * Insert judge proposals. Only `source='judge'`, `status='proposed'` rows can come out of here: there is no
 * parameter for either. The dedupe key is principal + judge model + rubric version + interaction: an open proposal
 * with the same key is superseded by the new one, and nobody else's proposal is ever touched. A repeated
 * interaction inside one batch keeps its first item and skips the rest. All or nothing: a batch that would pass the
 * daily limit inserts nothing.
 */
export function insertProposals(db: Database, input: InsertProposalsInput): InsertProposalsResult {
  const now = input.now ?? new Date();
  const run = db.transaction((): InsertProposalsResult => {
    if (input.dailyLimit !== undefined) {
      const used = judgeRowsToday(db, now);
      if (used + input.items.length > input.dailyLimit) return { ok: false, reason: 'daily_limit', limit: input.dailyLimit, used };
    }
    const ids: number[] = [];
    const skipped: Array<{ interactionId: number; reason: ProposalSkipReason }> = [];
    const seen = new Set<number>();
    for (const item of input.items) {
      if (seen.has(item.interactionId)) {
        skipped.push({ interactionId: item.interactionId, reason: 'duplicate' });
        continue;
      }
      seen.add(item.interactionId);
      const exists = db.prepare('SELECT 1 AS ok FROM llm_interactions WHERE id = @id').get({ id: item.interactionId });
      if (!exists) {
        skipped.push({ interactionId: item.interactionId, reason: 'not_found' });
        continue;
      }
      const open = db.prepare(`
        SELECT id, version FROM interaction_annotations
        WHERE source = 'judge' AND status = 'proposed' AND interaction_id = @interactionId
          AND principal_id = @principalId AND judge_model = @judgeModel AND rubric_version = @rubricVersion
      `).get({
        interactionId: item.interactionId,
        principalId: input.principalId,
        judgeModel: input.judgeModel,
        rubricVersion: input.rubricVersion,
      }) as { id: number; version: number } | undefined;
      if (open) db.prepare("UPDATE interaction_annotations SET status = 'superseded' WHERE id = @id").run({ id: open.id });
      const res = db.prepare(`
        INSERT INTO interaction_annotations
          (interaction_id, rating, preference, tags, annotated_at, source, status, version, supersedes_id,
           judge_model, rationale, criteria_json, rubric_version, created_via, principal_id)
        VALUES
          (@interactionId, @rating, @preference, @tags, @annotatedAt, 'judge', 'proposed', @version, @supersedesId,
           @judgeModel, @rationale, @criteriaJson, @rubricVersion, @createdVia, @principalId)
      `).run({
        interactionId: item.interactionId,
        rating: item.rating,
        preference: item.preference ?? null,
        tags: item.tags && item.tags.length > 0 ? JSON.stringify(item.tags) : null,
        annotatedAt: now.toISOString(),
        version: (open?.version ?? 0) + 1,
        supersedesId: open?.id ?? null,
        judgeModel: input.judgeModel,
        rationale: item.rationale,
        criteriaJson: item.criteria ? JSON.stringify(item.criteria) : null,
        rubricVersion: input.rubricVersion,
        createdVia: input.createdVia,
        principalId: input.principalId,
      });
      ids.push(lastId(res));
    }
    return { ok: true, created: ids.length, ids, skipped };
  });
  return run();
}

/** A proposal younger than this cannot be accepted: a page-driving agent cannot propose and accept in one breath. */
export const DEFAULT_JUDGEMENT_DWELL_MS = 1000;
let judgementDwellMs = DEFAULT_JUDGEMENT_DWELL_MS;

/** Override the floor (tests relax it to 0), or restore the default with `null`. */
export function setJudgementDwellMs(ms: number | null): void {
  judgementDwellMs = ms === null ? DEFAULT_JUDGEMENT_DWELL_MS : Math.max(0, ms);
}

export type JudgementActionResult =
  | { ok: true; row: AnnotationRow }
  | { ok: false; reason: 'not_found' | 'not_proposed' | 'not_accepted' | 'too_fast' };

function getRow(db: Database, id: number): AnnotationRow | null {
  return (db.prepare('SELECT * FROM interaction_annotations WHERE id = @id').get({ id }) as AnnotationRow | undefined) ?? null;
}

/** A review timestamp that differs from `previous`, so revoking within the millisecond of accepting still passes the trigger. */
function reviewStamp(now: Date, previous: string | null): string {
  let ms = now.getTime();
  if (previous !== null && new Date(previous).getTime() >= ms) ms = new Date(previous).getTime() + 1;
  return new Date(ms).toISOString();
}

/** Accept or reject a PROPOSED judge row. Changes status and the review fields only (`agentPresent` is recorded for the export policy). */
export function setJudgementStatus(
  db: Database,
  id: number,
  action: 'accept' | 'reject',
  opts: { reviewedBy: number | null; now?: Date; minAgeMs?: number; agentPresent?: boolean }
): JudgementActionResult {
  const row = getRow(db, id);
  if (!row || row.source !== 'judge') return { ok: false, reason: 'not_found' };
  if (row.status !== 'proposed') return { ok: false, reason: 'not_proposed' };
  const now = opts.now ?? new Date();
  const minAge = opts.minAgeMs ?? judgementDwellMs;
  if (minAge > 0 && action === 'accept' && now.getTime() - dbTime(row.annotated_at) < minAge) return { ok: false, reason: 'too_fast' };
  db.prepare(`
    UPDATE interaction_annotations
    SET status = @status, reviewed_by = @reviewedBy, reviewed_at = @reviewedAt, review_agent_present = @agentPresent
    WHERE id = @id AND status = 'proposed'
  `).run({
    id,
    status: action === 'accept' ? 'accepted' : 'rejected',
    reviewedBy: opts.reviewedBy,
    reviewedAt: reviewStamp(now, row.reviewed_at),
    agentPresent: opts.agentPresent ? 1 : 0,
  });
  return { ok: true, row: getRow(db, id)! };
}

/** Revoke an ACCEPTED judge row (human route only): it becomes `rejected` with a new review stamp. */
export function revokeJudgement(db: Database, id: number, opts: { reviewedBy: number | null; now?: Date }): JudgementActionResult {
  const row = getRow(db, id);
  if (!row || row.source !== 'judge') return { ok: false, reason: 'not_found' };
  if (row.status !== 'accepted') return { ok: false, reason: 'not_accepted' };
  const now = opts.now ?? new Date();
  db.prepare("UPDATE interaction_annotations SET status = 'rejected', reviewed_by = @reviewedBy, reviewed_at = @reviewedAt WHERE id = @id AND status = 'accepted'")
    .run({ id, reviewedBy: opts.reviewedBy, reviewedAt: reviewStamp(now, row.reviewed_at) });
  return { ok: true, row: getRow(db, id)! };
}

export interface JudgementListRow extends AnnotationRow {
  /** The current human rating for the same interaction, for the queue's gap marker. The queue is the human's screen. */
  human_rating: number | null;
}

export function listJudgements(
  db: Database,
  opts: { status: 'proposed' | 'accepted' | 'rejected'; offset?: number; limit?: number }
): { rows: JudgementListRow[]; total: number } {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const total = (db.prepare("SELECT COUNT(*) AS n FROM interaction_annotations WHERE source = 'judge' AND status = @status").get({ status: opts.status }) as { n: number }).n;
  const rows = db.prepare(`
    SELECT a.*, h.rating AS human_rating
    FROM interaction_annotations a
    LEFT JOIN v_current_human_annotations h ON h.interaction_id = a.interaction_id
    WHERE a.source = 'judge' AND a.status = @status
    ORDER BY a.id DESC LIMIT @limit OFFSET @offset
  `).all({ status: opts.status, limit, offset }) as JudgementListRow[];
  return { rows, total };
}

// ── What may be exported ─────────────────────────────────────────────────────

export interface QualifyOptions {
  /** Add accepted judge rows (interactions with no current human row). Default false. */
  includeJudge?: boolean;
  /** Add human rows written while an agent had live access (`dashboard_agent_present`). Default false. */
  includeAgentPresent?: boolean;
  /** Add runs and pairs whose prompts contain the browser subagent's handoff block. Default false. */
  includeHandoff?: boolean;
}

export interface QualifyingAnnotation {
  annotation_id: number;
  interaction_id: number;
  rating: number | null;
  preference: Preference | null;
  pair_id: string | null;
  source: AnnotationSource;
}

/**
 * The one label per interaction an export may use. The current human row wins; it is left out (and still shadows
 * judge rows) when it was made while an agent was present and `includeAgentPresent` is off. With `includeJudge`, an
 * interaction with no human row takes its newest ACCEPTED judge row, unless that accept was made while an agent had
 * live access and `includeAgentPresent` is off. Proposed, rejected and superseded rows never qualify.
 */
export function qualifyingAnnotations(db: Database, opts: QualifyOptions = {}): QualifyingAnnotation[] {
  const rows = db
    .prepare(`
      SELECT id, interaction_id, rating, preference, pair_id, source, created_via, review_agent_present FROM interaction_annotations
      WHERE status = 'accepted' ORDER BY id ASC
    `)
    .all() as Array<Pick<AnnotationRow, 'id' | 'interaction_id' | 'rating' | 'preference' | 'pair_id' | 'source' | 'created_via' | 'review_agent_present'>>;
  const human = new Map<number, (typeof rows)[number]>();
  const judge = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    // A judge accept clicked while an agent had live access is the agent-present case again (a page-driving agent can
    // propose and click Accept): it needs the same explicit opt-in as an agent-present human rating.
    if (r.source === 'judge' && r.review_agent_present === 1 && !opts.includeAgentPresent) continue;
    (r.source === 'human' ? human : judge).set(r.interaction_id, r); // ascending id: the newest wins
  }
  const out: QualifyingAnnotation[] = [];
  const pick = (r: (typeof rows)[number]): QualifyingAnnotation => ({
    annotation_id: r.id,
    interaction_id: r.interaction_id,
    rating: r.rating,
    preference: r.preference,
    pair_id: r.pair_id,
    source: r.source,
  });
  for (const [interactionId, r] of human) {
    if (r.created_via === 'dashboard_agent_present' && !opts.includeAgentPresent) continue;
    out.push(pick(r));
    judge.delete(interactionId);
  }
  if (opts.includeJudge) {
    for (const [interactionId, r] of judge) if (!human.has(interactionId)) out.push(pick(r));
  }
  return out.sort((a, b) => a.interaction_id - b.interaction_id);
}

export interface SftSelection {
  minRating?: number;
  callTypes?: string[];
  model?: string;
}

function handoffRunIds(db: Database): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT run_id FROM llm_interactions WHERE instr(user_prompt, @prefix) > 0')
    .all({ prefix: HANDOFF_BLOCK_HEADER_PREFIX }) as Array<{ run_id: string }>;
  return new Set(rows.map((r) => r.run_id));
}

/**
 * The runs an SFT export emits, one line each: runs with at least one qualifying interaction rated >= `minRating`
 * (call type and model filters apply to that interaction). Runs whose prompts carry a handoff block are left out
 * unless `includeHandoff`; `handoffExcluded` says how many runs that removed. Shared by the export and the readiness
 * count, so "SFT ready" is exactly the number of lines exported.
 */
export function qualifyingSftRuns(db: Database, opts: QualifyOptions & SftSelection = {}): { runIds: string[]; handoffExcluded: number } {
  const { minRating = 4, callTypes = ['agent'], model } = opts;
  const ratedOk = new Set(
    qualifyingAnnotations(db, opts).filter((a) => a.rating !== null && a.rating >= minRating).map((a) => a.interaction_id)
  );
  let sql = 'SELECT id, run_id FROM llm_interactions WHERE 1 = 1';
  const params: Record<string, unknown> = {};
  if (callTypes.length > 0) {
    sql += ` AND call_type IN (${callTypes.map((_, i) => `@ct${i}`).join(',')})`;
    callTypes.forEach((ct, i) => { params[`ct${i}`] = ct; });
  }
  if (model) {
    sql += ' AND model = @model';
    params.model = model;
  }
  sql += ' ORDER BY id ASC';
  const runs: string[] = [];
  const seen = new Set<string>();
  for (const row of db.prepare(sql).all(params) as Array<{ id: number; run_id: string }>) {
    if (ratedOk.has(row.id) && !seen.has(row.run_id)) {
      seen.add(row.run_id);
      runs.push(row.run_id);
    }
  }
  // A run a judge row alone brought in (no person's label qualified it) must not contain an interaction a person
  // rated below `minRating`: the human row always wins, and the export would turn that response into a positive example.
  let selected = runs;
  if (opts.includeJudge && runs.length > 0) {
    const byHumans = new Set(
      qualifyingAnnotations(db, { ...opts, includeJudge: false }).filter((a) => a.rating !== null && a.rating >= minRating).map((a) => a.interaction_id)
    );
    const humanQualified = new Set<string>();
    for (const row of db.prepare('SELECT id, run_id FROM llm_interactions').all() as Array<{ id: number; run_id: string }>) {
      if (byHumans.has(row.id)) humanQualified.add(row.run_id);
    }
    const negative = new Set(
      (db.prepare(`
        SELECT DISTINCT i.run_id FROM llm_interactions i
        JOIN v_current_human_annotations h ON h.interaction_id = i.id
        WHERE h.rating IS NOT NULL AND h.rating < @minRating
      `).all({ minRating }) as Array<{ run_id: string }>).map((r) => r.run_id)
    );
    selected = runs.filter((r) => humanQualified.has(r) || !negative.has(r));
  }
  if (opts.includeHandoff || selected.length === 0) return { runIds: selected, handoffExcluded: 0 };
  const flagged = handoffRunIds(db);
  const kept = selected.filter((r) => !flagged.has(r));
  return { runIds: kept, handoffExcluded: selected.length - kept.length };
}

export interface DpoPair {
  pairId: string;
  chosenInteractionId: number;
  rejectedInteractionId: number;
}

/**
 * The complete DPO pairs an export emits: a pair id with a qualifying chosen side AND a qualifying rejected side.
 * One line per pair id (the lowest interaction id on each side), as before. Pairs with a handoff block on either
 * side are left out unless `includeHandoff`.
 */
export function qualifyingDpoPairs(db: Database, opts: QualifyOptions = {}): { pairs: DpoPair[]; handoffExcluded: number } {
  const byPair = new Map<string, { chosen?: number; rejected?: number }>();
  for (const a of qualifyingAnnotations(db, opts)) {
    if (a.pair_id === null || (a.preference !== 'chosen' && a.preference !== 'rejected')) continue;
    const entry = byPair.get(a.pair_id) ?? {};
    if (entry[a.preference] === undefined) entry[a.preference] = a.interaction_id;
    byPair.set(a.pair_id, entry);
  }
  let pairs: DpoPair[] = [];
  for (const [pairId, sides] of byPair) {
    if (sides.chosen !== undefined && sides.rejected !== undefined) {
      pairs.push({ pairId, chosenInteractionId: sides.chosen, rejectedInteractionId: sides.rejected });
    }
  }
  if (opts.includeHandoff || pairs.length === 0) return { pairs, handoffExcluded: 0 };
  const flagged = new Set(
    (db.prepare('SELECT id FROM llm_interactions WHERE instr(user_prompt, @prefix) > 0').all({ prefix: HANDOFF_BLOCK_HEADER_PREFIX }) as Array<{ id: number }>).map((r) => r.id)
  );
  const before = pairs.length;
  pairs = pairs.filter((p) => !flagged.has(p.chosenInteractionId) && !flagged.has(p.rejectedInteractionId));
  return { pairs, handoffExcluded: before - pairs.length };
}

// ── Agreement (blind proposals only) ─────────────────────────────────────────

export interface AgreementResult {
  /** Proposals the metric was measured on. */
  n: number;
  /** Share (0-100, whole percent) within one star of the human rating, or null when n is 0. */
  within1Pct: number | null;
}

/**
 * How often blind judge proposals land within one star of the human's rating. A proposal counts only when:
 *  (a) it came through `webmcp` or `http-mcp` (the declarative form sits beside the human controls);
 *  (b) neither its principal NOR any other principal of the same user had an `open_interaction` audit row for that
 *      interaction before the proposal (an agent that opened the detail panel may have read the human's rating off
 *      the screen; a tab principal is a hash of a client-chosen session id, so a rotated session must not count as
 *      a fresh, blind reader). A proposer whose user cannot be told from the audit log is compared with every opener;
 *  (c) the interaction has a current human rating that was not made while an agent was present.
 * Superseded proposals do not count, and a user counts at most once per interaction (the newest proposal across all of that user's principals; a principal with no resolvable user counts on its own).
 * `n` is always shown beside the percentage.
 */
export function agreement(db: Database): AgreementResult {
  let proposals = db.prepare(`
    SELECT a.id, a.interaction_id, a.rating, a.principal_id, a.annotated_at, h.rating AS human_rating
    FROM interaction_annotations a
    JOIN v_current_human_annotations h ON h.interaction_id = a.interaction_id
    WHERE a.source = 'judge' AND a.status IN ('proposed','accepted','rejected')
      AND a.created_via IN ('webmcp','http-mcp')
      AND a.rating IS NOT NULL AND h.rating IS NOT NULL AND h.created_via != 'dashboard_agent_present'
  `).all() as Array<{ id: number; interaction_id: number; rating: number; principal_id: string | null; annotated_at: string; human_rating: number }>;
  if (proposals.length === 0) return { n: 0, within1Pct: null };

  const userKeyOf = (userId: number | null): string => `u:${userId ?? 'anon'}`;
  // The user of each proposing principal, from any audit row it left (its proposal calls at least).
  const userOfPrincipal = new Map<string, string>();
  const principalIds = [...new Set(proposals.map((p) => p.principal_id).filter((id): id is string => typeof id === 'string'))];
  const userStmt = db.prepare('SELECT user_id FROM mcp_audit_log WHERE principal_id = @principal ORDER BY id DESC LIMIT 1');
  for (const principal of principalIds) {
    const found = userStmt.get({ principal }) as { user_id: number | null } | undefined;
    if (found) userOfPrincipal.set(principal, userKeyOf(found.user_id));
  }

  // One proposal per (user, interaction), the newest: a tab principal is a hash of a client-chosen session id, so
  // rotating sessions mints fresh principals, and the dedupe key of insertProposals includes judgeModel, so one agent
  // could otherwise stack proposals on one interaction and count each toward n. A principal whose user cannot be told
  // from the audit log counts per principal.
  const newest = new Map<string, (typeof proposals)[number]>();
  for (const p of proposals) {
    const who = p.principal_id ? (userOfPrincipal.get(p.principal_id) ?? `p:${p.principal_id}`) : 'p:';
    const key = `${who}|${p.interaction_id}`;
    const seen = newest.get(key);
    if (!seen || p.id > seen.id) newest.set(key, p);
  }
  proposals = [...newest.values()];

  // Every open_interaction call, keyed by the (masked) argument preview that audit stored, with who made it.
  const opened = new Map<string, Array<{ principal: string; user: string; at: number }>>();
  const openNames = ['open_interaction', ...retiredNamesFor('open_interaction')];
  for (const row of db.prepare(`SELECT principal_id, user_id, args_preview, ts FROM mcp_audit_log WHERE tool_name IN (${openNames.map((n) => `'${n}'`).join(', ')})`).all() as Array<{
    principal_id: string; user_id: number | null; args_preview: string | null; ts: string;
  }>) {
    const key = row.args_preview ?? '';
    const list = opened.get(key) ?? [];
    list.push({ principal: row.principal_id, user: userKeyOf(row.user_id), at: dbTime(row.ts) });
    opened.set(key, list);
  }
  let n = 0;
  let within = 0;
  for (const p of proposals) {
    const proposedAt = dbTime(p.annotated_at);
    const proposerUser = p.principal_id ? userOfPrincipal.get(p.principal_id) : undefined;
    const earlier = opened.get(previewArgs({ id: p.interaction_id })) ?? [];
    const seenByProposer = earlier.some(
      (o) => o.at <= proposedAt && (proposerUser === undefined || o.user === proposerUser || o.principal === p.principal_id)
    );
    if (seenByProposer) continue;
    n += 1;
    if (Math.abs(p.rating - p.human_rating) <= 1) within += 1;
  }
  return { n, within1Pct: n === 0 ? null : Math.round((within / n) * 100) };
}

// ── Readiness ────────────────────────────────────────────────────────────────

export interface TrainingReadiness {
  totalInteractions: number;
  /** Interactions with a current human label. */
  annotated: number;
  /** Runs an SFT export emits right now with the given options (one line each). */
  sftReady: number;
  /** Complete DPO pairs an export emits right now. */
  dpoPairs: number;
  judge: { proposed: number; accepted: number; rejected: number };
  agreement: AgreementResult;
  /** Runs and pairs the default export leaves out because their prompts carry a handoff block. */
  handoffExcluded: { sft: number; dpo: number };
}

const EMPTY_READINESS: TrainingReadiness = {
  totalInteractions: 0,
  annotated: 0,
  sftReady: 0,
  dpoPairs: 0,
  judge: { proposed: 0, accepted: 0, rejected: 0 },
  agreement: { n: 0, within1Pct: null },
  handoffExcluded: { sft: 0, dpo: 0 },
};

/** The numbers the Training tab shows, computed with the export's own qualifying rules. */
export function trainingReadiness(db: Database, opts: QualifyOptions & SftSelection = {}): TrainingReadiness {
  try {
    const count = (sql: string): number => (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
    const sft = qualifyingSftRuns(db, opts);
    const dpo = qualifyingDpoPairs(db, opts);
    const judge = { proposed: 0, accepted: 0, rejected: 0 };
    for (const r of db.prepare("SELECT status, COUNT(*) AS c FROM interaction_annotations WHERE source = 'judge' GROUP BY status").all() as Array<{ status: string; c: number }>) {
      if (r.status === 'proposed' || r.status === 'accepted' || r.status === 'rejected') judge[r.status] = r.c;
    }
    return {
      totalInteractions: count('SELECT COUNT(*) AS c FROM llm_interactions'),
      annotated: count('SELECT COUNT(DISTINCT interaction_id) AS c FROM v_current_human_annotations'),
      sftReady: sft.runIds.length,
      dpoPairs: dpo.pairs.length,
      judge,
      agreement: agreement(db),
      handoffExcluded: { sft: sft.handoffExcluded, dpo: dpo.handoffExcluded },
    };
  } catch {
    return EMPTY_READINESS;
  }
}
