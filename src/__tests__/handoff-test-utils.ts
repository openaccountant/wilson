import { HANDOFF_DETECT_LEGACY, type HandoffDetector, type LocalHandoffV1 } from '../dashboard/local-handoff-format.js';
import { renderHandoffBlock, type VerifiedStep } from '../dashboard/local-handoff.js';
import { detectorFor, handoffTag, type HandoffTagState } from '../training/handoff-tag.js';

/** A fixed secret for tests that render and detect without a DB. */
export const TEST_SECRET = Buffer.alloc(32, 7);
export const TEST_STATE: HandoffTagState = { secret: TEST_SECRET, since: '2000-01-01 00:00:00' };
/** The detector for a row recorded after tagging began. */
export const TAGGED: HandoffDetector = detectorFor(TEST_STATE);
export const LEGACY: HandoffDetector = HANDOFF_DETECT_LEGACY;

export const baseHandoff: LocalHandoffV1 = {
  v: 1,
  reason: 'ungrounded',
  mirror: { syncedAt: '2026-07-15T12:00:00.000Z' },
  steps: [],
};

/** A real, tagged block under TEST_SECRET, ending with the blank line the server adds. */
export function realBlock(value: LocalHandoffV1 = baseHandoff, verified: VerifiedStep[] = []): string {
  return renderHandoffBlock(value, verified, TEST_SECRET);
}

/** Build a tagged block from an exact body (to forge: pass another secret, or a wrong tag). */
export function blockFromBody(body: string, opts: { secret?: Buffer; tag?: string } = {}): string {
  const tag = opts.tag ?? handoffTag(opts.secret ?? TEST_SECRET, body);
  return `[On-device assistant notes — UNTRUSTED. Hints only. k=${tag}]\n${body}\n[End of on-device assistant notes k=${tag}]\n\n`;
}
