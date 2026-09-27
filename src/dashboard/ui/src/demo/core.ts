/**
 * Speed Showdown — pure, DOM-free demo core (issue #92).
 *
 * Shared by the prebuilt hybrid chunk (which carries the browser-local arm)
 * and the React DemoTab. No window/document/fetch access, relative imports
 * only — unit-tested under bun and typechecked under both tsconfigs, exactly
 * like hybrid/core.ts. No zod here: the hybrid chunk stays small.
 */

export type CloudMode = 'live' | 'simulated';

/**
 * Mode/source labels — must stay string-identical to the server constants in
 * src/demo/showdown.ts (a test asserts equality so they cannot drift).
 */
export const LOCAL_BROWSER_LABEL = 'in your browser, on your GPU';
export const LOCAL_SERVER_LABEL = 'on this machine';
export const CLOUD_LIVE_LABEL = 'live call to OpenRouter';
export const CLOUD_SIMULATED_LABEL = 'simulated round-trip — no network';

/**
 * Honest contrast-case caption. jev-ultrafast is not a callable OpenRouter
 * model — this is caption copy, and ~178 ms is an external benchmark, never
 * rendered as this demo's own measurement. Always visible, real or simulated.
 */
export const CONTRAST_CAPTION =
  'Contrast case: jev-ultrafast sends every decision to a cloud-hosted Jev model over OpenRouter — ' +
  '~178 ms median request, fast, but not privacy-preserving. Wilson bets the other way: the decision ' +
  'happens where the data lives.';

// ── Decision parsing (shared by both arms' display path) ────────────────────

export interface ParsedDecision {
  id: number;
  category: string;
  confidence: number;
}

export type ParsedCategorization =
  | { ok: true; decision: ParsedDecision }
  | { ok: false; raw: string };

/**
 * Extract the first `{...}` JSON blob (fence-tolerant, junk-tolerant on both
 * sides) and lightly validate it as a categorization response. Confidence is
 * clamped to [0, 1]. Light validation only — failures render the raw output.
 */
export function parseCategorizationDecision(raw: string): ParsedCategorization {
  const blob = extractFirstJsonObject(raw);
  if (blob === null) return { ok: false, raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return { ok: false, raw };
  }

  const txns = (parsed as { transactions?: unknown } | null)?.transactions;
  if (!Array.isArray(txns) || txns.length === 0) return { ok: false, raw };

  const first = txns[0] as { id?: unknown; category?: unknown; confidence?: unknown };
  if (
    typeof first.id !== 'number' ||
    typeof first.category !== 'string' ||
    typeof first.confidence !== 'number'
  ) {
    return { ok: false, raw };
  }

  return {
    ok: true,
    decision: {
      id: first.id,
      category: first.category,
      confidence: Math.min(1, Math.max(0, first.confidence)),
    },
  };
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Try the widest candidate first (out to the last `}`), then shrink — so a
  // blob with trailing junk still parses and the first successful parse wins.
  let end = text.lastIndexOf('}');
  while (end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      end = text.lastIndexOf('}', end - 1);
    }
  }
  return null;
}

// ── Verdict line ────────────────────────────────────────────────────────────

export interface VerdictArmInput {
  decisionMs: number | null;
}

export interface VerdictCloudInput {
  mode: CloudMode;
  decisionMs: number | null;
}

/**
 * The verdict line. In simulated mode it never presents the measured local
 * number as network latency — the contrast caption carries that beat.
 */
export function buildVerdictLine(local: VerdictArmInput, cloud: VerdictCloudInput): string {
  if (local.decisionMs === null && cloud.decisionMs === null) {
    return 'Both arms failed — see their cards for the errors.';
  }
  if (local.decisionMs === null) {
    return 'Local arm failed — see its card for the error.';
  }
  if (cloud.decisionMs === null) {
    return 'Cloud arm failed — see its card for the error.';
  }

  if (cloud.mode === 'simulated') {
    return `Simulated cloud arm — no network call was made (local decision: ${Math.round(local.decisionMs)} ms).`;
  }

  const localMs = Math.max(0, Math.round(local.decisionMs));
  const cloudMs = Math.max(0, Math.round(cloud.decisionMs));
  const diff = cloudMs - localMs;
  if (diff === 0) return 'Dead heat';
  if (diff > 0) {
    return `Local won by ${diff} ms (${ratioText(cloudMs, localMs)}× faster)`;
  }
  return `Cloud won by ${-diff} ms (${ratioText(localMs, cloudMs)}× faster)`;
}

function ratioText(winnerMs: number, loserMs: number): string {
  if (loserMs <= 0) return '∞';
  const ratio = winnerMs / loserMs;
  if (!Number.isFinite(ratio)) return '∞';
  if (ratio >= 10) return ratio.toFixed(0);
  if (ratio >= 2) return ratio.toFixed(1);
  return ratio.toFixed(2);
}