/**
 * Pure rules behind the Training tab's judge surfaces, import-free and DOM-free so the React dashboard can bundle
 * it (alias `@judge-ui`) and root tests can pin it without a browser.
 *
 *  - BLIND RULE (carried over from P3, binding): when the Training detail panel is opened by an AGENT
 *    (`open_interaction`), the human's rating, preference, notes and pair id stay out of the panel (and out of the
 *    page's state, not just hidden by CSS) until a person interacts with it. An agent that opens a panel must not read
 *    the human label it is about to judge (threat T37). A DOM-reading agent can still see the list's rating column;
 *    that residual is threat T34 and the agreement metric is labelled "on n blind proposals" for it.
 *  - the queue's text rules (an agent-written rationale is plain text with links removed), bulk-accept limits, the
 *    agreement label, and the training export's opt-in choices.
 */

// ── Blind rule ───────────────────────────────────────────────────────────────

export const BLIND_NOTICE = 'Human labels are hidden: an agent opened this panel. Click or type here to reveal them.';

export interface BlindState {
  /** `open_interaction` asked for this panel (not a person's click on a row). */
  openedByAgent: boolean;
  /** A person has interacted with the panel since it opened. */
  humanInteracted: boolean;
}

export const INITIAL_BLIND_STATE: BlindState = { openedByAgent: false, humanInteracted: false };

export type BlindEvent =
  | { type: 'open'; byAgent: boolean }
  /** A pointer or key event inside the panel. Only a trusted one (`event.isTrusted`) counts. */
  | { type: 'interact'; isTrusted: boolean }
  | { type: 'close' };

export function nextBlindState(state: BlindState, event: BlindEvent): BlindState {
  switch (event.type) {
    case 'open':
      // A fresh panel: nobody has interacted with it yet, whoever opened it.
      return { openedByAgent: event.byAgent, humanInteracted: false };
    case 'interact':
      return event.isTrusted && state.openedByAgent ? { ...state, humanInteracted: true } : state;
    case 'close':
      return INITIAL_BLIND_STATE;
  }
}

/** True while the human's labels must not be fetched into, or rendered by, the panel. */
export function labelsHidden(state: BlindState): boolean {
  return state.openedByAgent && !state.humanInteracted;
}

/** The parts of an interaction detail that carry a human label. Everything here is withheld while labels are hidden. */
export interface DetailWithLabels {
  annotations?: unknown[];
  annotation?: unknown;
  history?: unknown[];
}

/** A copy of a detail with no human label in it: no current annotation, no versions, nothing that says a human rated it. */
export function withoutHumanLabels<T extends DetailWithLabels>(detail: T): T {
  return { ...detail, annotations: [], annotation: null, history: [] };
}

// ── The human's label form ───────────────────────────────────────────────────

/** The current human version as the detail returns it. `created_via` says whether an agent had live access then. */
export interface CurrentLabel {
  rating: number | null;
  preference: string | null;
  pair_id: string | null;
  notes: string | null;
  created_via?: string;
}

export interface LabelForm {
  rating: number;
  preference: string;
  pairId: string;
  notes: string;
}

export const AGENT_LABEL_NOTICE =
  'This rating was saved while an agent had access (or within 2 hours of it), so the default export leaves it out. Rate it again yourself once 2 hours have passed with no agent access to make it yours.';

export function isAgentPresentLabel(label: CurrentLabel | null | undefined): boolean {
  return label?.created_via === 'dashboard_agent_present';
}

/**
 * What the form starts with. A label written while an agent was present is NOT prefilled as the person's own (rating,
 * preference and pair id start empty; notes are kept): the person has to rate it again on purpose, because the server
 * keeps such a label flagged until they do.
 */
export function labelPrefill(label: CurrentLabel | null | undefined): LabelForm {
  if (!label) return { rating: 0, preference: '', pairId: '', notes: '' };
  const agent = isAgentPresentLabel(label);
  return {
    rating: agent ? 0 : (label.rating ?? 0),
    preference: agent ? '' : (label.preference ?? ''),
    pairId: agent ? '' : (label.pair_id ?? ''),
    notes: label.notes ?? '',
  };
}

/**
 * The body of a Save: only what the person filled in. When the stored label is an agent's and the person re-rated,
 * preference and pair id are sent too (a value, or null to clear), so the whole label on screen becomes theirs.
 * Without a new rating nothing of the agent's label is adopted and the server keeps it flagged.
 */
