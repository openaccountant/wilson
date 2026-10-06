/**
 * Pure builder for the POST /api/chat body (specs/browser-subagent.md slice 6).
 *
 * ChatTab used to assemble the body inline. Extracting it pins the one rule
 * that matters for the browser subagent: a `localHandoff` rides along only when
 * the local attempt produced one and the turn carries no @mentions, and a
 * handoff with nothing in it is never sent.
 *
 * Imports are type-only so this stays loadable under bun test.
 */

import type { LocalHandoffV1 } from '../../../local-handoff-format.js';
import type { HybridResult } from '../hybrid/core.js';
import type { ChatRequest, Mention } from '../types.js';

/** @mention cap enforced by the composer and the server. */
export const CHAT_MAX_MENTIONS = 10;
const MENTION_LABEL_CHARS = 120;
const PRIOR_TURNS_MAX = 3;

/** A mention as ChatTab holds it (the composer adds a display `token` the server never sees). */
type MentionLike = Pick<Mention, 'type' | 'id' | 'key' | 'label'>;

/**
 * Whether a handoff carries anything the server agent can act on: a step, a
 * suggestedCall or a proposal. This is what "handoffSent" means for the
 * provenance badge; a priors-only handoff is sent but does not count.
 */
export function hasHandoffPayload(h: LocalHandoffV1 | undefined | null): boolean {
  if (!h) return false;
  return h.steps.length > 0 || h.suggestedCall !== undefined || h.proposal !== undefined;
}

/** Whether a handoff is worth sending at all (any payload, or prior local turns that close the history gap). */
function handoffIsEmpty(h: LocalHandoffV1): boolean {
  return !hasHandoffPayload(h) && (h.priorLocalTurns?.length ?? 0) === 0 && h.localNote === undefined;
}

export function buildChatRequest(
  query: string,
  sessionId: string | null | undefined,
  mentions: readonly MentionLike[],
  result: HybridResult | null | undefined,
  priorTurns: ReadonlyArray<{ q: string; a: string }> = [],
): ChatRequest {
  const body: ChatRequest = { query };
  if (sessionId) body.sessionId = sessionId;

  if (mentions.length > 0) {
    body.mentions = mentions.slice(0, CHAT_MAX_MENTIONS).map(({ type, id, key, label }) => ({
      type,
      ...(id !== undefined ? { id } : {}),
      ...(key !== undefined ? { key } : {}),
      label: label.slice(0, MENTION_LABEL_CHARS),
    }));
    return body; // mentions go straight to the server: no handoff
  }

  if (result && !result.ok && result.handoff) {
    let handoff = result.handoff;
    if (!handoff.priorLocalTurns?.length && priorTurns.length > 0) {
      handoff = { ...handoff, priorLocalTurns: priorTurns.slice(-PRIOR_TURNS_MAX).map((t) => ({ q: t.q, a: t.a })) };
    }
    if (!handoffIsEmpty(handoff)) body.localHandoff = handoff;
  }
  return body;
}