export function annotateBody(form: LabelForm, current: CurrentLabel | null | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (form.rating > 0) body.rating = form.rating;
  if (form.preference) body.preference = form.preference;
  if (form.pairId) body.pairId = form.pairId;
  if (form.notes) body.notes = form.notes;
  if (isAgentPresentLabel(current) && form.rating > 0) {
    body.preference = form.preference || null;
    body.pairId = form.pairId || null;
  }
  return body;
}

// ── Judge queue text and limits ──────────────────────────────────────────────

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const DOMAIN_PATH_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi;

/** An agent-written rationale as shown to a person: plain text, every link replaced with `[link]`. */
export function replaceUrls(text: string): string {
  return text.replace(URL_RE, '[link]').replace(DOMAIN_PATH_RE, '[link]');
}

export interface AgreementInfo {
  n: number;
  within1Pct: number | null;
}

export function agreementLabel(agreement: AgreementInfo | null | undefined): string {
  if (!agreement || agreement.n === 0 || agreement.within1Pct === null) return 'agreement: no blind proposals yet';
  return `agreement ${agreement.within1Pct}% on n=${agreement.n} blind proposals (within ±1)`;
}

export function queueHeader(proposals: number, agreement: AgreementInfo | null | undefined): string {
  return `${proposals} proposal${proposals === 1 ? '' : 's'} · ${agreementLabel(agreement)}`;
}

/** The queue has two views: what waits for review, and what a person already accepted (where it can be revoked). */
export type QueueView = 'proposed' | 'accepted';

/** The list URL for a view. Accepted rows can sit behind newer proposals, so this reads judgements, not interactions. */
export function queueUrl(view: QueueView, cursor?: string): string {
  return `/api/judgements?status=${view}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function acceptedHeader(accepted: number): string {
  return `${accepted} accepted judgement${accepted === 1 ? '' : 's'} · exported only when you opt in · revoke to take one back`;
}

/** The queue marks a judgement whose rating is two or more stars from the human's (red border). */
export function gapIsLarge(judgeRating: number | null, humanRating: number | null | undefined): boolean {
  return judgeRating !== null && humanRating !== null && humanRating !== undefined && Math.abs(judgeRating - humanRating) >= 2;
}

/** Bulk Accept takes at most this many rows, and only rows the person has expanded in this session. */
export const BULK_ACCEPT_MAX = 10;

export function bulkEligible(selected: readonly number[], expanded: ReadonlySet<number>): number[] {
  return selected.filter((id) => expanded.has(id)).slice(0, BULK_ACCEPT_MAX);
}

export function bulkConfirmText(n: number): string {
  return `Accept ${n} judgement${n === 1 ? '' : 's'}? They'll be eligible for export only when you opt in.`;
}

/** Accept and the export opt-ins enable after this long and need a real (trusted) pointer or key event. Mirrors the approval card. */
export const JUDGE_ENABLE_AFTER_MS = 800;
/** Bulk Accept, and a download with any opt-in checked, must be held this long. Mirrors the approval card. */
export const JUDGE_HOLD_MS = 600;

// ── Training export options ──────────────────────────────────────────────────

export interface ExportChoices {
  includeJudge: boolean;
  includeAgentPresent: boolean;
  includeHandoff: boolean;
}

/** Every opt-in starts off, and goes back to off after every export. */
export const DEFAULT_EXPORT_CHOICES: ExportChoices = { includeJudge: false, includeAgentPresent: false, includeHandoff: false };

export function exportPath(format: 'sft' | 'dpo', choices: ExportChoices): string {
  const query = (Object.keys(choices) as Array<keyof ExportChoices>).filter((k) => choices[k]).map((k) => `${k}=true`);
  return `/api/export/training/${format}${query.length ? `?${query.join('&')}` : ''}`;
}

export function exportFileName(format: 'sft' | 'dpo', choices: ExportChoices): string {
  return `wilson-${format}${choices.includeJudge ? '-with-judge' : ''}.jsonl`;
}

/** A download with any opt-in checked needs the press-and-hold. */
export function exportNeedsHold(choices: ExportChoices): boolean {
  return choices.includeJudge || choices.includeAgentPresent || choices.includeHandoff;
}
